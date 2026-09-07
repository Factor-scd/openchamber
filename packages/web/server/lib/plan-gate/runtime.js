// Plan-first gate: the agent must emit its implementation plan and get approval
// before touching files. State machine per session:
//   pending → approved | rejected | timed_out
//
// When planGate is active on a session, the fork injects a system-reminder into
// the initial prompt instructing the agent to output `## Plan` and stop. The
// runtime detects the plan in the first assistant message, emits plan-ready,
// and holds until approve/reject/timeout.

import express from 'express';
import { GOAL_OBJECTIVE_CHAR_LIMIT } from '../session-goal/objectives.js';

const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
const asNonEmptyString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');
const asList = (value) => (Array.isArray(value) ? value : []);

const FETCH_TIMEOUT_MS = 15_000;
const LANDED_TIMEOUT_MS = 5_000;
const LANDED_POLL_MS = 150;
const DEFAULT_PLAN_GATE_TIMEOUT_MS = 5 * 60 * 1000;

const PLAN_MARKER = '## Plan';

const extractMessageUpdate = (payload) => {
  if (payload.type !== 'message.updated') return null;
  const properties = asRecord(payload.properties) ?? {};
  const info = asRecord(properties.info);
  if (!info) return null;
  const sessionId = asNonEmptyString(info.sessionID);
  if (!sessionId) return null;
  return { sessionId, info };
};

const extractAssistantText = (info) => {
  const parts = asList(info?.parts);
  return parts
    .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .slice(0, GOAL_OBJECTIVE_CHAR_LIMIT);
};

const extractPlanFromText = (text) => {
  const idx = text.indexOf(PLAN_MARKER);
  if (idx < 0) return null;
  return text.slice(idx).trim();
};

const extractCardID = (info) => {
  const metadata = asRecord(info?.metadata);
  const namespace = asRecord(metadata?.openchamber);
  return asNonEmptyString(namespace?.cardID) || '';
};

