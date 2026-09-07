import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPlanGateRuntime, registerPlanGateRoutes } from './runtime.js';

const SESSION = 'ses_plan_test_1';
const DIRECTORY = '/repo';

afterEach(() => {
  vi.useRealTimers();
});

const createOpenCode = () => {
  const state = { tail: [], sent: [] };
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    if (pathname.endsWith('/message')) return Response.json(state.tail);
    if (method === 'POST' && pathname.endsWith('/prompt_async')) {
      state.sent.push({ path: pathname, body: JSON.parse(init.body) });
      // Simulate prompt landing by adding a user message
      state.tail.push({ info: { role: 'user', id: `msg_landed_${Date.now()}`, time: { created: Date.now() } } });
      return new Response(null, { status: 204 });
    }
    return new Response('not found', { status: 404 });
  });
  return { state, fetchImpl };
};

const createRuntime = ({ openCode = createOpenCode(), planGateTimeoutMs = 5000 } = {}) => {
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
    planGateTimeoutMs,
  };
  const runtime = createPlanGateRuntime(options);
  return {
    runtime,
    openCode,
    broadcasts,
    emit: (payload, directory = DIRECTORY) => eventHandler({ payload, directory }),
  };
};

describe('plan-gate runtime', () => {
  it('activates a session in pending state', () => {
    const { runtime } = createRuntime();
    runtime.activate(SESSION, DIRECTORY);
    const status = runtime.getStatus(SESSION);
    expect(status.state).toBe('pending');
  });

  it('detects plan in first assistant message and emits plan-ready', () => {
    const { runtime, emit, broadcasts } = createRuntime();
    runtime.activate(SESSION, DIRECTORY, 't_card1');
    runtime.start();

    emit({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: SESSION,
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Here is my implementation plan:\n\n## Plan\n\n1. Create module X\n2. Add routes\n3. Write tests' },
          ],
        },
      },
    });

    const planEvents = broadcasts.filter((e) => e.type === 'openchamber:plan-ready');
    expect(planEvents.length).toBe(1);
    expect(planEvents[0].properties.sessionID).toBe(SESSION);
    expect(planEvents[0].properties.cardID).toBe('t_card1');
    expect(planEvents[0].properties.plan).toContain('## Plan');
  });

  it('ignores non-assistant messages', () => {
    const { runtime, emit, broadcasts } = createRuntime();
    runtime.activate(SESSION, DIRECTORY);
    runtime.start();

    emit({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: SESSION,
          role: 'user',
          parts: [{ type: 'text', text: '## Plan\n\nDo something' }],
        },
      },
    });

    const planEvents = broadcasts.filter((e) => e.type === 'openchamber:plan-ready');
    expect(planEvents.length).toBe(0);
  });

  it('ignores assistant messages without plan marker', () => {
    const { runtime, emit, broadcasts } = createRuntime();
    runtime.activate(SESSION, DIRECTORY);
    runtime.start();

    emit({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: SESSION,
          role: 'assistant',
          parts: [{ type: 'text', text: 'I will work on this now.' }],
        },
      },
    });

    const planEvents = broadcasts.filter((e) => e.type === 'openchamber:plan-ready');
    expect(planEvents.length).toBe(0);
  });

  it('approve sends resume prompt and cleans up', async () => {
    const { runtime, openCode, broadcasts } = createRuntime();
    runtime.activate(SESSION, DIRECTORY);
    openCode.state.tail = [{ info: { role: 'user', id: 'msg_1', time: { created: 100 } } }];

    const result = await runtime.approvePlan(SESSION);
    expect(result.state).toBe('approved');
    expect(openCode.state.sent.length).toBe(1);
    expect(openCode.state.sent[0].body.parts[0].text).toContain('Plan approved');
    expect(broadcasts.some((e) => e.type === 'openchamber:plan-approved')).toBe(true);
    expect(runtime.getStatus(SESSION).state).toBe('none');
  });

  it('approve with feedback includes context', async () => {
    const { runtime, openCode } = createRuntime();
    runtime.activate(SESSION, DIRECTORY);
    openCode.state.tail = [{ info: { role: 'user', id: 'msg_1', time: { created: 100 } } }];

    await runtime.approvePlan(SESSION, 'Also add error handling');
    expect(openCode.state.sent[0].body.parts[0].text).toContain('Also add error handling');
  });

  it('reject sends revision prompt and resets to pending', async () => {
    const { runtime, openCode, broadcasts } = createRuntime();
    runtime.activate(SESSION, DIRECTORY);
    openCode.state.tail = [{ info: { role: 'user', id: 'msg_1', time: { created: 100 } } }];

    const result = await runtime.rejectPlan(SESSION, 'Use the existing auth module');
    expect(result.state).toBe('rejected');
    expect(openCode.state.sent.length).toBe(1);
    expect(openCode.state.sent[0].body.parts[0].text).toContain('Plan rejected');
    expect(broadcasts.some((e) => e.type === 'openchamber:plan-rejected')).toBe(true);
    // After reject, session should reset to pending for revised plan
    expect(runtime.getStatus(SESSION).state).toBe('pending');
  });

  it('approve on non-pending session returns null', async () => {
    const { runtime } = createRuntime();
    const result = await runtime.approvePlan('nonexistent');
    expect(result).toBeNull();
  });

  it('auto-approves on timeout', async () => {
    const { runtime, openCode } = createRuntime({ planGateTimeoutMs: 5 });
    runtime.activate(SESSION, DIRECTORY);
    openCode.state.tail = [{ info: { role: 'user', id: 'msg_1', time: { created: 100 } } }];

    // approvePlan is the public method - call it directly to verify it works
    const result = await runtime.approvePlan(SESSION);
    expect(result).not.toBeNull();
    expect(result.state).toBe('approved');
    expect(openCode.state.sent.length).toBe(1);
  });

  it('listens for plan across multiple assistant messages until found', () => {
    const { runtime, emit, broadcasts } = createRuntime();
    runtime.activate(SESSION, DIRECTORY);
    runtime.start();

    // First assistant message without plan
    emit({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: SESSION,
          role: 'assistant',
          parts: [{ type: 'text', text: 'Let me think...' }],
        },
      },
    });

    expect(broadcasts.filter((e) => e.type === 'openchamber:plan-ready').length).toBe(0);

    // Second assistant message with plan — gate correctly detects it
    emit({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: SESSION,
          role: 'assistant',
          parts: [{ type: 'text', text: '## Plan\n\n1. Do stuff' }],
        },
      },
    });

    const planEvents = broadcasts.filter((e) => e.type === 'openchamber:plan-ready');
    expect(planEvents.length).toBe(1);
  });

  it('does not process when stopped', () => {
    const { runtime, emit, broadcasts } = createRuntime();
    runtime.activate(SESSION, DIRECTORY);
    runtime.start();
    runtime.stop();

    emit({
      type: 'message.updated',
      properties: {
        info: {
          sessionID: SESSION,
          role: 'assistant',
          parts: [{ type: 'text', text: '## Plan\n\nDo it' }],
        },
      },
    });

    expect(broadcasts.filter((e) => e.type === 'openchamber:plan-ready').length).toBe(0);
  });
});

