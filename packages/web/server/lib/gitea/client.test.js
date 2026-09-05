import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';

// Isolate auth storage so getGiteaClientOrNull never reads a real account.
const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-gitea-client-'));
process.env.OPENCHAMBER_DATA_DIR = TEMP_DATA_DIR;

afterAll(() => {
  fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
});

// Mock child_process.spawn to simulate real `tea api` output.
// Real tea behavior:
//   - `--include` writes status+headers to stderr, body to stdout
//   - `--paginate` does NOT exist (tea rejects it)
//   - Auth via `-H "Authorization: token <token>"`, NOT via GITEA_SERVER_TOKEN env
const originalSpawn = (await import('child_process')).spawn;
let spawnMock = null;

vi.mock('child_process', () => ({
  spawn: (...args) => (spawnMock ? spawnMock(...args) : originalSpawn(...args)),
}));

const {
  createGiteaClient,
  getGiteaClientOrNull,
  isGiteaRateLimited,
  noteGiteaRateLimit,
} = await import('./client.js');

/**
 * Build real tea --include output: status+headers on stderr, body on stdout.
 */
const cliOutput = (data, { status = 200, headers = {} } = {}) => {
  const stderrLines = [`HTTP/2.0 ${status} OK`];
  for (const [k, v] of Object.entries(headers)) {
    stderrLines.push(`${k}: ${v}`);
  }
  stderrLines.push('');
  return {
    stdout: typeof data === 'string' ? data : JSON.stringify(data),
    stderr: stderrLines.join('\n'),
  };
};

/**
 * Create a vi.fn() mock spawn that emits stderr (headers) and stdout (body)
 * separately, matching real tea --include behavior.
 */
const mockSpawn = (output, { exitCode = 0 } = {}) => {
  const { stdout, stderr } = typeof output === 'object' && 'stdout' in output
    ? output
    : cliOutput(output);
  return vi.fn((...args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    queueMicrotask(() => {
      child.stdout.emit('data', stdout);
      child.stderr.emit('data', stderr);
      child.emit('close', exitCode);
    });
    return child;
  });
};

afterEach(() => {
  spawnMock = null;
});

describe('createGiteaClient request basics', () => {
  test('spawns tea api --include and passes auth via -H header (not env)', async () => {
    spawnMock = mockSpawn(cliOutput({ id: 42, login: 'alice' }));

    const client = createGiteaClient({ token: 'gitea-token', baseUrl: 'https://gitea.example.com' });
    const result = await client.user();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawnMock.mock.calls[0];
    expect(bin).toBe('/home/user/.local/bin/tea');
    expect(args).toContain('--include');
    expect(args).toContain('-H');
    expect(args).toContain('Authorization: token gitea-token');
    expect(args).not.toContain('--paginate');
    // Auth is via header, NOT via GITEA_SERVER_TOKEN env (C2 fix).
    expect(opts.env.GITEA_SERVER_TOKEN).toBeUndefined();
    expect(result).toMatchObject({ status: 200, data: { id: 42, login: 'alice' } });
    expect(result.error).toBeUndefined();
  });

  test('joins a custom base URL with a path without duplicating /api/v1', async () => {
    spawnMock = mockSpawn(cliOutput([]));

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com/gitea/' });
    await client.issues('owner', 'repo', { state: 'open' });

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('/api/v1/repos/owner/repo/issues?state=open');
  });

  test('serializes query params and omits empty ones', async () => {
    spawnMock = mockSpawn(cliOutput([]));

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    await client.pullRequests('owner', 'repo', { state: 'open', limit: 50, page: 2, q: '', sort: null });

    const [, args] = spawnMock.mock.calls[0];
    const endpoint = args[args.length - 1];
    expect(endpoint).toContain('state=open');
    expect(endpoint).toContain('limit=50');
    expect(endpoint).toContain('page=2');
    expect(endpoint).not.toContain('q');
    expect(endpoint).not.toContain('sort');
  });

  test('POST requests pass the method flag and a JSON body', async () => {
    spawnMock = mockSpawn(cliOutput({ ok: true }, { status: 201 }));

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    await client.request('/some/action', { method: 'POST', body: { hello: 'world' } });

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('-X');
    expect(args).toContain('POST');
    expect(args).toContain('-d');
    expect(args).toContain(JSON.stringify({ hello: 'world' }));
  });

  test('surfaces error statuses without throwing', async () => {
    spawnMock = mockSpawn(cliOutput({ message: 'nope' }, { status: 401 }));

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    const result = await client.user();
    expect(result.status).toBe(401);
    expect(result.data).toEqual({ message: 'nope' });
  });

  test('raw requests pass Accept: text/plain header', async () => {
    spawnMock = mockSpawn(cliOutput('diff --git a/src/a.ts b/src/a.ts\n'));

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    const result = await client.pullRequestDiff('owner', 'repo', 5);

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('--header');
    expect(args).toContain('Accept: text/plain');
    expect(args).toContain('/api/v1/repos/owner/repo/pulls/5.diff');
    expect(result.status).toBe(200);
    expect(result.data).toBe('diff --git a/src/a.ts b/src/a.ts');
  });

  test('returns 500 on CLI process error', async () => {
    spawnMock = (...args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      queueMicrotask(() => {
        child.emit('error', new Error('ENOENT'));
      });
      return child;
    };

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    const result = await client.user();
    expect(result.status).toBe(500);
    expect(result.error).toContain('ENOENT');
  });

  test('returns 500 on non-zero exit with no stdout and no stderr status line', async () => {
    spawnMock = mockSpawn({ stdout: '', stderr: 'not logged in' }, { exitCode: 1 });

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    const result = await client.user();
    expect(result.status).toBe(500);
    expect(result.error).toBe('not logged in');
  });

  test('parses status code from stderr --include output (C3 fix)', async () => {
    // Simulate tea's real output: 403 on stderr, error body on stdout.
    spawnMock = mockSpawn(cliOutput({ message: 'forbidden' }, { status: 403 }));

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    const result = await client.user();
    expect(result.status).toBe(403);
    expect(result.data).toEqual({ message: 'forbidden' });
  });
});

