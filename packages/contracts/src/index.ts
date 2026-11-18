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
const intakeConfigSchema = z.object({
  adapter: z.literal('github-rest-v1'), analyzer: z.literal('intake-only'),
  analyzerVersion: z.literal('1'), ruleRevision: z.literal('none'),
});
export const localConfigSchema = z.object({
  adapter: z.enum(['github-rest-v1', 'pagination-bundle-v1', 'evaluation-bundle-v1', 'historical-git-v1', 'review-demo-bundle-v1']), analyzer: z.literal('local-analysis'),
  analyzerVersion: z.literal('1'), ruleRevision: z.literal('local-js-ts-v1'),
  crossFileRuleRevision: z.literal('ts-missing-value-throws-v1').optional(),
  semgrepVersion: z.literal('1.144.0'), grammarRevision: z.literal('js-0.23.1-ts-0.23.2-wasm-0.25.10'),
  promptRevision: z.literal('review-v1'), model: z.literal('qwen2.5-coder:7b'),
  modelRevision: z.literal('sha256:dae161e27b0e90dd1856c8bb3209201fd6736d8eb66298e75ed87571486f4364'),
  modelEnabled: z.boolean().optional(),
  contextTokens: z.union([z.literal(4096), z.literal(8192)]), contextMode: z.enum(['diff-only', 'function-context']),
  maxFiles: z.literal(20), maxChangedLines: z.literal(800), modelDeadlineMs: z.literal(90000),
});
export const githubConfigSchema = z.union([intakeConfigSchema, localConfigSchema]);
export const configSchema = z.union([fixtureConfigSchema, intakeConfigSchema, localConfigSchema]);
export const localAnalysisBaseline = localConfigSchema.parse({
  adapter: 'github-rest-v1', analyzer: 'local-analysis', analyzerVersion: '1', ruleRevision: 'local-js-ts-v1',
  semgrepVersion: '1.144.0', grammarRevision: 'js-0.23.1-ts-0.23.2-wasm-0.25.10', promptRevision: 'review-v1',
  model: 'qwen2.5-coder:7b', modelRevision: 'sha256:dae161e27b0e90dd1856c8bb3209201fd6736d8eb66298e75ed87571486f4364',
  modelEnabled: false, contextTokens: 4096, contextMode: 'function-context', maxFiles: 20, maxChangedLines: 800, modelDeadlineMs: 90000,
});
export const githubConfig = localConfigSchema.parse({ ...localAnalysisBaseline, crossFileRuleRevision: 'ts-missing-value-throws-v1' });
export type LocalConfig = z.infer<typeof localConfigSchema>;
export const fixtureConfig = fixtureConfigSchema.parse({
  adapter: 'pagination-bundle-v1', analyzer: 'fixture-pagination-stub',
  analyzerVersion: '1', ruleRevision: 'pagination-end-exclusive-v1',
});
export const queueJobSchema = z.object({ runId: z.uuid() });
export const stageSchema = z.object({
  name: z.enum(['repository', 'analysis', 'semgrep', 'cross-file', 'model']),
  status: z.enum(['completed', 'skipped', 'partial', 'failed']), source: z.enum(['fixture', 'github']),
  version: z.string(), detail: z.string(),
});
export const evidenceSchema = z.object({
  revision: shaSchema, path: z.string(), startLine: z.number().int().positive(),
  endLine: z.number().int().positive(), excerpt: z.string(), hunk: z.string(),
});
export const findingIdentitySchema = z.object({
  kind: z.enum(['static', 'model', 'fixture']), class: z.string(), expression: z.string(), symbol: z.string(),
});
export const citationSchema = z.object({
  kind: z.enum(['static', 'model', 'fixture']), ruleId: z.string(), evidence: evidenceSchema,
  role: z.enum(['changed-throw', 'caller-fallback', 'base-return']).optional(),
});
export const findingSchema = z.object({
  id: z.string(), source: z.enum(['fixture', 'github']), ruleId: z.string(),
  severity: z.enum(['high', 'medium', 'low']), title: z.string(), impact: z.string(), verification: z.string(),
  evidence: evidenceSchema,
  identity: findingIdentitySchema.optional(), citations: z.array(citationSchema).optional(),
});
export const decisionInputSchema = z.object({
  id: z.uuid(), runId: z.uuid(), findingId: z.uuid(), action: z.enum(['dismiss', 'reopen']),
  actor: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(2000),
}).strict();
export const findingDecisionSchema = decisionInputSchema.extend({ createdAt: z.string().datetime(), sequence: z.number().int().positive().optional() });
export const findingHistoryEntrySchema = z.object({
  findingId: z.uuid(), state: z.enum(['new', 'still_present', 'cleared_by_recheck', 'needs_verification']),
  reason: z.string(), previous: z.object({ runId: z.uuid(), findingId: z.uuid() }).optional(),
  observation: findingSchema.optional(), lastObservation: findingSchema, lastObservedRunId: z.uuid(),
  lastObservedConfigurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: findingDecisionSchema.optional(),
});
export const findingHistorySchema = z.object({
  previousRunId: z.uuid().nullable(), findings: z.array(findingHistoryEntrySchema),
});
export type Finding = z.infer<typeof findingSchema>;
export type FindingHistory = z.infer<typeof findingHistorySchema>;
export type FindingHistoryEntry = z.infer<typeof findingHistoryEntrySchema>;
export const reportSchema = z.object({
  schemaVersion: z.literal(1), runId: z.uuid(), logicalKey: z.string().regex(/^[a-f0-9]{64}$/),
  input: inputSchema, configuration: configSchema,
  configurationDigest: z.string().regex(/^[a-f0-9]{64}$/), source: z.enum(['fixture', 'github']),
  stages: z.array(stageSchema),
  coverage: z.object({
    status: z.enum(['complete', 'partial', 'unknown']), scope: z.enum(['fixture-rule-only', 'repository-intake-only', 'local-js-ts']),
    changedFiles: z.array(z.string()), analyzedFiles: z.array(z.string()),
    skippedFiles: z.array(z.object({ path: z.string(), reason: z.string() })),
    detail: z.string(),
  }),
  comparison: z.array(z.object({ path: z.string(), hunk: z.string(), status: z.string().optional(), previousPath: z.string().optional() })).optional(),
  findings: z.array(findingSchema),
  history: findingHistorySchema.optional(),
  // Full-file deterministic results, including matches outside added diff lines.
  recheck: z.object({ completed: z.boolean(), rules: z.array(z.string()), files: z.array(z.string()), observations: z.array(findingSchema) }).optional(),
  crossFileRecheck: z.object({ completed: z.boolean(), callees: z.array(z.string()), callers: z.array(z.string()), observations: z.array(findingSchema) }).optional(),
  enrichment: z.object({
    status: z.enum(['completed', 'partial', 'failed', 'skipped']), accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(), detail: z.string(),
  }).optional(),
});
export type ReviewInput = z.infer<typeof inputSchema>;
export type AnalysisConfig = z.infer<typeof configSchema>;
export type Report = z.infer<typeof reportSchema>;

