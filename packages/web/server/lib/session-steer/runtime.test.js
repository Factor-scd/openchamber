import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionSteerRuntime } from './runtime.js';

const SESSION = 'ses_steer_test_1';
const DIRECTORY = '/repo';

afterEach(() => {
  vi.useRealTimers();
});

const createOpenCode = () => {
  const state = {
    statuses: {},
    tail: [],
    sent: [],
  };
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    if (pathname === '/session/status') return Response.json(state.statuses);
    if (pathname.endsWith('/message')) return Response.json(state.tail);
    if (method === 'POST' && pathname.endsWith('/prompt_async')) {
      state.sent.push({ path: pathname, body: JSON.parse(init.body) });
      // Simulate prompt landing by adding a new user message
      state.tail.push({ info: { role: 'user', id: `msg_landed_${Date.now()}`, time: { created: Date.now() } } });
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && pathname.endsWith('/interrupt')) {
      return new Response(null, { status: 204 });
    }
    return new Response('not found', { status: 404 });
  });
  return { state, fetchImpl };
};

const createRuntime = ({ openCode = createOpenCode() } = {}) => {
  let eventHandler = () => {};
  const broadcasts = [];
  const options = {
    globalEventHub: {
      subscribeEvent(handler) { eventHandler = handler; return () => {}; },
    },
    buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
    getOpenCodeAuthHeaders: () => ({}),
    broadcastGlobalUiEvent: (event) => broadcasts.push(event),
    fetchImpl: openCode.fetchImpl,
  };
  const runtime = createSessionSteerRuntime(options);
  return {
    runtime,
    openCode,
    broadcasts,
    emit: (payload, directory = DIRECTORY) => eventHandler({ payload, directory }),
  };
};

describe('session-steer runtime', () => {
  it('rejects invalid sessionId', async () => {
    const { runtime } = createRuntime();
    await expect(runtime.steer('', DIRECTORY, 'do something')).rejects.toThrow(TypeError);
  });

  it('rejects empty directive', async () => {
    const { runtime } = createRuntime();
    await expect(runtime.steer(SESSION, DIRECTORY, '')).rejects.toThrow(TypeError);
  });

  it('rejects empty directory', async () => {
    const { runtime } = createRuntime();
    await expect(runtime.steer(SESSION, '', 'do something')).rejects.toThrow(TypeError);
  });

  it('delivers directive to idle session via interrupt mode', async () => {
    const { runtime, openCode } = createRuntime();
    openCode.state.statuses[SESSION] = { type: 'idle' };
    openCode.state.tail = [{ info: { role: 'user', id: 'msg_1', time: { created: 100 } } }];

    const result = await runtime.steer(SESSION, DIRECTORY, 'STOP comparing worktrees', 'interrupt');
    expect(result.accepted).toBe(true);
    expect(result.mode).toBe('interrupt');
    expect(openCode.state.sent.length).toBe(1);
    expect(openCode.state.sent[0].body.parts[0].text).toContain('STOP comparing worktrees');
  });

  it('queues directive for busy session', async () => {
    const { runtime, openCode } = createRuntime();
    openCode.state.statuses[SESSION] = { type: 'busy' };

    const result = await runtime.steer(SESSION, DIRECTORY, 'STOP comparing worktrees', 'interrupt');
    expect(result.accepted).toBe(true);
    expect(result.mode).toBe('queue');
  });

  it('queue mode stores directive without sending', async () => {
    const { runtime, openCode } = createRuntime();
    openCode.state.statuses[SESSION] = { type: 'idle' };

    const result = await runtime.steer(SESSION, DIRECTORY, 'wait for idle', 'queue');
    expect(result.accepted).toBe(true);
    expect(result.mode).toBe('queue');
    expect(openCode.state.sent.length).toBe(0);
  });

  it('delivers queued directive on idle event', async () => {
    const { runtime, openCode, emit, broadcasts } = createRuntime();
    runtime.start();
    openCode.state.statuses[SESSION] = { type: 'busy' };
    openCode.state.tail = [];

    // Queue the directive
    await runtime.steer(SESSION, DIRECTORY, 'delivered on idle', 'queue');
    expect(openCode.state.sent.length).toBe(0);

    // Now the session goes idle
    openCode.state.statuses[SESSION] = { type: 'idle' };
    openCode.state.tail = [{ info: { role: 'user', id: 'msg_1', time: { created: 100 } } }];

    emit({
      type: 'session.status',
      properties: {
        sessionID: SESSION,
        status: { type: 'idle' },
      },
    });

    // Wait for async delivery to complete
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(openCode.state.sent.length).toBe(1);
    expect(openCode.state.sent[0].body.parts[0].text).toContain('delivered on idle');
    const steerEvents = broadcasts.filter((e) => e.type === 'openchamber:steer-delivered');
    expect(steerEvents.length).toBe(1);
  });

  it('does not deliver when stopped', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    openCode.state.statuses[SESSION] = { type: 'busy' };

    await runtime.steer(SESSION, DIRECTORY, 'should not deliver', 'queue');
    runtime.stop();

    openCode.state.statuses[SESSION] = { type: 'idle' };
    openCode.state.tail = [{ info: { role: 'user', id: 'msg_1', time: { created: 100 } } }];
    emit({
      type: 'session.status',
      properties: { sessionID: SESSION, status: { type: 'idle' } },
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(openCode.state.sent.length).toBe(0);
  });
});
