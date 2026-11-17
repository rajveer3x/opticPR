import { dashboardRunUrl } from '@opticpr/runtime';
import type { Finding, Report } from '@opticpr/contracts';
import type { Prisma } from '@opticpr/database';
import type { ChangedFile, GitHubPublicationClient, ReviewComment } from '@opticpr/repository';

/** Parse source coordinates, never GitHub's deprecated diff-position offsets.
 * Count both sides to reject missing/truncated patches rather than guessing. */
export function addedHeadLines(patch: string): Map<number, string> {
  const added = new Map<number, string>();
  let old = 0, head = 0, oldRemaining = 0, headRemaining = 0, seen = false, lastHead = 0;
  for (const text of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(text);
    if (header) {
      if (oldRemaining || headRemaining) return new Map();
      old = Number(header[1]); head = Number(header[3]);
      oldRemaining = header[2] === undefined ? 1 : Number(header[2]);
      headRemaining = header[4] === undefined ? 1 : Number(header[4]);
      if (![old, head, oldRemaining, headRemaining].every(Number.isSafeInteger) || head < lastHead) return new Map();
      seen = true;
      continue;
    }
    if (!seen) { if (text.startsWith('@@')) return new Map(); continue; }
    if (text === '\\ No newline at end of file') continue;
    if (!oldRemaining && !headRemaining) {
      if (text === '') continue;
      return new Map();
    }
    if (text.startsWith('+')) { added.set(head, text.slice(1)); head++; headRemaining--; }
    else if (text.startsWith('-')) { old++; oldRemaining--; }
    else if (text.startsWith(' ')) { old++; head++; oldRemaining--; headRemaining--; }
    else return new Map();
    if (oldRemaining < 0 || headRemaining < 0) return new Map();
    lastHead = head;
  }
  return oldRemaining || headRemaining ? new Map() : added;
}

export function inlineAnchor(finding: Finding, headSha: string, changes: ChangedFile[]) {
  const proof = finding.evidence;
  if (proof.revision !== headSha || proof.startLine > proof.endLine || !proof.excerpt ||
      !proof.path || proof.path.startsWith('/') || proof.path.includes('\\') || proof.path.includes('\0') ||
      proof.path.split('/').some(part => !part || part === '.' || part === '..')) return;
  const files = changes.filter(file => file.path === proof.path && file.status !== 'removed');
  if (files.length !== 1) return;
  if (addedHeadLines(files[0]!.hunk).get(proof.startLine) !== proof.excerpt.split('\n')[0]) return;
  return { path: proof.path, line: proof.startLine, side: 'RIGHT' as const };
}

