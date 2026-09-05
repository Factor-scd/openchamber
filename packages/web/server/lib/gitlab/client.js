import { spawn } from 'child_process';
import { getGitLabAuth, getGitLabDefaultBaseUrl } from './auth.js';

const GLAB_BIN = process.env.GLAB_BIN || '/home/user/.local/bin/glab';
const REQUEST_TIMEOUT_MS = 8000;

// NOTE: ETag conditional-GET cache and rate-limit cooldown have been dropped
// with the pivot to CLI transports. Each call spawns a fresh `glab` process,
// so there is no persistent connection to attach conditional headers to, and
// rate-limit state cannot be shared across invocations. The tradeoff is higher
// latency per call (process spawn overhead) and no 304 short-circuit, but
// simpler state management and no module-level mutable cache. Callers that
// relied on `isGitLabRateLimited()` will always see false (no cooldown active).

/**
 * Spawn a CLI binary and return { stdout, stderr, exitCode }.
 * Rejects if the process does not finish within REQUEST_TIMEOUT_MS.
 */
function spawnCli(bin, args, env, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI ${bin} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Run a `glab api` call and parse the response envelope.
 *
 * `glab api --include` outputs:
 *   <status line: HTTP/1.1 200 OK>
 *   <headers, one per line>
 *   <empty line>
 *   <JSON body>
 *
 * Without `--include`, stdout is just the JSON body on success.
 */
async function glabApiCall(endpoint, { method = 'GET', body, raw, paginate, glabBin, token }) {
  const args = ['api', '--include'];
  if (method !== 'GET') args.push('-X', method);
  if (paginate) args.push('--paginate');
  if (raw) args.push('--header', 'Accept: text/plain');
  if (body !== undefined) args.push('--header', 'Content-Type: application/json', '-d', JSON.stringify(body));
  args.push(endpoint);

  let result;
  try {
    result = await spawnCli(glabBin, args, { GITLAB_TOKEN: token });
  } catch (err) {
    return { status: 500, headers: {}, data: null, page: null, error: err.message };
  }

  const { stdout, stderr, exitCode } = result;

  if (exitCode !== 0 && !stdout.trim()) {
    return { status: 500, headers: {}, data: null, page: null, error: stderr.trim() || `glab exited with code ${exitCode}` };
  }

  // Parse --include output: status line, headers, blank line, body.
  const lines = stdout.split('\n');
  let status = 200;
  const headers = {};
  let bodyStart = 0;

  const statusMatch = lines[0]?.match(/HTTP\/\S+\s+(\d+)/);
  if (statusMatch) {
    status = Number(statusMatch[1]);
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '') {
        bodyStart = i + 1;
        break;
      }
      const colonIdx = lines[i].indexOf(':');
      if (colonIdx > 0) {
        headers[lines[i].slice(0, colonIdx).trim().toLowerCase()] = lines[i].slice(colonIdx + 1).trim();
      }
    }
  }

  const bodyText = lines.slice(bodyStart).join('\n').trim();
  if (!bodyText) {
    return { status, headers, data: null, page: null };
  }

  if (raw) {
    return { status, headers, data: bodyText, page: null };
  }

  try {
    return { status, headers, data: JSON.parse(bodyText), page: null };
  } catch {
    return { status, headers, data: bodyText, page: null };
  }
}

// ---- Rate-limit helpers (no-ops with CLI transport) ----
export function noteGitLabRateLimit() { /* no-op: CLI processes are stateless */ }
export function isGitLabRateLimited() { return false; }

// ---- Response helpers ----

const encodeProject = (pathWithNamespace) => encodeURIComponent(String(pathWithNamespace));

// Build the relative API path for glab CLI. glab resolves the base URL from its
// own config, so we pass only the /api/v4/... portion.
const apiPath = (path) => {
  const p = typeof path === 'string' && path ? (path.startsWith('/') ? path : `/${path}`) : '';
  return `/api/v4${p}`;
};

