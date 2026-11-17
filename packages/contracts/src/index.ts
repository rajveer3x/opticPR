import { z } from 'zod';

export const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const inputSchema = z.object({
  source: z.enum(['fixture', 'github']), repositoryId: z.string().min(1),
  pullRequestNumber: z.number().int().positive(), baseSha: shaSchema, headSha: shaSchema,
});
const fixtureConfigSchema = z.object({
  adapter: z.literal('pagination-bundle-v1'), analyzer: z.literal('fixture-pagination-stub'),
  analyzerVersion: z.literal('1'), ruleRevision: z.literal('pagination-end-exclusive-v1'),
});
export const githubConfigSchema = z.object({
  adapter: z.literal('github-rest-v1'), analyzer: z.literal('intake-only'),
  analyzerVersion: z.literal('1'), ruleRevision: z.literal('none'),
});
export const configSchema = z.union([fixtureConfigSchema, githubConfigSchema]);
export const githubConfig = githubConfigSchema.parse({
  adapter: 'github-rest-v1', analyzer: 'intake-only', analyzerVersion: '1', ruleRevision: 'none',
});
export const fixtureConfig = fixtureConfigSchema.parse({
  adapter: 'pagination-bundle-v1', analyzer: 'fixture-pagination-stub',
  analyzerVersion: '1', ruleRevision: 'pagination-end-exclusive-v1',
});
export const queueJobSchema = z.object({ runId: z.uuid() });
export const stageSchema = z.object({
  name: z.enum(['repository', 'analysis', 'semgrep', 'model']),
  status: z.enum(['completed', 'skipped']), source: z.enum(['fixture', 'github']),
  version: z.string(), detail: z.string(),
});
export const findingSchema = z.object({
  id: z.string(), source: z.enum(['fixture', 'github']), ruleId: z.string(),
  severity: z.literal('high'), title: z.string(), impact: z.string(), verification: z.string(),
  evidence: z.object({
    revision: shaSchema, path: z.string(), startLine: z.number().int().positive(),
    endLine: z.number().int().positive(), excerpt: z.string(), hunk: z.string(),
  }),
});
export const reportSchema = z.object({
  schemaVersion: z.literal(1), runId: z.uuid(), logicalKey: z.string().regex(/^[a-f0-9]{64}$/),
  input: inputSchema, configuration: configSchema,
  configurationDigest: z.string().regex(/^[a-f0-9]{64}$/), source: z.enum(['fixture', 'github']),
  stages: z.array(stageSchema),
  coverage: z.object({
    status: z.enum(['complete', 'unknown']), scope: z.enum(['fixture-rule-only', 'repository-intake-only']),
    changedFiles: z.array(z.string()), analyzedFiles: z.array(z.string()),
    skippedFiles: z.array(z.object({ path: z.string(), reason: z.string() })),
    detail: z.string(),
  }),
  comparison: z.array(z.object({ path: z.string(), hunk: z.string(), status: z.string().optional(), previousPath: z.string().optional() })).optional(),
  findings: z.array(findingSchema),
});
export type ReviewInput = z.infer<typeof inputSchema>;
export type AnalysisConfig = z.infer<typeof configSchema>;
export type Report = z.infer<typeof reportSchema>;

// IDs stay strings in storage; accepting only safe numeric GitHub IDs avoids precision loss.
export const githubIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String);
export const githubRepositorySchema = z.object({
  id: githubIdSchema, name: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  owner: z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/) }),
});
export const githubPullEventSchema = z.object({
  action: z.string(), installation: z.object({ id: githubIdSchema }),
  repository: githubRepositorySchema, number: z.number().int().positive(),
  pull_request: z.object({ number: z.number().int().positive(), state: z.enum(['open', 'closed']), draft: z.boolean() }),
  changes: z.object({ base: z.object({ ref: z.object({ from: z.string() }).optional(), sha: z.object({ from: shaSchema }).optional() }).optional() }).optional(),
});
// Installation payloads contain compact repositories without an owner object.
export const githubSelectedRepositorySchema = z.object({
  id: githubIdSchema, name: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  full_name: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/),
}).refine(repo => repo.full_name.split('/')[1] === repo.name, 'Repository name mismatch')
  .transform(repo => ({ id: repo.id, name: repo.name, owner: { login: repo.full_name.split('/')[0]! } }));
export const githubInstallationEventSchema = z.object({
  action: z.string(), installation: z.object({ id: githubIdSchema }),
  repositories: z.array(githubSelectedRepositorySchema).optional(),
  repositories_added: z.array(githubSelectedRepositorySchema).optional(),
  repositories_removed: z.array(z.object({ id: githubIdSchema })).optional(),
});
export interface GitHubScope {
  installationId: string; repositoryId: string; owner: string; name: string; grantVersion: string;
}
