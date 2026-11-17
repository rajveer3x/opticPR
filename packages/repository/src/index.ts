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

  static async open(revisions?: ReviewInput): Promise<FixtureRepositoryAdapter> {
    const manifest = inputSchema.parse(JSON.parse(await readFile(join(fixtureDirectory, 'manifest.json'), 'utf8')));
    const input = revisions ? inputSchema.parse(revisions) : manifest;
    if (input.source !== 'fixture' || input.repositoryId !== manifest.repositoryId) throw new Error('Invalid fixture repository scope');
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
    await this.git(['merge-base', '--is-ancestor', this.input.baseSha, this.input.headSha]);
    return { ...this.input };
  }

  async changedFiles(baseSha: string, headSha: string): Promise<ChangedFile[]> {
    shaSchema.parse(baseSha); shaSchema.parse(headSha);
    const fields = (await this.git(['diff', '--name-status', '-z', '-M', baseSha, headSha, '--'])).split('\0').filter(Boolean);
    const files: Omit<ChangedFile, 'hunk'>[] = [];
    while (fields.length) {
      const code = fields.shift()!;
      const first = fields.shift()!;
      files.push(code.startsWith('R') ? { path: fields.shift()!, previousPath: first, status: 'renamed' } :
        { path: first, status: code === 'D' ? 'removed' : code === 'A' ? 'added' : 'modified' });
    }
    return Promise.all(files.map(async file => ({ ...file,
      hunk: await this.git(['diff', '--no-ext-diff', '--no-textconv', '-M', '--unified=3', baseSha, headSha, '--', ...(file.previousPath ? [file.previousPath] : []), file.path]),
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