/**
 * Create a CLI-backed GitLab REST v4 client. Spawns `glab api` for each
 * request. `request` never throws for HTTP error statuses — it returns
 * `{ status, headers, data, page }` so callers can branch on status codes.
 */
export function createGitLabClient({ token, baseUrl }) {
  const effectiveBaseUrl = normalizeBaseForClient(baseUrl);
  const glabBin = process.env.GLAB_BIN || '/home/user/.local/bin/glab';

  const request = async (path, options = {}) => {
    const method = (typeof options.method === 'string' ? options.method : 'GET').toUpperCase();
    const query = options.query && typeof options.query === 'object' ? options.query : {};
    const body = options.body;

    // Build the relative endpoint path with query params baked in.
    let endpoint = apiPath(path);

    const qs = new URLSearchParams();
    let hasQuery = false;
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      qs.set(key, String(value));
      hasQuery = true;
    }
    if (hasQuery) {
      endpoint += `${endpoint.includes('?') ? '&' : '?'}${qs.toString()}`;
    }

    const paginate = method === 'GET' && hasQuery;
    return glabApiCall(endpoint, { method, body, paginate, glabBin, token });
  };

  return {
    request,
    baseUrl: effectiveBaseUrl,
    user: () => request('/user'),
    project: (pathWithNamespace) => request(`/projects/${encodeProject(pathWithNamespace)}`),
    issues: (pathWithNamespace, params = {}) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/issues`, { query: params }),
    issue: (pathWithNamespace, iid) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/issues/${iid}`),
    issueNotes: (pathWithNamespace, iid, params = {}) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/issues/${iid}/notes`, { query: params }),
    createIssueNote: (pathWithNamespace, iid, body) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/issues/${iid}/notes`, { method: 'POST', body: { body } }),
    createIssue: (pathWithNamespace, params) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/issues`, { method: 'POST', body: params }),
    updateIssue: (pathWithNamespace, iid, params) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/issues/${iid}`, { method: 'PUT', body: params }),
    mergeRequests: (pathWithNamespace, params = {}) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/merge_requests`, { query: params }),
    mergeRequest: (pathWithNamespace, iid) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/merge_requests/${iid}`),
    mergeRequestDiffs: (pathWithNamespace, iid, params = {}) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/merge_requests/${iid}/diffs`, { query: params }),
    mergeRequestCommits: (pathWithNamespace, iid, params = {}) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/merge_requests/${iid}/commits`, { query: params }),
    mergeRequestNotes: (pathWithNamespace, iid, params = {}) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/merge_requests/${iid}/notes`, { query: params }),
    createMrNote: (pathWithNamespace, iid, body) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/merge_requests/${iid}/notes`, { method: 'POST', body: { body } }),
    approveMr: (pathWithNamespace, iid) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/merge_requests/${iid}/approve`, { method: 'POST' }),
    milestones: (pathWithNamespace, params = {}) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/milestones`, { query: params }),
    createMergeRequest: (pathWithNamespace, body) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/merge_requests`, { method: 'POST', body }),
    updateMergeRequest: (pathWithNamespace, iid, body) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/merge_requests/${iid}`, { method: 'PUT', body }),
    mergeMergeRequest: (pathWithNamespace, iid, body) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/merge_requests/${iid}/merge`, { method: 'PUT', body }),
    branches: (pathWithNamespace, params = {}) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/repository/branches`, { query: params }),
    members: (pathWithNamespace, params = {}) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/members/all`, { query: params }),
    labels: (pathWithNamespace, params = {}) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/labels`, { query: params }),
    tags: (pathWithNamespace, params = {}) =>
      request(`/projects/${encodeProject(pathWithNamespace)}/repository/tags`, { query: params }),
  };
}

function normalizeBaseForClient(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    return getGitLabDefaultBaseUrl();
  }
  return baseUrl.trim().replace(/\/+$/, '');
}

/** Picks the current account (from auth.js) token + base URL, or null. */
export function getGitLabClientOrNull() {
  const auth = getGitLabAuth();
  if (!auth?.accessToken) {
    return null;
  }
  return createGitLabClient({ token: auth.accessToken, baseUrl: auth.baseUrl });
}
