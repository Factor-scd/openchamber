import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { registerHermesIntegrationRoutes } from './routes.js';

const createApp = (getStatus) => {
  const app = express();
  registerHermesIntegrationRoutes(app, { getStatus });
  return app;
};

describe('Hermes integration route', () => {
  it('returns status JSON from the runtime', async () => {
    const getStatus = vi.fn(async () => ({
      ok: true,
      server: { version: '1.23.0', uptimeMs: 5000 },
      integrations: {
        agentActivity: { available: true },
        steer: { available: true },
        planGate: { available: true },
      },
      config: {
        planGateDefault: false,
        activityRateLimitMs: 2000,
      },
    }));
    const response = await request(createApp(getStatus))
      .get('/api/openchamber/hermes/status')
      .expect(200);

    expect(response.body.ok).toBe(true);
    expect(response.body.server.version).toBe('1.23.0');
    expect(response.body.integrations.agentActivity.available).toBe(true);
    expect(getStatus).toHaveBeenCalledOnce();
  });

  it('returns 500 on runtime failure', async () => {
    const getStatus = vi.fn(async () => {
      throw new Error('runtime exploded');
    });
    const response = await request(createApp(getStatus))
      .get('/api/openchamber/hermes/status')
      .expect(500);

    expect(response.body.ok).toBe(false);
    expect(response.body.error).toBe('runtime exploded');
  });
});