describe('pagination', () => {
  test('page is an object with hasMore=true when Link header has rel="next"', async () => {
    spawnMock = mockSpawn(
      cliOutput([{ id: 1 }], {
        headers: {
          'Link': '<https://gitea.example.com/api/v1/repos/o/r/issues?limit=1&page=2>; rel="next"',
          'X-Total-Count': '10',
        },
      }),
    );

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    const result = await client.issues('o', 'r', { limit: 1, page: 1 });
    // page is the object shape that routes.js expects
    expect(result.page).toEqual(expect.objectContaining({
      hasMore: true,
      nextUrl: 'https://gitea.example.com/api/v1/repos/o/r/issues?limit=1&page=2',
      next: 'https://gitea.example.com/api/v1/repos/o/r/issues?limit=1&page=2',
      page: 1,
      total: 10,
    }));
    expect(Array.isArray(result.data)).toBe(true);
  });

  test('page is an object with hasMore=false when no Link header', async () => {
    spawnMock = mockSpawn(cliOutput([{ id: 1 }]));

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    const result = await client.issues('o', 'r', { limit: 50 });
    expect(result.page).toEqual(expect.objectContaining({
      hasMore: false,
      next: null,
      total: null,
    }));
  });

  test('page is an object for non-array responses too', async () => {
    spawnMock = mockSpawn(cliOutput({ id: 42 }));

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    const result = await client.user();
    expect(result.page).toEqual(expect.objectContaining({
      hasMore: false,
      next: null,
      page: null,
    }));
  });

  test('does NOT pass --paginate flag to tea (C1 fix)', async () => {
    spawnMock = mockSpawn(cliOutput([]));

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    await client.issues('o', 'r', { state: 'open', page: 2 });

    const [, args] = spawnMock.mock.calls[0];
    expect(args).not.toContain('--paginate');
    expect(args).not.toContain('-paginate');
  });
});

