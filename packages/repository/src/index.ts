import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inputSchema, shaSchema, type ReviewInput } from '@opticpr/contracts';

const exec = promisify(execFile);
const fixtureDirectory = fileURLToPath(new URL('../../../fixtures/pagination/', import.meta.url));
export interface ChangedFile { path: string; hunk: string; status?: string; previousPath?: string }
export interface RepositoryAdapter {
  revisions(): Promise<ReviewInput>;
  changedFiles(baseSha: string, headSha: string): Promise<ChangedFile[]>;
  fileAt(sha: string, path: string): Promise<string>;
  close(): Promise<void>;
}

/** Only reads the bundled synthetic repository; never executes reviewed code. */
export class FixtureRepositoryAdapter implements RepositoryAdapter {
  private constructor(private readonly directory: string, private readonly input: ReviewInput) {}

  static async open(): Promise<FixtureRepositoryAdapter> {
    const input = inputSchema.parse(JSON.parse(await readFile(join(fixtureDirectory, 'manifest.json'), 'utf8')));
    const directory = await mkdtemp(join(tmpdir(), 'opticpr-fixture-'));
    try {
      await exec('git', ['clone', '--bare', '--quiet', join(fixtureDirectory, 'repository.bundle'), directory], { timeout: 5000 });
      const adapter = new FixtureRepositoryAdapter(directory, input);
      await adapter.revisions();
      return adapter;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await exec('git', ['-C', this.directory, ...args], { timeout: 5000, maxBuffer: 1024 * 1024 });
    return stdout;
  }

  async revisions(): Promise<ReviewInput> {
    for (const sha of [this.input.baseSha, this.input.headSha]) {
      await this.git(['cat-file', '-e', `${sha}^{commit}`]);
    }
    const parent = (await this.git(['rev-parse', `${this.input.headSha}^`])).trim();
    if (parent !== this.input.baseSha) throw new Error('Fixture head must directly descend from base');
    return { ...this.input };
  }

  async changedFiles(baseSha: string, headSha: string): Promise<ChangedFile[]> {
    shaSchema.parse(baseSha); shaSchema.parse(headSha);
    const paths = (await this.git(['diff', '--name-only', '-z', baseSha, headSha, '--'])).split('\0').filter(Boolean);
    return Promise.all(paths.map(async path => ({
      path, hunk: await this.git(['diff', '--no-ext-diff', '--no-textconv', '--unified=3', baseSha, headSha, '--', path]),
    })));
  }

  async fileAt(sha: string, path: string): Promise<string> {
    shaSchema.parse(sha);
    if (!path || path.startsWith('/') || path.split('/').includes('..')) throw new Error('Invalid repository path');
    return this.git(['show', `${sha}:${path}`]);
  }

  async close(): Promise<void> { await rm(this.directory, { recursive: true, force: true }); }
}

export { GitHubRepositoryAdapter, IneligiblePullRequestError, githubClientFactory, githubClientsFromEnv, githubPublicationClientsFromEnv } from './github.js';
export type { GitHubClientFactory, GitHubRepositoryClient, GitHubPublicationClientFactory, GitHubPublicationClient, SummaryComment } from './github.js';