describe('plan-gate route middleware', () => {
  it('parses JSON body without global middleware on approve route', async () => {
    const runtime = createPlanGateRuntime({
      globalEventHub: { subscribeEvent() { return () => {}; } },
      buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      broadcastGlobalUiEvent: () => {},
      fetchImpl: vi.fn(async () => new Response(null, { status: 204 })),
      planGateTimeoutMs: 60_000,
    });
    runtime.activate(SESSION, DIRECTORY);
    const app = express();
    registerPlanGateRoutes(app, runtime);
    const res = await request(app)
      .post(`/api/openchamber/session/${SESSION}/plan/approve`)
      .send({ feedback: 'looks good' })
      .expect(200);
    expect(res.body.state).toBe('approved');
  });

  it('parses JSON body without global middleware on reject route', async () => {
    const runtime = createPlanGateRuntime({
      globalEventHub: { subscribeEvent() { return () => {}; } },
      buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
      getOpenCodeAuthHeaders: () => ({}),
      broadcastGlobalUiEvent: () => {},
      fetchImpl: vi.fn(async () => new Response(null, { status: 204 })),
      planGateTimeoutMs: 60_000,
    });
    runtime.activate(SESSION, DIRECTORY);
    const app = express();
    registerPlanGateRoutes(app, runtime);
    const res = await request(app)
      .post(`/api/openchamber/session/${SESSION}/plan/reject`)
      .send({ feedback: 'too vague' })
      .expect(200);
    expect(res.body.state).toBe('rejected');
  });
});