describe('pull request write methods', () => {
  test('createPullRequest POSTs to the pulls endpoint', async () => {
    spawnMock = mockSpawn(cliOutput({ number: 5, title: 'New PR' }, { status: 201 }));

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    const result = await client.createPullRequest('owner', 'repo', {
      title: 'New PR',
      head: 'feat/x',
      base: 'main',
    });

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('-X');
    expect(args).toContain('POST');
    expect(args).toContain(JSON.stringify({ title: 'New PR', head: 'feat/x', base: 'main' }));
    expect(args.some(a => typeof a === 'string' && a.includes('/repos/owner/repo/pulls'))).toBe(true);
    expect(result.status).toBe(201);
    expect(result.data).toEqual({ number: 5, title: 'New PR' });
  });

  test('updatePullRequest PATCHes to the pull request endpoint', async () => {
    spawnMock = mockSpawn(cliOutput({ number: 5, title: 'Updated' }));

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    await client.updatePullRequest('owner', 'repo', 5, { title: 'Updated', body: 'Body text' });

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('-X');
    expect(args).toContain('PATCH');
    expect(args).toContain(JSON.stringify({ title: 'Updated', body: 'Body text' }));
  });

  test('mergePullRequest POSTs the merge style to the merge endpoint', async () => {
    spawnMock = mockSpawn(cliOutput({ merged: true }));

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    await client.mergePullRequest('owner', 'repo', 5, { Do: 'squash' });

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('-X');
    expect(args).toContain('POST');
    expect(args).toContain(JSON.stringify({ Do: 'squash' }));
    expect(args.some(a => typeof a === 'string' && a.includes('/pulls/5/merge'))).toBe(true);
  });

  test('write methods surface error statuses without throwing', async () => {
    spawnMock = mockSpawn(cliOutput({ message: 'Conflict' }, { status: 409 }));

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    const result = await client.mergePullRequest('owner', 'repo', 5, { Do: 'merge' });
    expect(result.status).toBe(409);
    expect(result.data).toEqual({ message: 'Conflict' });
  });
});

describe('issue, review, and repo write methods', () => {
  test('createIssueComment POSTs a body to the issue comments endpoint', async () => {
    spawnMock = mockSpawn(cliOutput({ id: 5, body: 'hi' }, { status: 201 }));

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    const result = await client.createIssueComment('owner', 'repo', 7, 'Nice catch');

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('-X');
    expect(args).toContain('POST');
    expect(args).toContain(JSON.stringify({ body: 'Nice catch' }));
    expect(args.some(a => typeof a === 'string' && a.includes('/issues/7/comments'))).toBe(true);
    expect(result.status).toBe(201);
  });

  test('updateIssue PATCHes params to the issue endpoint', async () => {
    spawnMock = mockSpawn(cliOutput({ number: 7, title: 'Updated' }));

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    await client.updateIssue('owner', 'repo', 7, { state: 'closed', labels: ['bug'], milestone: 33 });

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('-X');
    expect(args).toContain('PATCH');
    expect(args).toContain(JSON.stringify({ state: 'closed', labels: ['bug'], milestone: 33 }));
  });

  test('createPullReview POSTs event/body to the reviews endpoint', async () => {
    spawnMock = mockSpawn(cliOutput({ id: 101, state: 'APPROVED' }, { status: 201 }));

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    await client.createPullReview('owner', 'repo', 12, { event: 'APPROVED', body: 'LGTM' });

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('-X');
    expect(args).toContain('POST');
    expect(args).toContain(JSON.stringify({ event: 'APPROVED', body: 'LGTM' }));
  });

  test('milestones passes state and limit query params', async () => {
    spawnMock = mockSpawn(cliOutput([{ id: 33, title: 'v1.0' }]));

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    await client.milestones('owner', 'repo', { state: 'all', limit: 50 });

    const [, args] = spawnMock.mock.calls[0];
    const endpoint = args[args.length - 1];
    expect(endpoint).toContain('state=all');
    expect(endpoint).toContain('limit=50');
  });

  test('repoLabels passes limit query param', async () => {
    spawnMock = mockSpawn(cliOutput([{ id: 1, name: 'bug', color: 'd73a4a' }]));

    const client = createGiteaClient({ token: 't', baseUrl: 'https://gitea.example.com' });
    await client.repoLabels('owner', 'repo', { limit: 100 });

    const [, args] = spawnMock.mock.calls[0];
    const endpoint = args[args.length - 1];
    expect(endpoint).toContain('limit=100');
  });
});

describe('rate limiting', () => {
  // NOTE: these tests run last in this file. The rate-limit cooldown is
  // module-level and has no reset export, so earlier tests must not set one.
  test('isGiteaRateLimited returns false (no-op with CLI transport)', () => {
    expect(isGiteaRateLimited()).toBe(false);
  });

  test('noteGiteaRateLimit is a no-op', () => {
    noteGiteaRateLimit({ headers: new Headers({ 'retry-after': '120' }) });
    expect(isGiteaRateLimited()).toBe(false);
  });

  test('getGiteaClientOrNull returns null without stored auth', () => {
    expect(getGiteaClientOrNull()).toBeNull();
  });
});
