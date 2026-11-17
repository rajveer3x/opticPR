import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { githubRepositorySchema, inputSchema, shaSchema, type GitHubScope, type ReviewInput } from '@opticpr/contracts';
import type { ChangedFile, RepositoryAdapter } from './index.js';

export class IneligiblePullRequestError extends Error {
  constructor() { super('Pull request is closed or draft'); }
}
export interface GitHubRepositoryClient {
  pullRequest(number: number): Promise<{ number: number; state: string; draft: boolean; baseSha: string; headSha: string; repositoryId: string; title?: string }>;
  compare(baseSha: string, headSha: string): Promise<ChangedFile[]>;
  file(sha: string, path: string): Promise<string>;
}
export type GitHubClientFactory = (scope: GitHubScope, assertAccess: () => Promise<void>) => GitHubRepositoryClient;
export interface SummaryComment { id: string; body: string; appOwned: boolean }
export interface ReviewAnchor { path: string; line: number; side: 'RIGHT'; body: string }
export interface ReviewComment extends SummaryComment {
  reviewId: string; path: string; originalCommitId: string; originalLine: number | null; side: string; reply: boolean;
}
export interface GitHubPublicationClient extends GitHubRepositoryClient {
  comments(number: number): Promise<SummaryComment[]>;
  createComment(number: number, body: string): Promise<string>;
  updateComment(id: string, body: string): Promise<void>;
  reviewComments(number: number): Promise<ReviewComment[]>;
  createReview(number: number, headSha: string, comment: ReviewAnchor): Promise<string>;
}
export type GitHubPublicationClientFactory = (scope: GitHubScope, assertAccess: () => Promise<void>) => GitHubPublicationClient;

/** No PAT or public fallback. Each token can read exactly one selected repository. */
export function githubClientFactory(credentials: { appId: string; privateKey: string }, publication = false): GitHubPublicationClientFactory {
  return (scope, assertAccess) => {
    const repositoryId = Number(scope.repositoryId);
    const installationId = Number(scope.installationId);
    if (![repositoryId, installationId].every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('Invalid GitHub scope');
    const fetcher = globalThis.fetch;
    const request = { timeout: 15000, fetch: async (url: string | URL | Request, init?: RequestInit) => {
      // Includes token acquisition and every retry; revocation is checked before any network I/O.
      await assertAccess();
      return fetcher(url, { ...init, redirect: 'error' });
    } };
    const log = { debug() {}, info() {}, warn() {}, error() {} };
    const authenticate = createAppAuth({ ...credentials, request: new Octokit({ request, log }).request });
    async function session() {
      await assertAccess();
      const { token } = await authenticate({ type: 'installation', installationId,
        repositoryIds: [repositoryId], permissions: { contents: 'read', pull_requests: publication ? 'write' : 'read' } });
      return new Octokit({ auth: token, request, log });
    }
    const target = { owner: scope.owner, repo: scope.name };
    let botLogin: string | undefined;
    async function appBotLogin() {
      if (!botLogin) {
        const { token } = await authenticate({ type: 'app' });
        const { data } = await new Octokit({ auth: token, request, log }).rest.apps.getAuthenticated();
        if (!data?.slug) throw new Error('GitHub App identity unavailable');
        botLogin = `${data.slug}[bot]`;
      }
      return botLogin;
    }
    return {
      async pullRequest(number) {
        await assertAccess();
        const { data } = await (await session()).rest.pulls.get({ ...target, pull_number: number });
        const repository = githubRepositorySchema.parse(data.base.repo);
        if (repository.id !== scope.repositoryId || data.number !== number) throw new Error('GitHub repository scope mismatch');
        return { number, title: data.title, state: data.state, draft: data.draft ?? false, baseSha: shaSchema.parse(data.base.sha), headSha: shaSchema.parse(data.head.sha), repositoryId: repository.id };
      },
      async compare(baseSha, headSha) {
        shaSchema.parse(baseSha); shaSchema.parse(headSha);
        await assertAccess();
        const { data } = await (await session()).rest.repos.compareCommitsWithBasehead({ ...target, basehead: `${baseSha}...${headSha}`, per_page: 1 });
        if (!data.files || data.files.length >= 300) throw new Error('Comparison may exceed GitHub 300-file limit');
        return data.files.map(file => ({ path: file.filename, hunk: file.patch ?? '', status: file.status, previousPath: file.previous_filename }));
      },
      async file(sha, path) {
        shaSchema.parse(sha); validatePath(path);
        await assertAccess();
        const { data } = await (await session()).rest.repos.getContent({ ...target, path, ref: sha });
        if (Array.isArray(data) || data.type !== 'file' || !('content' in data) || data.encoding !== 'base64') throw new Error('Unsupported GitHub file content');
        // Never fetch download_url or PR-supplied URLs.
        return Buffer.from(data.content, 'base64').toString('utf8');
      },
      async comments(number) {
        if (!publication) throw new Error('Publication credentials required');
        const octokit = await session();
        const comments = await octokit.paginate(octokit.rest.issues.listComments, { ...target, issue_number: number, per_page: 100 });
        return comments.map(comment => ({ id: String(comment.id), body: comment.body ?? '',
          appOwned: comment.user?.type === 'Bot' && String(comment.performed_via_github_app?.id) === credentials.appId }));
      },
      async createComment(number, body) {
        if (!publication) throw new Error('Publication credentials required');
        const { data } = await (await session()).rest.issues.createComment({ ...target, issue_number: number, body });
        return String(data.id);
      },
      async updateComment(id, body) {
        if (!publication) throw new Error('Publication credentials required');
        if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error('Invalid comment ID');
        await (await session()).rest.issues.updateComment({ ...target, comment_id: Number(id), body });
      },
      async reviewComments(number) {
        if (!publication) throw new Error('Publication credentials required');
        // Review comments omit performed_via_github_app. Resolve our authenticated
        // App's reserved bot login; marker text alone never establishes ownership.
        const login = await appBotLogin();
        const octokit = await session();
        const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, { ...target, pull_number: number, per_page: 100 });
        return comments.map(comment => ({ id: String(comment.id), body: comment.body, reviewId: String(comment.pull_request_review_id),
          appOwned: comment.user?.type === 'Bot' && comment.user.login === login,
          path: comment.path, originalCommitId: comment.original_commit_id, originalLine: comment.original_line ?? comment.line ?? null,
          side: comment.side ?? '', reply: comment.in_reply_to_id !== undefined }));
      },
      async createReview(number, headSha, comment) {
        if (!publication) throw new Error('Publication credentials required');
        shaSchema.parse(headSha); validatePath(comment.path);
        if (!Number.isSafeInteger(comment.line) || comment.line < 1 || comment.side !== 'RIGHT') throw new Error('Invalid review anchor');
        const { data } = await (await session()).rest.pulls.createReview({ ...target, pull_number: number,
          commit_id: headSha, event: 'COMMENT', body: comment.body.split('\n')[0], comments: [comment] });
        return String(data.id);
      },
    };
  };
}

