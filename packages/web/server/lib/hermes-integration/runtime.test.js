import { describe, expect, it, vi } from 'vitest';

import { createHermesIntegrationRuntime } from './runtime.js';

const createRuntime = (overrides = {}) => {
  return createHermesIntegrationRuntime({
    agentActivityRuntime: { processPayload: vi.fn() },
    sessionSteerRuntime: { steer: vi.fn() },
    planGateRuntime: { approvePlan: vi.fn() },
    readSettingsFromDiskMigrated: vi.fn(async () => ({
      hermesPlanGateDefault: false,
    })),
    startedAt: () => Date.now() - 10_000,
    ...overrides,
  });
};

describe('Hermes integration runtime', () => {
  it('reports all three integrations as available', async () => {
    const runtime = createRuntime();
    const status = await runtime.getStatus();

    expect(status.ok).toBe(true);
    expect(status.server.version).toBeDefined();
    expect(status.integrations.agentActivity.available).toBe(true);
    expect(status.integrations.steer.available).toBe(true);
    expect(status.integrations.planGate.available).toBe(true);
  });

  it('reports availability as false when runtimes are null', async () => {
    const runtime = createRuntime({
      agentActivityRuntime: null,
      sessionSteerRuntime: null,
      planGateRuntime: null,
    });
    const status = await runtime.getStatus();

    expect(status.integrations.agentActivity.available).toBe(false);
    expect(status.integrations.steer.available).toBe(false);
    expect(status.integrations.planGate.available).toBe(false);
  });

  it('includes uptime and config', async () => {
    const runtime = createRuntime();
    const status = await runtime.getStatus();

    expect(typeof status.server.uptimeMs).toBe('number');
    expect(status.server.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(status.config.planGateDefault).toBe(false);
    expect(status.config.activityRateLimitMs).toBe(2000);
  });

  it('reads planGateDefault from settings', async () => {
    const readSettingsFromDiskMigrated = vi.fn(async () => ({
      hermesPlanGateDefault: true,
    }));
    const runtime = createRuntime({ readSettingsFromDiskMigrated });
    const status = await runtime.getStatus();

    expect(status.config.planGateDefault).toBe(true);
  });

  it('handles settings read failure gracefully', async () => {
    const readSettingsFromDiskMigrated = vi.fn(async () => {
      throw new Error('settings read failed');
    });
    const runtime = createRuntime({ readSettingsFromDiskMigrated });
    const status = await runtime.getStatus();

    expect(status.ok).toBe(true);
    expect(status.config.planGateDefault).toBe(false);
  });
});
