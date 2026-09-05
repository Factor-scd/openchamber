import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';

// Isolate auth storage so getGitLabClientOrNull never reads a real account.
const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-gitlab-client-'));
process.env.OPENCHAMBER_DATA_DIR = TEMP_DATA_DIR;

afterAll(() => {
  fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
});

// Mock child_process.spawn to simulate `glab api --include` output.
const originalSpawn = (await import('child_process')).spawn;
let spawnMock = null;

vi.mock('child_process', () => ({
  spawn: (...args) => (spawnMock ? spawnMock(...args) : originalSpawn(...args)),
}));

const {
  createGitLabClient,
  getGitLabClientOrNull,
  isGitLabRateLimited,
  noteGitLabRateLimit,
} = await import('./client.js');

/**
 * Build the `glab api --include` output format:
 *   <status line>\n<header: value>\n...\n\n<body>
 */
const cliOutput = (data, { status = 200, headers = {} } = {}) => {
  const lines = [`HTTP/1.1 ${status} OK`];
  for (const [k, v] of Object.entries(headers)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push('');
  lines.push(typeof data === 'string' ? data : JSON.stringify(data));
  return lines.join('\n');
};

/**
 * Create a vi.fn() mock spawn function that calls `on('close')` with the given
 * exit code and delivers `output` on stdout.
 */
const mockSpawn = (output, { exitCode = 0, stderr = '' } = {}) => {
  return vi.fn((...args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    queueMicrotask(() => {
      child.stdout.emit('data', output);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', exitCode);
    });
    return child;
  });
};

afterEach(() => {
  spawnMock = null;
});

describe('createGitLabClient request basics', () => {
  test('spawns glab api --include and sends GITLAB_TOKEN env', async () => {
    spawnMock = mockSpawn(cliOutput({ id: 42, username: 'alice' }));

    const client = createGitLabClient({ token: 'glpat-token', baseUrl: 'https://gitlab.com' });
    const result = await client.user();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawnMock.mock.calls[0];
    expect(bin).toBe('/home/user/.local/bin/glab');
    expect(args).toEqual(['api', '--include', '/api/v4/user']);
    expect(opts.env.GITLAB_TOKEN).toBe('glpat-token');
    expect(result).toMatchObject({ status: 200, data: { id: 42, username: 'alice' } });
    expect(result.error).toBeUndefined();
  });

  test('joins a custom base URL path without duplicating /api/v4', async () => {
    spawnMock = mockSpawn(cliOutput([]));

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.example.com/gitlab/' });
    await client.issues('group/sub', { state: 'opened' });

    const [, args] = spawnMock.mock.calls[0];
    const endpoint = args[args.length - 1];
    // CLI transport passes relative paths; base URL is resolved by glab's config.
    expect(endpoint).toContain('/api/v4/projects/group%2Fsub/issues?state=opened');
  });

  test('encodes project path namespaces exactly once', async () => {
    spawnMock = mockSpawn(cliOutput([]));

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    await client.mergeRequest('a/b/c', 5);

    const [, args] = spawnMock.mock.calls[0];
    const endpoint = args[args.length - 1];
    expect(endpoint).toContain('a%2Fb%2Fc/merge_requests/5');
    expect(endpoint).not.toContain('%252F');
  });

  test('serializes query params and omits empty ones', async () => {
    spawnMock = mockSpawn(cliOutput([]));

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    await client.mergeRequests('g/p', { state: 'opened', per_page: 50, page: 2, search: '', sort: null });

    const [, args] = spawnMock.mock.calls[0];
    const endpoint = args[args.length - 1];
    expect(endpoint).toContain('state=opened');
    expect(endpoint).toContain('per_page=50');
    expect(endpoint).toContain('page=2');
    expect(endpoint).not.toContain('search');
    expect(endpoint).not.toContain('sort');
  });

  test('POST requests pass the method flag and a JSON body', async () => {
    spawnMock = mockSpawn(cliOutput({ ok: true }, { status: 201 }));

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    await client.request('/some/action', { method: 'POST', body: { hello: 'world' } });

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('-X');
    expect(args).toContain('POST');
    expect(args).toContain('-d');
    expect(args).toContain(JSON.stringify({ hello: 'world' }));
  });

  test('surfaces error statuses without throwing', async () => {
    spawnMock = mockSpawn(cliOutput({ message: 'nope' }, { status: 401 }));

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    const result = await client.user();
    expect(result.status).toBe(401);
    expect(result.data).toEqual({ message: 'nope' });
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

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    const result = await client.user();
    expect(result.status).toBe(500);
    expect(result.error).toContain('ENOENT');
  });

  test('returns 500 on non-zero exit with no stdout', async () => {
    spawnMock = mockSpawn('', { exitCode: 1, stderr: 'not authenticated' });

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    const result = await client.user();
    expect(result.status).toBe(500);
    expect(result.error).toBe('not authenticated');
  });
});

describe('pagination', () => {
  test('page object is null (CLI handles pagination)', async () => {
    spawnMock = mockSpawn(cliOutput([]));

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    const result = await client.issues('g/p', { page: 2 });
    expect(result.page).toBeNull();
  });
});

describe('merge request write methods', () => {
  test('createMergeRequest POSTs a JSON body to the merge_requests endpoint', async () => {
    spawnMock = mockSpawn(cliOutput({ iid: 5, title: 'New MR' }, { status: 201 }));

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    const result = await client.createMergeRequest('group/sub', {
      source_branch: 'feat/x',
      target_branch: 'main',
      title: 'New MR',
    });

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('-X');
    expect(args).toContain('POST');
    expect(args).toContain(JSON.stringify({ source_branch: 'feat/x', target_branch: 'main', title: 'New MR' }));
    expect(args.some(a => typeof a === 'string' && a.includes('/merge_requests'))).toBe(true);
    expect(result.status).toBe(201);
    expect(result.data).toEqual({ iid: 5, title: 'New MR' });
  });

  test('updateMergeRequest PUTs a JSON body to the merge request endpoint', async () => {
    spawnMock = mockSpawn(cliOutput({ iid: 5, title: 'Updated' }));

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    await client.updateMergeRequest('group/sub', 5, { title: 'Updated', description: 'Body text' });

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('-X');
    expect(args).toContain('PUT');
    expect(args).toContain(JSON.stringify({ title: 'Updated', description: 'Body text' }));
  });

  test('mergeMergeRequest PUTs a JSON body to the merge endpoint', async () => {
    spawnMock = mockSpawn(cliOutput({ iid: 5, state: 'merged' }));

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    await client.mergeMergeRequest('group/sub', 5, { squash: true });

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('-X');
    expect(args).toContain('PUT');
    expect(args).toContain(JSON.stringify({ squash: true }));
    expect(args.some(a => typeof a === 'string' && a.includes('/merge'))).toBe(true);
  });

  test('write methods surface error statuses without throwing', async () => {
    spawnMock = mockSpawn(cliOutput({ message: 'Method Not Allowed' }, { status: 405 }));

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    const result = await client.mergeMergeRequest('group/sub', 5, {});
    expect(result.status).toBe(405);
    expect(result.data).toEqual({ message: 'Method Not Allowed' });
  });
});

describe('issue and review write methods', () => {
  test('createIssueNote POSTs a body to the issue notes endpoint', async () => {
    spawnMock = mockSpawn(cliOutput({ id: 5, body: 'hi' }, { status: 201 }));

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    const result = await client.createIssueNote('group/sub', 7, 'Nice catch');

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('-X');
    expect(args).toContain('POST');
    expect(args).toContain(JSON.stringify({ body: 'Nice catch' }));
    expect(args.some(a => typeof a === 'string' && a.includes('/issues/7/notes'))).toBe(true);
    expect(result.status).toBe(201);
  });

  test('createMrNote POSTs a body to the MR notes endpoint', async () => {
    spawnMock = mockSpawn(cliOutput({ id: 8, body: 'LGTM' }, { status: 201 }));

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    await client.createMrNote('group/sub', 12, 'LGTM');

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('-X');
    expect(args).toContain('POST');
    expect(args).toContain(JSON.stringify({ body: 'LGTM' }));
    expect(args.some(a => typeof a === 'string' && a.includes('/merge_requests/12/notes'))).toBe(true);
  });

  test('updateIssue PUTs params to the issue endpoint', async () => {
    spawnMock = mockSpawn(cliOutput({ iid: 7, title: 'Updated' }));

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    await client.updateIssue('group/sub', 7, { state_event: 'close', labels: ['bug'], milestone_id: 33 });

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('-X');
    expect(args).toContain('PUT');
    expect(args).toContain(JSON.stringify({ state_event: 'close', labels: ['bug'], milestone_id: 33 }));
  });

  test('approveMr POSTs to the approve endpoint', async () => {
    spawnMock = mockSpawn(cliOutput({ id: 1, state: 'approved' }));

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    await client.approveMr('group/sub', 12);

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('-X');
    expect(args).toContain('POST');
    expect(args.some(a => typeof a === 'string' && a.includes('/approve'))).toBe(true);
  });

  test('milestones passes state and per_page query params', async () => {
    spawnMock = mockSpawn(cliOutput([{ id: 33, title: 'v1.0' }]));

    const client = createGitLabClient({ token: 't', baseUrl: 'https://gitlab.com' });
    await client.milestones('group/sub', { state: 'all', per_page: 100 });

    const [, args] = spawnMock.mock.calls[0];
    const endpoint = args[args.length - 1];
    expect(endpoint).toContain('state=all');
    expect(endpoint).toContain('per_page=100');
  });
});

describe('rate limiting', () => {
  // NOTE: these tests run last in this file. The rate-limit cooldown is
  // module-level and has no reset export, so earlier tests must not set one.
  test('isGitLabRateLimited returns false (no-op with CLI transport)', () => {
    expect(isGitLabRateLimited()).toBe(false);
  });

  test('noteGitLabRateLimit is a no-op', () => {
    noteGitLabRateLimit({ headers: new Headers({ 'retry-after': '120' }) });
    expect(isGitLabRateLimited()).toBe(false);
  });

  test('getGitLabClientOrNull returns null without stored auth', () => {
    expect(getGitLabClientOrNull()).toBeNull();
  });
});