const demoInputSchema = inputSchema.extend({ source: z.literal('fixture'), repositoryId: z.literal('fixture/missing-user') });
export const demoManifestSchema = z.object({ regression: demoInputSchema, fix: demoInputSchema }).refine(({ regression, fix }) =>
  regression.baseSha === fix.baseSha && regression.pullRequestNumber === fix.pullRequestNumber &&
  new Set([regression.baseSha, regression.headSha, fix.headSha]).size === 3);
const demoRunSchema = z.object({ createdAt: z.iso.datetime(), completedAt: z.iso.datetime(), report: reportSchema, caller: evidenceSchema });
export const demoReplaySchema = z.object({ version: z.literal(1), regression: demoRunSchema, fix: demoRunSchema });
export type DemoReplay = z.infer<typeof demoReplaySchema>;

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

// Structured output is a proposal. Evidence is verified again against the head snapshot.
export const modelCandidateSchema = z.object({
  observationId: z.string().nullable(), ruleId: z.string().min(1).max(120),
  title: z.string().min(1).max(300), impact: z.string().min(1).max(2000), verification: z.string().min(1).max(2000),
  severity: z.enum(['high', 'medium', 'low']),
  revision: shaSchema, path: z.string().min(1).max(500),
  startLine: z.number().int().positive(), endLine: z.number().int().positive(), excerpt: z.string().min(1).max(4000),
}).strict();
export const modelOutputSchema = z.object({ candidates: z.array(modelCandidateSchema).max(20) }).strict();
export type ModelCandidate = z.infer<typeof modelCandidateSchema>;
export const staticCheckpointSchema = z.object({
  version: z.literal(1), report: reportSchema, completedAt: z.string(),
});
// Ollama/llama.cpp compiles string and integer bounds into grammar repetitions.
// Keep its generation schema structural; Zod enforces all strict limits afterward.
function generationSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(generationSchema);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['maxLength', 'minLength', 'maximum', 'minimum', 'exclusiveMinimum', 'exclusiveMaximum'].includes(key))
    .map(([key, child]) => [key, generationSchema(child)]));
  return value;
}
export const modelOutputJsonSchema = generationSchema(z.toJSONSchema(modelOutputSchema));
export const semgrepOutputSchema = z.object({
  results: z.array(z.object({ check_id: z.string(), path: z.string(),
    start: z.object({ line: z.number().int().positive() }), end: z.object({ line: z.number().int().positive() }),
    extra: z.object({ message: z.string(), severity: z.string() }),
  })),
  errors: z.array(z.unknown()),
  paths: z.object({ scanned: z.array(z.string()) }),
});