export function createPlanGateRuntime({
  globalEventHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  broadcastGlobalUiEvent,
  fetchImpl = fetch,
  planGateTimeoutMs = DEFAULT_PLAN_GATE_TIMEOUT_MS,
}) {
  /** sessionId → { state, plan, directory, cardID, timeout } */
  const sessions = new Map();
  let stopped = false;

  const openCodeFetch = async (fetchPath, { directory, method = 'GET', body, query } = {}) => {
    const base = buildOpenCodeUrl(fetchPath, '');
    const params = new URLSearchParams(query || {});
    if (directory) params.set('directory', directory);
    const search = params.toString();
    const url = search ? `${base}?${search}` : base;
    const response = await fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...getOpenCodeAuthHeaders(),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`OpenCode ${method} ${fetchPath} failed with ${response.status}`);
    }
    return response.json().catch(() => null);
  };

  const latestUserMessageID = async (sessionId, directory) => {
    const messages = asList(await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/message`, {
      directory,
      query: { limit: '5' },
    }).catch(() => null));
    let latest = null;
    for (const msg of messages) {
      const info = asRecord(msg?.info);
      if (info?.role !== 'user') continue;
      if (!latest || (info.time?.created || 0) >= (latest.time?.created || 0)) latest = info;
    }
    return asNonEmptyString(latest?.id) || null;
  };

  const waitForPromptLanded = async (sessionId, directory, baselineUserMessageID) => {
    const deadline = Date.now() + LANDED_TIMEOUT_MS;
    for (;;) {
      const latest = await latestUserMessageID(sessionId, directory);
      if (!latest) return true;
      if (latest !== baselineUserMessageID) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, LANDED_POLL_MS));
    }
  };

  const clearSessionTimeout = (sessionId) => {
    const session = sessions.get(sessionId);
    if (session?.timeout) {
      clearTimeout(session.timeout);
      session.timeout = null;
    }
  };

  const armTimeout = (sessionId) => {
    clearSessionTimeout(sessionId);
    const session = sessions.get(sessionId);
    if (!session || session.state !== 'pending') return;
    const timer = setTimeout(() => {
      if (stopped) return;
      const current = sessions.get(sessionId);
      if (!current || current.state !== 'pending') return;
      current.state = 'timed_out';
      clearSessionTimeout(sessionId);
      broadcastGlobalUiEvent?.({
        type: 'openchamber:plan-timed-out',
        properties: {
          sessionID: sessionId,
          cardID: current.cardID || '',
          ts: Date.now(),
        },
      });
      // Auto-approve on timeout
      approvePlan(sessionId);
    }, planGateTimeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();
    session.timeout = timer;
  };

  const approvePlan = async (sessionId, feedback = '') => {
    const session = sessions.get(sessionId);
    if (!session || session.state !== 'pending') return null;
    clearSessionTimeout(sessionId);
    session.state = 'approved';
    const directory = session.directory;
    const cardID = session.cardID;

    broadcastGlobalUiEvent?.({
      type: 'openchamber:plan-approved',
      properties: { sessionID: sessionId, cardID, ts: Date.now() },
    });

    try {
      const promptText = feedback
        ? `Plan approved. Additional context: ${feedback}\n\nProceed with implementation.`
        : 'Plan approved. Proceed with implementation.';
      const baseline = await latestUserMessageID(sessionId, directory);
      await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        directory,
        method: 'POST',
        body: {
          parts: [{ type: 'text', text: promptText, synthetic: true }],
        },
      });
      // Fire-and-forget: the prompt was accepted by OpenCode. Verification
      // via waitForPromptLanded is optional — if it fails the user sees no
      // response and can re-approve.
      waitForPromptLanded(sessionId, directory, baseline).catch(() => {});
    } catch (error) {
      console.warn('[plan-gate] approve delivery failed:', error?.message || error);
    }

    sessions.delete(sessionId);
    return { state: 'approved' };
  };

  const rejectPlan = async (sessionId, feedback) => {
    const session = sessions.get(sessionId);
    if (!session || session.state !== 'pending') return null;
    clearSessionTimeout(sessionId);
    session.state = 'rejected';
    const directory = session.directory;
    const cardID = session.cardID;

    broadcastGlobalUiEvent?.({
      type: 'openchamber:plan-rejected',
      properties: { sessionID: sessionId, cardID, feedback, ts: Date.now() },
    });

    try {
      const promptText = `Plan rejected. Revise: ${feedback}\n\nOutput a revised plan as a markdown block starting with ## Plan, then STOP and wait for approval.`;
      const baseline = await latestUserMessageID(sessionId, directory);
      await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        directory,
        method: 'POST',
        body: {
          parts: [{ type: 'text', text: promptText, synthetic: true }],
        },
      });
      waitForPromptLanded(sessionId, directory, baseline).catch(() => {});
      // Reset to pending so the revised plan can be detected
      session.state = 'pending';
      session.plan = null;
      armTimeout(sessionId);
    } catch (error) {
      console.warn('[plan-gate] reject delivery failed:', error?.message || error);
    }

    return { state: 'rejected' };
  };

  const getStatus = (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) return { state: 'none', plan: null, ts: null };
    return {
      state: session.state,
      plan: session.plan,
      cardID: session.cardID || '',
      ts: session.ts,
    };
  };

  const activate = (sessionId, directory, cardID = '') => {
    if (sessions.has(sessionId)) {
      clearSessionTimeout(sessionId);
    }
    sessions.set(sessionId, {
      state: 'pending',
      plan: null,
      directory,
      cardID,
      ts: Date.now(),
      timeout: null,
    });
    armTimeout(sessionId);
  };

  const processPayload = (payload) => {
    if (stopped) return;
    const messageUpdate = extractMessageUpdate(payload);
    if (!messageUpdate) return;

    const { sessionId, info } = messageUpdate;
    const session = sessions.get(sessionId);
    if (!session || session.state !== 'pending') return;
    if (info.role !== 'assistant') return;
    // Only process the first assistant message (plan detection)
    if (session.plan !== null) return;

    const text = extractAssistantText(info);
    const plan = extractPlanFromText(text);
    if (!plan) return;

    session.plan = plan;
    clearSessionTimeout(sessionId);

    const cardID = session.cardID || extractCardID(info);
    if (cardID && !session.cardID) session.cardID = cardID;

    broadcastGlobalUiEvent?.({
      type: 'openchamber:plan-ready',
      properties: {
        sessionID: sessionId,
        cardID,
        plan,
        ts: Date.now(),
      },
    });
  };

  const start = () => {
    const unsubscribe = globalEventHub.subscribeEvent((event) => {
      const raw = event?.payload;
      const payload = raw?.payload && typeof raw.payload === 'object' ? raw.payload : raw;
      processPayload(payload);
    });
    return () => { unsubscribe(); };
  };

  const stop = () => {
    stopped = true;
    for (const session of sessions.values()) {
      clearSessionTimeout(session.id);
    }
    sessions.clear();
  };

  return { approvePlan, rejectPlan, getStatus, activate, processPayload, start, stop };
}

export function registerPlanGateRoutes(app, runtime) {
  const respondError = (res, error, fallback) => {
    const status = error instanceof TypeError ? 400 : (Number.isFinite(error?.status) ? error.status : 500);
    res.status(status).json({ error: error?.message ?? fallback });
  };

  app.post('/api/openchamber/session/:sessionID/plan/approve', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const sessionId = asNonEmptyString(req.params?.sessionID);
      if (!sessionId) return res.status(400).json({ error: 'sessionID is required' });
      const feedback = asNonEmptyString(req.body?.feedback) || '';
      const result = await runtime.approvePlan(sessionId, feedback);
      if (!result) return res.status(404).json({ error: 'No pending plan for this session' });
      return res.json(result);
    } catch (error) {
      return respondError(res, error, 'Failed to approve plan');
    }
  });

  app.post('/api/openchamber/session/:sessionID/plan/reject', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const sessionId = asNonEmptyString(req.params?.sessionID);
      const feedback = asNonEmptyString(req.body?.feedback);
      if (!sessionId) return res.status(400).json({ error: 'sessionID is required' });
      if (!feedback) return res.status(400).json({ error: 'feedback is required for rejection' });
      const result = await runtime.rejectPlan(sessionId, feedback);
      if (!result) return res.status(404).json({ error: 'No pending plan for this session' });
      return res.json(result);
    } catch (error) {
      return respondError(res, error, 'Failed to reject plan');
    }
  });

  app.get('/api/openchamber/session/:sessionID/plan/status', (req, res) => {
    try {
      const sessionId = asNonEmptyString(req.params?.sessionID);
      if (!sessionId) return res.status(400).json({ error: 'sessionID is required' });
      return res.json(runtime.getStatus(sessionId));
    } catch (error) {
      return respondError(res, error, 'Failed to get plan status');
    }
  });
}
