// Live activity stream: normalizes upstream SSE message.updated events into
// structured activity events the wrapper can consume in real time. Subscribes
// to the global hub (same pattern as message-queue/runtime.js) and broadcasts
// via broadcastGlobalUiEvent.
//
// Rate-limiting: tool-call events are coalesced to ~1 per 2s per session.
// File-edit and plan-step events always emit immediately.

const COALESCE_WINDOW_MS = 2_000;
const TEXT_PART_CHAR_LIMIT = 200;

const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
const asNonEmptyString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');
const asList = (value) => (Array.isArray(value) ? value : []);
const asCount = (value) => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : null);

const extractSessionStatus = (payload) => {
  if (payload.type !== 'session.status') return null;
  const properties = asRecord(payload.properties) ?? {};
  const status = asRecord(properties.status) ?? {};
  const info = asRecord(properties.info) ?? {};
  const sessionId = asNonEmptyString(properties.sessionID);
  const type = asNonEmptyString(status.type) || asNonEmptyString(info.type);
  if (!sessionId || !type) return null;
  return { sessionId, type };
};

const extractMessageUpdate = (payload) => {
  if (payload.type !== 'message.updated') return null;
  const properties = asRecord(payload.properties) ?? {};
  const info = asRecord(properties.info);
  if (!info) return null;
  const sessionId = asNonEmptyString(info.sessionID);
  if (!sessionId) return null;
  return { sessionId, info };
};

const isReadLikeTool = (toolName) => {
  const name = String(toolName ?? '').toLowerCase();
  return name === 'read' || name === 'grep' || name === 'search' || name === 'glob'
    || name === 'list' || name === 'ls';
};

const isFileEditTool = (toolName) => {
  const name = String(toolName ?? '').toLowerCase();
  return name === 'edit' || name === 'write' || name === 'bash';
};

const normalizeToolPart = (part) => {
  const toolName = asNonEmptyString(part?.tool) || asNonEmptyString(part?.name) || '';
  if (!toolName) return null;
  const input = asRecord(part?.input) ?? asRecord(part?.parameters) ?? {};
  const filePath = asNonEmptyString(input?.filePath) || asNonEmptyString(input?.path) || '';
  const command = asNonEmptyString(input?.command) || '';
  const detail = filePath
    ? `${toolName} ${filePath}`
    : (command ? `${toolName} ${command.slice(0, 80)}` : toolName);
  return { tool: toolName, file: filePath, detail };
};

const normalizeTextPart = (part) => {
  const text = typeof part?.text === 'string' ? part.text.trim() : '';
  if (!text) return null;
  return { detail: text.slice(0, TEXT_PART_CHAR_LIMIT) };
};

const normalizeParts = (parts) => {
  const activities = [];
  for (const part of asList(parts)) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'tool-invocation' || part.type === 'tool') {
      const normalized = normalizeToolPart(part);
      if (normalized) {
        const kind = isFileEditTool(normalized.tool) ? 'file-edit'
          : isReadLikeTool(normalized.tool) ? 'tool-call'
          : 'tool-call';
        activities.push({ kind, ...normalized });
      }
    } else if (part.type === 'text') {
      const normalized = normalizeTextPart(part);
      if (normalized) {
        activities.push({ kind: 'text-part', tool: '', file: '', ...normalized });
      }
    }
  }
  return activities;
};

const extractCardID = (info) => {
  const metadata = asRecord(info?.metadata);
  const namespace = asRecord(metadata?.openchamber);
  return asNonEmptyString(namespace?.cardID) || '';
};

const extractTokens = (info) => {
  const tokens = asRecord(info?.tokens);
  if (!tokens) return null;
  const input = asCount(tokens.input) ?? 0;
  const output = asCount(tokens.output) ?? 0;
  const cachedRead = asCount(tokens.cache?.read) ?? 0;
  return { input, output, cachedRead };
};

export function createAgentActivityRuntime({
  globalEventHub,
  broadcastGlobalUiEvent,
  coalesceWindowMs = COALESCE_WINDOW_MS,
  now = Date.now,
}) {
  let stopped = false;
  /** sessionId → timestamp of last emitted tool-call event */
  const lastToolEmit = new Map();

  const processPayload = (payload) => {
    if (stopped || !payload || typeof payload !== 'object') return;

    const messageUpdate = extractMessageUpdate(payload);
    if (messageUpdate) {
      processMessageUpdate(messageUpdate);
      return;
    }

    const status = extractSessionStatus(payload);
    if (status && status.type === 'idle') {
      const cardID = ''; // cardID resolved from metadata if available
      broadcastGlobalUiEvent?.({
        type: 'openchamber:session-completed',
        properties: {
          sessionID: status.sessionId,
          cardID,
          ts: now(),
        },
      });
    }
  };

  const processMessageUpdate = ({ sessionId, info }) => {
    const parts = asList(info?.parts);
    const activities = normalizeParts(parts);
    if (activities.length === 0) return;

    const cardID = extractCardID(info);
    const tokens = extractTokens(info);

    for (const activity of activities) {
      const isToolCall = activity.kind === 'tool-call';
      const lastEmit = lastToolEmit.get(sessionId);
      if (isToolCall && lastEmit !== undefined && (now() - lastEmit) < coalesceWindowMs) {
        continue;
      }
      if (isToolCall) {
        lastToolEmit.set(sessionId, now());
      }

      broadcastGlobalUiEvent?.({
        type: 'openchamber:agent-activity',
        properties: {
          sessionID: sessionId,
          cardID,
          ts: now(),
          kind: activity.kind,
          tool: activity.tool,
          file: activity.file,
          detail: activity.detail,
          ...(tokens ? { tokens } : {}),
        },
      });
    }
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
    lastToolEmit.clear();
  };

  return { processPayload, start, stop };
}

export function registerAgentActivityRoutes(app, { getOpenChamberEventClients, writeSseEvent }) {
  app.get('/api/openchamber/agent-activity', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const clients = getOpenChamberEventClients();
    clients.add(res);

    try {
      writeSseEvent(res, {
        type: 'openchamber:agent-activity-stream-ready',
        properties: { connectedAt: Date.now() },
      });
    } catch {}

    const heartbeat = setInterval(() => {
      try {
        writeSseEvent(res, {
          type: 'openchamber:heartbeat',
          properties: { timestamp: Date.now() },
        });
      } catch {
        clearInterval(heartbeat);
        clients.delete(res);
      }
    }, 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
  });
}
