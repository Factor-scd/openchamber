import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentActivityRuntime } from './runtime.js';

const SESSION = 'ses_activity_test_1';

const makeEvent = (type, properties = {}) => ({
  payload: { type, properties },
});

afterEach(() => {
  vi.useRealTimers();
});

const createRuntime = ({ coalesceWindowMs = 0, now = Date.now } = {}) => {
  const broadcasts = [];
  const options = {
    globalEventHub: {
      subscribeEvent() { return () => {}; },
    },
    broadcastGlobalUiEvent: (event) => broadcasts.push(event),
    coalesceWindowMs,
    now,
  };
  const runtime = createAgentActivityRuntime(options);
  return {
    runtime,
    broadcasts,
  };
};

describe('agent-activity runtime', () => {
  it('emits agent-activity for tool-call parts', () => {
    const { runtime, broadcasts } = createRuntime();

    runtime.processPayload({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: SESSION,
          role: 'assistant',
          parts: [
            { type: 'tool-invocation', tool: 'read', input: { filePath: 'src/foo.ts' } },
          ],
        },
      },
    });

    const activityEvents = broadcasts.filter((e) => e.type === 'openchamber:agent-activity');
    expect(activityEvents.length).toBe(1);
    expect(activityEvents[0].properties.kind).toBe('tool-call');
    expect(activityEvents[0].properties.tool).toBe('read');
    expect(activityEvents[0].properties.file).toBe('src/foo.ts');
    expect(activityEvents[0].properties.sessionID).toBe(SESSION);
  });

  it('emits file-edit kind for edit/write tools', () => {
    const { runtime, broadcasts } = createRuntime();

    runtime.processPayload({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: SESSION,
          role: 'assistant',
          parts: [
            { type: 'tool-invocation', tool: 'edit', input: { filePath: 'src/bar.ts' } },
          ],
        },
      },
    });

    const activityEvents = broadcasts.filter((e) => e.type === 'openchamber:agent-activity');
    expect(activityEvents.length).toBe(1);
    expect(activityEvents[0].properties.kind).toBe('file-edit');
    expect(activityEvents[0].properties.tool).toBe('edit');
  });

  it('emits text-part for text parts', () => {
    const { runtime, broadcasts } = createRuntime();

    runtime.processPayload({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: SESSION,
          role: 'assistant',
          parts: [
            { type: 'text', text: 'I am working on the task.' },
          ],
        },
      },
    });

    const activityEvents = broadcasts.filter((e) => e.type === 'openchamber:agent-activity');
    expect(activityEvents.length).toBe(1);
    expect(activityEvents[0].properties.kind).toBe('text-part');
    expect(activityEvents[0].properties.detail).toBe('I am working on the task.');
  });

  it('coalesces tool-call events within window', () => {
    let time = 1000;
    const { runtime, broadcasts } = createRuntime({
      coalesceWindowMs: 2000,
      now: () => time,
    });

    // First tool-call at t=1000 — should emit
    runtime.processPayload({
      type: 'message.updated',
      properties: {
        info: { sessionID: SESSION, role: 'assistant', parts: [{ type: 'tool-invocation', tool: 'read', input: { filePath: 'a.ts' } }] },
      },
    });

    // Second tool-call at t=1500 (within 2s window) — should be coalesced
    time = 1500;
    runtime.processPayload({
      type: 'message.updated',
      properties: {
        info: { sessionID: SESSION, role: 'assistant', parts: [{ type: 'tool-invocation', tool: 'grep', input: { pattern: 'foo' } }] },
      },
    });

    const activityEvents = broadcasts.filter((e) => e.type === 'openchamber:agent-activity');
    expect(activityEvents.length).toBe(1);

    // Third tool-call at t=3500 (after window) — should emit
    time = 3500;
    runtime.processPayload({
      type: 'message.updated',
      properties: {
        info: { sessionID: SESSION, role: 'assistant', parts: [{ type: 'tool-invocation', tool: 'read', input: { filePath: 'b.ts' } }] },
      },
    });

    const allEvents = broadcasts.filter((e) => e.type === 'openchamber:agent-activity');
    expect(allEvents.length).toBe(2);
  });

  it('always emits file-edit events without coalescing', () => {
    let time = 1000;
    const { runtime, broadcasts } = createRuntime({
      coalesceWindowMs: 2000,
      now: () => time,
    });

    time = 1000;
    runtime.processPayload({
      type: 'message.updated',
      properties: {
        info: { sessionID: SESSION, role: 'assistant', parts: [{ type: 'tool-invocation', tool: 'edit', input: { filePath: 'a.ts' } }] },
      },
    });

    time = 1500;
    runtime.processPayload({
      type: 'message.updated',
      properties: {
        info: { sessionID: SESSION, role: 'assistant', parts: [{ type: 'tool-invocation', tool: 'write', input: { filePath: 'b.ts' } }] },
      },
    });

    const fileEdits = broadcasts.filter((e) => e.type === 'openchamber:agent-activity' && e.properties.kind === 'file-edit');
    expect(fileEdits.length).toBe(2);
  });

  it('emits session-completed on idle', () => {
    const { runtime, broadcasts } = createRuntime();

    runtime.processPayload({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: SESSION,
      },
    });

    const completed = broadcasts.filter((e) => e.type === 'openchamber:session-completed');
    expect(completed.length).toBe(1);
    expect(completed[0].properties.sessionID).toBe(SESSION);
  });

  it('does not emit when stopped', () => {
    const { runtime, broadcasts } = createRuntime();
    runtime.stop();

    runtime.processPayload({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: SESSION,
          role: 'assistant',
          parts: [{ type: 'tool-invocation', tool: 'read', input: { filePath: 'x.ts' } }],
        },
      },
    });

    expect(broadcasts.length).toBe(0);
  });

  it('includes cardID from metadata when present', () => {
    const { runtime, broadcasts } = createRuntime();

    runtime.processPayload({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: SESSION,
          role: 'assistant',
          metadata: { openchamber: { cardID: 't_abc123' } },
          parts: [{ type: 'tool-invocation', tool: 'edit', input: { filePath: 'x.ts' } }],
        },
      },
    });

    const events = broadcasts.filter((e) => e.type === 'openchamber:agent-activity');
    expect(events[0].properties.cardID).toBe('t_abc123');
  });

  it('includes token counts when present', () => {
    const { runtime, broadcasts } = createRuntime();

    runtime.processPayload({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: SESSION,
          role: 'assistant',
          tokens: { input: 5000, output: 200, cache: { read: 1000 } },
          parts: [{ type: 'text', text: 'done' }],
        },
      },
    });

    const events = broadcasts.filter((e) => e.type === 'openchamber:agent-activity');
    expect(events[0].properties.tokens).toEqual({ input: 5000, output: 200, cachedRead: 1000 });
  });
});
