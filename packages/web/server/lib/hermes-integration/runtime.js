// Hermes integration status: reports the availability and configuration of the
// three agent-to-agent runtimes (activity stream, steer channel, plan gate) that
// power the Hermes ↔ OpenChamber link. Pure read-only — does not modify any
// existing runtime.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PACKAGE_VERSION = (() => {
  try {
    const packagePath = path.resolve(__dirname, '..', '..', 'package.json');
    const raw = fs.readFileSync(packagePath, 'utf8');
    const pkg = JSON.parse(raw);
    if (pkg && typeof pkg.version === 'string' && pkg.version.trim().length > 0) {
      return pkg.version.trim();
    }
  } catch {
    // fall through
  }
  return 'unknown';
})();

export function createHermesIntegrationRuntime({
  agentActivityRuntime,
  sessionSteerRuntime,
  planGateRuntime,
  readSettingsFromDiskMigrated,
  startedAt = Date.now,
}) {
  const getStatus = async () => {
    const settings = await readSettingsFromDiskMigrated().catch(() => null);
    const uptimeMs = Date.now() - startedAt();

    return {
      ok: true,
      server: {
        version: PACKAGE_VERSION,
        uptimeMs,
      },
      integrations: {
        agentActivity: {
          available: agentActivityRuntime != null,
        },
        steer: {
          available: sessionSteerRuntime != null,
        },
        planGate: {
          available: planGateRuntime != null,
        },
      },
      config: {
        planGateDefault: Boolean(settings?.hermesPlanGateDefault),
        activityRateLimitMs: 2000,
      },
    };
  };

  return { getStatus };
}