// Dashboard responses are deliberately separate from immutable analysis snapshots.
export const dashboardDecisionSchema = z.object({
  id: z.uuid(), runId: z.uuid(), action: z.enum(['dismiss', 'reopen']), reason: z.string().trim().min(1).max(2000),
}).strict();
export const dashboardRetrySchema = z.object({ id: z.uuid(), reason: z.string().trim().min(1).max(2000) }).strict();
export const sessionSchema = z.object({ user: z.object({ id: z.string(), login: z.string() }), csrfToken: z.string() });
export const dashboardRepositorySchema = z.object({
  id: z.string(), owner: z.string(), name: z.string(), installationId: z.string(),
  role: z.enum(['member', 'maintainer']), canPublish: z.boolean(), lastEventAt: z.string().nullable(),
});
export const runSummarySchema = z.object({
  id: z.uuid(), baseSha: shaSchema, headSha: shaSchema, state: z.string(), attempt: z.number().int().nonnegative(),
  createdAt: z.string(), completedAt: z.string().nullable(), coverage: z.enum(['complete', 'partial', 'unknown']).nullable(),
  findings: z.number().int().nonnegative(),
});
export const pullRequestSummarySchema = z.object({
  number: z.number(), title: z.string(), baseSha: shaSchema, headSha: shaSchema, eligible: z.boolean(),
  latestRunId: z.uuid().nullable(), latestRun: runSummarySchema.nullable(), desiredRun: runSummarySchema.nullable(),
  publicationState: z.string().nullable(), updatedAt: z.string(),
});
export const repositoryListSchema = z.object({ repositories: z.array(dashboardRepositorySchema), installationUrl: z.string().url().nullable() });
export const pullRequestListSchema = z.object({
  repository: dashboardRepositorySchema, items: z.array(pullRequestSummarySchema), page: z.number(), pageSize: z.number(), total: z.number(), hasActive: z.boolean(),
});
export const runDetailSchema = runSummarySchema.extend({
  repository: dashboardRepositorySchema, pullRequest: pullRequestSummarySchema.nullable(),
  configurationDigest: z.string(), error: z.string().nullable(), report: reportSchema.nullable(),
  revisions: z.array(runSummarySchema), decisions: z.array(findingDecisionSchema),
  retries: z.array(z.object({ id: z.uuid(), sourceRunId: z.uuid(), runId: z.uuid(), actor: z.string(), reason: z.string(), createdAt: z.string() })),
});
export type DashboardSession = z.infer<typeof sessionSchema>;
export type DashboardRepository = z.infer<typeof dashboardRepositorySchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
export type PullRequestSummary = z.infer<typeof pullRequestSummarySchema>;
export type RunDetail = z.infer<typeof runDetailSchema>;