export function githubClientsFromEnv(): GitHubClientFactory {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replaceAll('\\n', '\n');
  // Defer validation so the credential-free fixture worker still starts.
  return (scope, assertAccess) => {
    if (!appId || !privateKey) throw new Error('GitHub App credentials are not configured');
    return githubClientFactory({ appId, privateKey })(scope, assertAccess);
  };
}

export function githubPublicationClientsFromEnv(): GitHubPublicationClientFactory {
  return (scope, assertAccess) => {
    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replaceAll('\\n', '\n');
    if (!appId || !privateKey) throw new Error('GitHub App credentials are not configured');
    return githubClientFactory({ appId, privateKey }, true)(scope, assertAccess);
  };
}

function validatePath(path: string) {
  if (!path || path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.') || path.includes('\0')) throw new Error('Invalid repository path');
}

export class GitHubRepositoryAdapter implements RepositoryAdapter {
  constructor(private readonly scope: GitHubScope, private readonly number: number, private readonly client: GitHubRepositoryClient, private readonly pinned?: ReviewInput) {}

  async revisions(): Promise<ReviewInput> {
    const pr = await this.client.pullRequest(this.number);
    if (pr.repositoryId !== this.scope.repositoryId || pr.number !== this.number) throw new Error('GitHub repository scope mismatch');
    if (pr.state !== 'open' || pr.draft) throw new IneligiblePullRequestError();
    if (this.pinned) return inputSchema.parse(this.pinned);
    return inputSchema.parse({ source: 'github', repositoryId: this.scope.repositoryId, pullRequestNumber: this.number, baseSha: pr.baseSha, headSha: pr.headSha });
  }
  async changedFiles(baseSha: string, headSha: string): Promise<ChangedFile[]> {
    shaSchema.parse(baseSha); shaSchema.parse(headSha);
    if (this.pinned && (baseSha !== this.pinned.baseSha || headSha !== this.pinned.headSha)) throw new Error('Revision metadata mismatch');
    return this.client.compare(baseSha, headSha);
  }
  async fileAt(sha: string, path: string): Promise<string> {
    shaSchema.parse(sha); validatePath(path);
    if (this.pinned && ![this.pinned.baseSha, this.pinned.headSha].includes(sha)) throw new Error('Revision metadata mismatch');
    return this.client.file(sha, path);
  }
  async close(): Promise<void> {}
}