export function inlineMarker(report: Report, findingId: string) {
  return `<!-- opticpr:inline:${report.input.repositoryId}:${report.input.pullRequestNumber}:${report.runId}:${findingId} -->`;
}
function safe(text: string) { return text.slice(0, 2000).replace(/[\\`*_{}[\]()<>#@!|]/g, char => `\\${char}`).replace(/[\r\n]/g, ' '); }
export function inlineBody(report: Report, finding: Finding) {
  return [inlineMarker(report, finding.id), `**${safe(finding.title)}** (${finding.severity})`, '', safe(finding.impact), '',
    `Verify: ${safe(finding.verification)}`, '', `Reviewed SHA: \`${report.input.headSha}\``, `Base: \`${report.input.baseSha}\``,
    `Run: \`${report.runId}\``, `Finding: \`${finding.id}\``,
    ...(dashboardRunUrl(report.runId) ? ['', `[Inspect evidence](${dashboardRunUrl(report.runId)}?finding=${encodeURIComponent(finding.id)})`] : [])].join('\n');
}

/** Commit with the frozen report, before any GitHub request can publish it. */
export async function inlineIntents(tx: Prisma.TransactionClient, report: Report) {
  for (const finding of report.findings) {
    const anchor = inlineAnchor(finding, report.input.headSha, report.comparison ?? []);
    const history = report.history?.findings.find(entry => entry.findingId === finding.id);
    const eligible = anchor && history?.state !== 'needs_verification' && history?.decision?.action !== 'dismiss';
    await tx.inlinePublication.upsert({ where: { runId_findingId: { runId: report.runId, findingId: finding.id } },
      create: { runId: report.runId, findingId: finding.id, marker: inlineMarker(report, finding.id), path: finding.evidence.path,
        line: anchor?.line, body: inlineBody(report, finding), state: eligible ? 'pending' : 'skipped',
        reason: eligible ? null : 'No verified current changed-line anchor or finding is unconfirmed/dismissed; evidence retained in report' }, update: {} });
  }
}

/** A copied marker, a reply or an anchor on another revision is never recovery. */
function recovered(comments: ReviewComment[], intent: { marker: string; path: string; line: number | null }, headSha: string) {
  return comments.find(comment => comment.appOwned && !comment.reply && comment.body.split('\n')[0] === intent.marker &&
    comment.originalCommitId === headSha && comment.path === intent.path && comment.originalLine === intent.line && comment.side === 'RIGHT');
}

/** Called under the same installation/PR locks as the persistent summary.
 * Returning false asks the summary writer to reconcile a newer comparison. */
export async function publishInlineComments(tx: Prisma.TransactionClient, report: Report, client: GitHubPublicationClient, guard: () => Promise<boolean>) {
  const intents = await tx.inlinePublication.findMany({ where: { runId: report.runId, state: 'pending' }, orderBy: { findingId: 'asc' } });
  if (!intents.length) return true;
  const number = report.input.pullRequestNumber;
  let comments = await client.reviewComments(number);
  const changes = await client.compare(report.input.baseSha, report.input.headSha);
  const sources = new Map<string, string>();
  for (const intent of intents) {
    const where = { runId_findingId: { runId: intent.runId, findingId: intent.findingId } };
    let remote = recovered(comments, intent, report.input.headSha);
    if (remote) {
      await tx.inlinePublication.update({ where, data: { state: 'published', commentId: remote.id, reviewId: remote.reviewId, reason: null } });
      continue;
    }
    if (intent.reviewId) throw new Error('Created review awaits comment confirmation; refusing duplicate create');
    const finding = report.findings.find(item => item.id === intent.findingId)!;
    const anchor = inlineAnchor(finding, report.input.headSha, changes);
    if (anchor && !sources.has(anchor.path)) {
      try { sources.set(anchor.path, await client.file(report.input.headSha, anchor.path)); }
      catch (error) {
        if ((error as { status?: number })?.status !== 404) throw error;
      }
    }
    const proof = finding.evidence;
    const source = sources.get(proof.path)?.split('\n');
    if (!anchor || anchor.line !== intent.line || !source || proof.endLine > source.length ||
        source.slice(proof.startLine - 1, proof.endLine).join('\n') !== proof.excerpt) {
      await tx.inlinePublication.update({ where, data: { state: 'skipped', reason: 'Current diff/source has no matching anchor; evidence retained in report' } });
      continue;
    }
    // Live revisions, desired key, current pointer and access immediately precede
    // each remote write. The explicit commit keeps even an in-flight push bound.
    if (!await guard()) return false;
    try {
      const reviewId = await client.createReview(number, report.input.headSha, { ...anchor, body: intent.body });
      await tx.inlinePublication.update({ where, data: { reviewId } });
    } catch (error) {
      // GitHub can reject a valid-looking anchor (e.g. an unavailable patch).
      // A rejected inline comment must not suppress the complete summary.
      if ((error as { status?: number })?.status !== 422) throw error;
      await tx.inlinePublication.update({ where, data: { state: 'skipped', reason: 'GitHub rejected inline anchor (422); evidence retained in report' } });
      if (!await guard()) return false;
      continue;
    }
    comments = await client.reviewComments(number);
    remote = recovered(comments, intent, report.input.headSha);
    if (!remote) throw new Error('Review comment confirmation unavailable; reconcile before retry');
    await tx.inlinePublication.update({ where, data: { state: 'published', commentId: remote.id, reviewId: remote.reviewId, reason: null } });
    if (!await guard()) return false;
  }
  return true;
}
