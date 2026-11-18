import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoManifestSchema, inputSchema, shaSchema, type ReviewInput } from '@opticpr/contracts';

const exec = promisify(execFile);
const fixtureDirectory = fileURLToPath(new URL('../../../fixtures/pagination/', import.meta.url));
export interface ChangedFile { path: string; hunk: string; status?: string; previousPath?: string }
export interface SourceTree { paths: string[]; complete: boolean }
export interface RepositoryAdapter {
  revisions(): Promise<ReviewInput>;
  changedFiles(baseSha: string, headSha: string): Promise<ChangedFile[]>;
  fileAt(sha: string, path: string): Promise<string>;
  sourceTreeAt?(sha: string): Promise<SourceTree>;
  close(): Promise<void>;
}

/** Reads pinned commits from an existing Git object store, without a checkout. */
export class GitSnapshotAdapter implements RepositoryAdapter {
  private readonly input: ReviewInput;
  constructor(protected readonly directory: string, input: ReviewInput) { this.input = inputSchema.parse(input); }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await exec('git', ['--no-replace-objects', '-C', this.directory, ...args], { timeout: 5000, maxBuffer: 1024 * 1024 });
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
    if (baseSha !== this.input.baseSha || headSha !== this.input.headSha) throw new Error('Revision metadata mismatch');
    const fields = (await this.git(['diff', '--name-status', '-z', '-M', baseSha, headSha, '--'])).split('\0').filter(Boolean);
    const files: Omit<ChangedFile, 'hunk'>[] = [];
    while (fields.length) {
      const code = fields.shift()!;
      const first = fields.shift()!;
      files.push(code.startsWith('R') ? { path: fields.shift()!, previousPath: first, status: 'renamed' } :
        { path: first, status: code === 'D' ? 'removed' : code === 'A' ? 'added' : 'modified' });
    }
    return Promise.all(files.map(async file => ({ ...file,
      hunk: await this.git(['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--diff-algorithm=myers', '-M', '--unified=3', baseSha, headSha, '--', ...(file.previousPath ? [file.previousPath] : []), file.path]),
    })));
  }

  private assertRevision(sha: string) {
    shaSchema.parse(sha);
    if (![this.input.baseSha, this.input.headSha].includes(sha)) throw new Error('Revision metadata mismatch');
  }

  async fileAt(sha: string, path: string): Promise<string> {
    this.assertRevision(sha);
    if (!path || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..') || path.includes('\0')) throw new Error('Invalid repository path');
    return this.git(['cat-file', 'blob', `${sha}:${path}`]);
  }

  async sourceTreeAt(sha: string): Promise<SourceTree> {
    this.assertRevision(sha);
    const entries = (await this.git(['ls-tree', '-r', '-z', '--full-tree', sha])).split('\0');
    return { complete: true, paths: entries.flatMap(entry => {
      const tab = entry.indexOf('\t');
      return /^100(?:644|755) blob /.test(entry.slice(0, tab)) ? [entry.slice(tab + 1)] : [];
    }) };
  }

  async close(): Promise<void> {}
}

/** Owns the temporary bare repository created from a bundled synthetic fixture. */
export class FixtureRepositoryAdapter extends GitSnapshotAdapter {
  private constructor(directory: string, input: ReviewInput) { super(directory, input); }

  static async openReviewDemo(revisions: ReviewInput): Promise<FixtureRepositoryAdapter> {
    const directory = fileURLToPath(new URL('../../../fixtures/review-demo/', import.meta.url));
    const manifest = demoManifestSchema.parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')));
    const input = inputSchema.parse(revisions);
    if (!Object.values(manifest).some(candidate => JSON.stringify(candidate) === JSON.stringify(input))) throw new Error('Unknown review demo comparison');
    return this.openBundle(directory, input);
  }

  static async openEvaluation(revisions: ReviewInput): Promise<FixtureRepositoryAdapter> {
    const directory = fileURLToPath(new URL('../../../fixtures/evaluation/', import.meta.url));
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Record<string, ReviewInput>;
    const input = inputSchema.parse(revisions);
    if (!Object.values(manifest).some(candidate => JSON.stringify(inputSchema.parse(candidate)) === JSON.stringify(input))) throw new Error('Unknown sealed evaluation comparison');
    return this.openBundle(directory, input);
  }

  static async open(revisions?: ReviewInput): Promise<FixtureRepositoryAdapter> {
    const manifest = inputSchema.parse(JSON.parse(await readFile(join(fixtureDirectory, 'manifest.json'), 'utf8')));
    const input = revisions ? inputSchema.parse(revisions) : manifest;
    if (input.source !== 'fixture' || input.repositoryId !== manifest.repositoryId) throw new Error('Invalid fixture repository scope');
    return this.openBundle(fixtureDirectory, input);
  }

  private static async openBundle(bundleDirectory: string, input: ReviewInput): Promise<FixtureRepositoryAdapter> {
    const directory = await mkdtemp(join(tmpdir(), 'opticpr-fixture-'));
    try {
      await exec('git', ['clone', '--bare', '--quiet', join(bundleDirectory, 'repository.bundle'), directory], { timeout: 5000 });
      const adapter = new FixtureRepositoryAdapter(directory, input);
      await adapter.revisions();
      return adapter;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  override async close(): Promise<void> { await rm(this.directory, { recursive: true, force: true }); }
}

export { GitHubRepositoryAdapter, IneligiblePullRequestError, githubClientFactory, githubClientsFromEnv, githubPublicationClientsFromEnv } from './github.js';
export type { GitHubClientFactory, GitHubRepositoryClient, GitHubPublicationClientFactory, GitHubPublicationClient, SummaryComment, ReviewAnchor, ReviewComment } from './github.js';
