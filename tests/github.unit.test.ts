import { createHmac, generateKeyPairSync } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { githubPullEventSchema, githubInstallationEventSchema } from '../packages/contracts/src/index.js';
import { GitHubRepositoryAdapter, githubClientFactory } from '../packages/repository/src/index.js';
import { verifySignature } from '../apps/api/src/github.js';

const scope = { installationId: '100', repositoryId: '200', owner: 'selected', name: 'repository', grantVersion: 'version' };
const baseSha = 'a'.repeat(40), headSha = 'b'.repeat(40);
afterEach(() => vi.unstubAllGlobals());

it('authenticates the exact raw bytes and rejects malformed and missing signatures', () => {
  const body = Buffer.from('{ "unicode": "π", "a": 1 }\n');
  const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`;
  expect(verifySignature(body, signature, 'secret')).toBe(true);
  expect(verifySignature(Buffer.from(JSON.stringify(JSON.parse(body.toString()))), signature, 'secret')).toBe(false);
  for (const invalid of [undefined, '', 'sha1=abcd', 'sha256=00', `sha256=${'z'.repeat(64)}`]) expect(verifySignature(body, invalid, 'secret')).toBe(false);
  expect(verifySignature(body, signature, '')).toBe(false);
});

it('recognizes only base changes on edited events and rejects unsafe numeric IDs', () => {
  const event = { action: 'edited', installation: { id: 1 }, repository: { id: 2, name: 'repo', owner: { login: 'owner' } }, number: 3, pull_request: { number: 3, state: 'open', draft: false }, changes: { base: { ref: { from: 'main' } } } };
  expect(githubPullEventSchema.parse(event).changes?.base?.ref?.from).toBe('main');
  expect(githubPullEventSchema.safeParse({ ...event, installation: { id: Number.MAX_SAFE_INTEGER + 1 } }).success).toBe(false);
});

it('mints a token for exactly the selected installation and repository and never follows PR URLs', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const network = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    let data: unknown;
    if (String(url).endsWith('/access_tokens')) data = { token: 'test-installation-token', expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: { contents: 'read', pull_requests: 'read' }, repositories: [{ id: 200, name: 'repository' }], repository_selection: 'selected' };
    else if (String(url).includes('/pulls/')) data = { number: 7, state: 'open', draft: false, base: { sha: baseSha, repo: { id: 200, name: 'repository', owner: { login: 'selected' } } }, head: { sha: headSha, repo: { url: 'https://evil.invalid' } } };
    else if (String(url).includes('/compare/')) data = { files: [{ filename: 'src/file.ts', patch: '@@\n-old\n+new', status: 'modified' }] };
    else data = { type: 'file', content: Buffer.from('exact source').toString('base64'), encoding: 'base64', download_url: 'https://evil.invalid' };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', network);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  let allowed = true;
  const check = vi.fn(async () => { if (!allowed) throw new Error('revoked'); });
  const client = githubClientFactory({ appId: '999', privateKey })(scope, check);
  const adapter = new GitHubRepositoryAdapter(scope, 7, client);
  expect(await adapter.revisions()).toMatchObject({ source: 'github', repositoryId: '200', baseSha, headSha });
  expect(await adapter.changedFiles(baseSha, headSha)).toMatchObject([{ path: 'src/file.ts', hunk: '@@\n-old\n+new' }]);
  expect(await adapter.fileAt(headSha, 'src/file.ts')).toBe('exact source');
  const token = calls.find(call => call.url.endsWith('/access_tokens'))!;
  expect(token.url).toBe('https://api.github.com/app/installations/100/access_tokens');
  expect(JSON.parse(String(token.init?.body))).toMatchObject({ repository_ids: [200], permissions: { contents: 'read', pull_requests: 'read' } });
  expect(calls.filter(call => !call.url.endsWith('/access_tokens')).every(call => call.url.startsWith('https://api.github.com/repos/selected/repository/'))).toBe(true);
  expect(calls.every(call => call.init?.redirect === 'error')).toBe(true);
  expect(calls.find(call => call.url.includes('/contents/'))?.url).toContain(`ref=${headSha}`);
  const count = network.mock.calls.length;
  allowed = false;
  await expect(adapter.changedFiles(baseSha, headSha)).rejects.toThrow('revoked');
  await expect(adapter.fileAt(headSha, 'src/file.ts')).rejects.toThrow('revoked');
  expect(network.mock.calls).toHaveLength(count);
  await expect(adapter.fileAt(headSha, '../secret')).rejects.toThrow('Invalid repository path');
});

it('refuses closed/draft live PRs and metadata for another repository', async () => {
  const pr = { number: 7, repositoryId: '200', state: 'open', draft: false, baseSha, headSha };
  const client = { pullRequest: vi.fn(async () => pr), compare: vi.fn(), file: vi.fn() };
  const adapter = new GitHubRepositoryAdapter(scope, 7, client);
  pr.draft = true;
  await expect(adapter.revisions()).rejects.toThrow('closed or draft');
  pr.draft = false; pr.state = 'closed';
  await expect(adapter.revisions()).rejects.toThrow('closed or draft');
  pr.state = 'open'; pr.repositoryId = '201';
  await expect(adapter.revisions()).rejects.toThrow('scope mismatch');
});

it('accepts GitHub compact installation repository payloads without an owner object', () => {
  // Shape from octokit/webhooks payload-examples/api.github.com/installation/created.payload.json.
  const repository = { id: 186853002, name: 'Hello-World', full_name: 'Codertocat/Hello-World', private: false };
  const parsed = githubInstallationEventSchema.parse({ action: 'created', installation: { id: 957387 }, repositories: [repository] });
  expect(parsed.repositories).toEqual([{ id: '186853002', name: 'Hello-World', owner: { login: 'Codertocat' } }]);
  expect(githubInstallationEventSchema.safeParse({ action: 'created', installation: { id: 957387 }, repositories: [{ ...repository, full_name: 'Codertocat/Another-repo' }] }).success).toBe(false);
});

it('publishes with a repository-scoped write token and paginates app ownership recovery', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    let data: unknown;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (String(url).endsWith('/access_tokens')) data = { token: 'publication-token', expires_at: new Date(Date.now() + 3600000).toISOString() };
    else if (init?.method === 'PATCH') data = { id: 42 };
    else if (init?.method === 'POST') data = { id: 43 };
    else if (String(url).includes('page=2')) data = [{ id: 42, body: 'owned', user: { type: 'Bot' }, performed_via_github_app: { id: 999 } }];
    else {
      data = [
        { id: 40, body: 'copied marker', user: { type: 'User' }, performed_via_github_app: null },
        { id: 41, body: 'other app', user: { type: 'Bot' }, performed_via_github_app: { id: 998 } },
      ];
      headers.link = '<https://api.github.com/repos/selected/repository/issues/7/comments?per_page=100&page=2>; rel="next"';
    }
    return new Response(JSON.stringify(data), { status: 200, headers });
  });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  let allowed = true;
  const client = githubClientFactory({ appId: '999', privateKey }, true)(scope, async () => { if (!allowed) throw new Error('revoked'); });
  expect(await client.comments(7)).toEqual([
    { id: '40', body: 'copied marker', appOwned: false }, { id: '41', body: 'other app', appOwned: false }, { id: '42', body: 'owned', appOwned: true },
  ]);
  expect(await client.createComment(7, 'summary')).toBe('43');
  await client.updateComment('42', 'updated summary');
  expect(JSON.parse(String(calls.find(call => call.url.endsWith('/access_tokens'))?.init?.body))).toMatchObject({ repository_ids: [200], permissions: { contents: 'read', pull_requests: 'write' } });
  expect(calls.find(call => call.init?.method === 'PATCH')?.url).toBe('https://api.github.com/repos/selected/repository/issues/comments/42');
  expect(JSON.parse(String(calls.find(call => call.init?.method === 'PATCH')?.init?.body))).toEqual({ body: 'updated summary' });
  allowed = false;
  const count = calls.length;
  await expect(client.createComment(7, 'denied')).rejects.toThrow('revoked');
  expect(calls).toHaveLength(count);
});

it('submits head-side source lines through the review API and recovers only the authenticated app bot', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const comment = { id: 71, pull_request_review_id: 70, body: 'marker', path: 'src/new.ts', original_commit_id: headSha,
    original_line: 10, line: 14, side: 'RIGHT', user: { type: 'Bot', login: 'opticpr[bot]' } };
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const target = new URL(String(url));
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    let data: unknown;
    if (target.pathname.endsWith('/access_tokens')) data = { token: 'review-token', expires_at: new Date(Date.now() + 3600000).toISOString() };
    else if (target.pathname === '/app') data = { id: 999, slug: 'opticpr' };
    else if (init?.method === 'POST') data = { id: 70 };
    else if (target.searchParams.get('page') === '2') data = [comment];
    else {
      data = [{ ...comment, id: 72, user: { type: 'User', login: 'reviewer' } },
        { ...comment, id: 73, user: { type: 'Bot', login: 'other-app[bot]' } }, { ...comment, id: 74, in_reply_to_id: 71 },
        { ...comment, id: 75, user: null }];
      headers.link = '<https://api.github.com/repos/selected/repository/pulls/7/comments?per_page=100&page=2>; rel="next"';
    }
    return new Response(JSON.stringify(data), { status: 200, headers });
  });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  let allowed = true;
  const client = githubClientFactory({ appId: '999', privateKey }, true)(scope, async () => { if (!allowed) throw new Error('revoked'); });
  expect(await client.createReview(7, headSha, { path: 'src/new.ts', line: 10, side: 'RIGHT', body: 'marker\nFinding' })).toBe('70');
  const post = calls.find(call => call.url.endsWith('/pulls/7/reviews'))!;
  expect(JSON.parse(String(post.init?.body))).toEqual({ commit_id: headSha, event: 'COMMENT', body: 'marker',
    comments: [{ path: 'src/new.ts', line: 10, side: 'RIGHT', body: 'marker\nFinding' }] });
  const comments = await client.reviewComments(7);
  expect(comments.map(item => item.appOwned)).toEqual([false, false, true, false, true]);
  expect(comments.at(-1)).toMatchObject({ id: '71', reviewId: '70', originalCommitId: headSha, originalLine: 10, path: 'src/new.ts', side: 'RIGHT', reply: false });
  expect(comments[2]?.reply).toBe(true);
  const count = calls.length;
  await expect(client.createReview(7, headSha, { path: '../unsafe', line: 10, side: 'RIGHT', body: 'x' })).rejects.toThrow('Invalid repository path');
  allowed = false;
  await expect(client.reviewComments(7)).rejects.toThrow('revoked');
  await expect(client.createReview(7, headSha, { path: 'src/new.ts', line: 10, side: 'RIGHT', body: 'x' })).rejects.toThrow('revoked');
  expect(calls).toHaveLength(count);
  const readOnly = githubClientFactory({ appId: '999', privateKey })(scope, async () => {});
  await expect(readOnly.reviewComments(7)).rejects.toThrow('Publication credentials required');
  await expect(readOnly.createReview(7, headSha, { path: 'src/new.ts', line: 10, side: 'RIGHT', body: 'x' })).rejects.toThrow('Publication credentials required');
});
