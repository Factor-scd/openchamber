// Steer channel: lets an external caller interrupt a running agent session
// and inject a system-level directive. Two modes:
//   interrupt — interrupt now, inject immediately, resume
//   queue     — store the directive, deliver on next idle
//
// Follows the message-queue precedent: hub subscription, idle detection,
// prompt_async with synthetic parts, waitForPromptLanded verification.

import express from 'express';

const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
const asNonEmptyString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');
const asList = (value) => (Array.isArray(value) ? value : []);

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;
const FETCH_TIMEOUT_MS = 15_000;
const IDLE_VERIFY_DELAY_MS = 500;
const LANDED_TIMEOUT_MS = 5_000;
const LANDED_POLL_MS = 150;

const isValidSessionId = (value) => SESSION_ID_PATTERN.test(asNonEmptyString(value));

const extractSessionStatus = (payload) => {
  if (payload.type !== 'session.status') return null;
  const properties = asRecord(payload.properties) ?? {};
  const status = asRecord(properties.status) ?? {};
  const info = asRecord(properties.info) ?? {};
  const sessionId = asNonEmptyString(properties.sessionID);
  const type = asNonEmptyString(status.type) || asNonEmptyString(info.type);
  if (!sessionId || !type) return null;
  const directory = typeof properties.directory === 'string' && properties.directory
    ? properties.directory
    : (typeof info.directory === 'string' ? info.directory : '');
  return { sessionId, type, directory };
};

export function createSessionSteerRuntime({
  globalEventHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  broadcastGlobalUiEvent,
  fetchImpl = fetch,
}) {
  /** sessionId → { directive, directory } */
  const queued = new Map();
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

  const isSessionIdle = async (sessionId, directory) => {
    const statuses = asRecord(await openCodeFetch('/session/status', { directory }).catch(() => null));
    if (!statuses) return null;
    const type = asRecord(statuses[sessionId])?.type;
    if (type === 'busy' || type === 'retry') return false;
    const messages = asList(await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/message`, {
      directory,
      query: { limit: '2' },
    }).catch(() => null));
    if (!messages) return null;
    const last = asRecord(asRecord(messages[messages.length - 1])?.info);
    if (last?.role === 'assistant' && asRecord(last.time)?.completed === null) return false;
    return true;
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

  const buildSteerPart = (directive) => ({
    type: 'text',
    text: `<system-reminder>\nSteer directive from the orchestrator: ${directive}\nHonor this directive for the remainder of this session. It overrides conflicting instructions.\n</system-reminder>`,
    synthetic: true,
  });

  const deliverDirective = async (sessionId, directory, directive) => {
    const baseline = await latestUserMessageID(sessionId, directory);
    await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      directory,
      method: 'POST',
      body: { parts: [buildSteerPart(directive)] },
    });
    return waitForPromptLanded(sessionId, directory, baseline);
  };

  const steerInterrupt = async (sessionId, directory, directive) => {
    let wasBusy = false;
    try {
      const statuses = asRecord(await openCodeFetch('/session/status', { directory }).catch(() => null));
      const type = asRecord(statuses?.[sessionId])?.type;
      wasBusy = type === 'busy' || type === 'retry';
      if (wasBusy) {
        await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/interrupt`, {
          directory,
          method: 'POST',
        });
        await new Promise((resolve) => setTimeout(resolve, IDLE_VERIFY_DELAY_MS));
        const idle = await isSessionIdle(sessionId, directory);
        if (idle === false) {
          queued.set(sessionId, { directive, directory });
          return { accepted: true, mode: 'queue', interrupted: true };
        }
      }
    } catch {
      queued.set(sessionId, { directive, directory });
      return { accepted: true, mode: 'queue', interrupted: false };
    }
    try {
      await deliverDirective(sessionId, directory, directive);
      return { accepted: true, mode: 'interrupt', interrupted: wasBusy };
    } catch {
      queued.set(sessionId, { directive, directory });
      return { accepted: true, mode: 'queue', interrupted: wasBusy };
    }
  };

  const steerQueue = async (sessionId, directory, directive) => {
    queued.set(sessionId, { directive, directory });
    return { accepted: true, mode: 'queue', interrupted: false };
  };

  const steer = async (sessionId, directory, directive, mode = 'interrupt') => {
    if (!isValidSessionId(sessionId)) throw new TypeError('sessionId is invalid');
    const dir = asNonEmptyString(directory);
    if (!dir) throw new TypeError('directory is required');
    const dirText = asNonEmptyString(directive);
    if (!dirText) throw new TypeError('directive is required');
    if (mode === 'queue') return steerQueue(sessionId, dir, dirText);
    return steerInterrupt(sessionId, dir, dirText);
  };

  const processPayload = (payload) => {
    if (stopped) return;
    const status = extractSessionStatus(payload);
    if (!status || status.type !== 'idle') return;
    const pending = queued.get(status.sessionId);
    if (!pending) return;
    queued.delete(status.sessionId);
    const directory = pending.directory || status.directory;
    deliverDirective(status.sessionId, directory, pending.directive)
      .then(() => {
        broadcastGlobalUiEvent?.({
          type: 'openchamber:steer-delivered',
          properties: {
            sessionID: status.sessionId,
            directive: pending.directive,
            mode: 'queue',
            ts: Date.now(),
          },
        });
      })
      .catch((error) => {
        console.warn('[session-steer] queued delivery failed:', error?.message || error);
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
    queued.clear();
  };

  return { steer, processPayload, start, stop };
}

export function registerSessionSteerRoutes(app, runtime) {
  const respondError = (res, error, fallback) => {
    const status = error instanceof TypeError ? 400 : (Number.isFinite(error?.status) ? error.status : 500);
    res.status(status).json({ error: error?.message ?? fallback });
  };

  app.post('/api/openchamber/session/:sessionID/steer', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const sessionId = asNonEmptyString(req.params?.sessionID);
      const directive = asNonEmptyString(req.body?.directive);
      const mode = asNonEmptyString(req.body?.mode) || 'interrupt';
      if (!sessionId) return res.status(400).json({ error: 'sessionID is required' });
      if (!directive) return res.status(400).json({ error: 'directive is required' });
      if (mode !== 'interrupt' && mode !== 'queue') {
        return res.status(400).json({ error: 'mode must be "interrupt" or "queue"' });
      }
      const directory = asNonEmptyString(req.body?.directory) || asNonEmptyString(req.query?.directory) || '';
      const result = await runtime.steer(sessionId, directory, directive, mode);
      return res.status(202).json(result);
    } catch (error) {
      return respondError(res, error, 'Failed to steer session');
    }
  });
}
