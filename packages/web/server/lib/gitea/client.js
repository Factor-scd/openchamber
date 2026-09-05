import { spawn } from 'child_process';
import { getGiteaAuth } from './auth.js';
import { getProviderApiBaseUrl } from '../git-providers/config.js';
import { getEffectiveProviderApiBaseUrl } from '../git-providers/project-config.js';

const TEA_BIN = process.env.TEA_BIN || '/home/user/.local/bin/tea';
const REQUEST_TIMEOUT_MS = 8000;

// NOTE: ETag conditional-GET cache and rate-limit cooldown have been dropped
// with the pivot to CLI transports. Each call spawns a fresh `tea` process,
// so there is no persistent connection to attach conditional headers to, and
// rate-limit state cannot be shared across invocations. The tradeoff is higher
// latency per call (process spawn overhead) and no 304 short-circuit, but
// simpler state management and no module-level mutable cache. Callers that
// relied on `isGiteaRateLimited()` will always see false (no cooldown active).

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
 * Run a `tea api` call and parse the response envelope.
 *
 * `tea api --include` outputs:
 *   <status line: HTTP/1.1 200 OK>
 *   <headers, one per line>
 *   <empty line>
 *   <JSON body>
 *
 * Without `--include`, stdout is just the JSON body on success.
 */
async function teaApiCall(endpoint, { method = 'GET', body, raw, paginate, teaBin, token }) {
  const args = ['api', '--include'];
  if (method !== 'GET') args.push('-X', method);
  if (paginate) args.push('--paginate');
  if (raw) args.push('--header', 'Accept: text/plain');
  if (body !== undefined) args.push('--header', 'Content-Type: application/json', '-d', JSON.stringify(body));
  args.push(endpoint);

  let result;
  try {
    result = await spawnCli(teaBin, args, { GITEA_SERVER_TOKEN: token });
  } catch (err) {
    return { status: 500, headers: {}, data: null, page: null, error: err.message };
  }

  const { stdout, stderr, exitCode } = result;

  if (exitCode !== 0 && !stdout.trim()) {
    return { status: 500, headers: {}, data: null, page: null, error: stderr.trim() || `tea exited with code ${exitCode}` };
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
export function noteGiteaRateLimit() { /* no-op: CLI processes are stateless */ }
export function isGiteaRateLimited() { return false; }

// ---- Response helpers ----

// Build the relative API path for tea CLI. tea resolves the base URL from its
// own login config, so we pass only the /api/v1/... portion.
const apiPath = (path) => {
  const p = typeof path === 'string' && path ? (path.startsWith('/') ? path : `/${path}`) : '';
  return `/api/v1${p}`;
};

/**
 * Create a CLI-backed Gitea/Forgejo REST v1 client. Spawns `tea api` for each
 * request. `request` never throws for HTTP error statuses — it returns
 * `{ status, headers, data, page }` so callers can branch on status codes.
 */
export function createGiteaClient({ token, baseUrl }) {
  const effectiveBaseUrl = typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/, '') : '';
  const teaBin = process.env.TEA_BIN || '/home/user/.local/bin/tea';

  const request = async (path, options = {}) => {
    const method = (typeof options.method === 'string' ? options.method : 'GET').toUpperCase();
    const query = options.query && typeof options.query === 'object' ? options.query : {};
    const body = options.body;
    const raw = options.raw === true;

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
    return teaApiCall(endpoint, { method, body, raw, paginate, teaBin, token });
  };

  return {
    request,
    baseUrl: effectiveBaseUrl,
    user: () => request('/user'),
    repo: (owner, repo) => request(`/repos/${owner}/${repo}`),
    issues: (owner, repo, params = {}) =>
      request(`/repos/${owner}/${repo}/issues`, { query: params }),
    issue: (owner, repo, number) =>
      request(`/repos/${owner}/${repo}/issues/${number}`),
    issueComments: (owner, repo, number, params = {}) =>
      request(`/repos/${owner}/${repo}/issues/${number}/comments`, { query: params }),
    createIssueComment: (owner, repo, number, body) =>
      request(`/repos/${owner}/${repo}/issues/${number}/comments`, { method: 'POST', body: { body } }),
    createIssue: (owner, repo, params) =>
      request(`/repos/${owner}/${repo}/issues`, { method: 'POST', body: params }),
    updateIssue: (owner, repo, number, params) =>
      request(`/repos/${owner}/${repo}/issues/${number}`, { method: 'PATCH', body: params }),
    milestones: (owner, repo, params = {}) =>
      request(`/repos/${owner}/${repo}/milestones`, { query: params }),
    repoLabels: (owner, repo, params = {}) =>
      request(`/repos/${owner}/${repo}/labels`, { query: params }),
    pullRequests: (owner, repo, params = {}) =>
      request(`/repos/${owner}/${repo}/pulls`, { query: params }),
    pullRequest: (owner, repo, number) =>
      request(`/repos/${owner}/${repo}/pulls/${number}`),
    pullRequestDiff: (owner, repo, number) =>
      request(`/repos/${owner}/${repo}/pulls/${number}.diff`, { raw: true }),
    pullRequestFiles: (owner, repo, number, params = {}) =>
      request(`/repos/${owner}/${repo}/pulls/${number}/files`, { query: params }),
    pullRequestCommits: (owner, repo, number, params = {}) =>
      request(`/repos/${owner}/${repo}/pulls/${number}/commits`, { query: params }),
    pullRequestReviews: (owner, repo, number, params = {}) =>
      request(`/repos/${owner}/${repo}/pulls/${number}/reviews`, { query: params }),
    createPullReview: (owner, repo, number, params) =>
      request(`/repos/${owner}/${repo}/pulls/${number}/reviews`, { method: 'POST', body: params }),
    commitStatuses: (owner, repo, sha, params = {}) =>
      request(`/repos/${owner}/${repo}/commits/${sha}/statuses`, { query: params }),
    createPullRequest: (owner, repo, body) =>
      request(`/repos/${owner}/${repo}/pulls`, { method: 'POST', body }),
    updatePullRequest: (owner, repo, number, body) =>
      request(`/repos/${owner}/${repo}/pulls/${number}`, { method: 'PATCH', body }),
    mergePullRequest: (owner, repo, number, body) =>
      request(`/repos/${owner}/${repo}/pulls/${number}/merge`, { method: 'POST', body }),
    branches: (owner, repo, params = {}) =>
      request(`/repos/${owner}/${repo}/branches`, { query: params }),
    assignees: (owner, repo, params = {}) =>
      request(`/repos/${owner}/${repo}/assignees`, { query: params }),
    tags: (owner, repo, params = {}) =>
      request(`/repos/${owner}/${repo}/tags`, { query: params }),
  };
}

/** Picks the current account (from auth.js) token + base URL, or null. A per-project override replaces the account's base URL for that project. */
export function getGiteaClientOrNull(directory) {
  const auth = getGiteaAuth();
  if (!auth?.accessToken || !auth?.baseUrl) {
    return null;
  }
  let baseUrl = auth.baseUrl;
  if (directory) {
    const effectiveBaseUrl = getEffectiveProviderApiBaseUrl('gitea', directory);
    if (effectiveBaseUrl !== null && effectiveBaseUrl !== getProviderApiBaseUrl('gitea')) {
      baseUrl = effectiveBaseUrl;
    }
  }
  return createGiteaClient({ token: auth.accessToken, baseUrl });
}
