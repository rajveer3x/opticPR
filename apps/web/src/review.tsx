import { useState, type ReactNode } from 'react';
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  CircleDashed,
  Code2,
  FileCode2,
  Files,
  GitBranch,
  GitPullRequest,
  History,
  RotateCcw,
  ScanLine,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import type {
  Finding,
  FindingHistoryEntry,
  Report,
  RunDetail,
} from '@opticpr/contracts';
import { api, isActive, useRun } from './api';
import {
  ActionDialog,
  Breadcrumb,
  Empty,
  External,
  Failure,
  Loading,
  Revision,
  Status,
  shortSha,
  when,
} from './components';

export function Review() {
  const { id = '' } = useParams();
  const query = useRun(id);
  if (query.isLoading || (!query.currentData && !query.error))
    return <Loading label="Opening the review snapshot" />;
  if (query.error || !query.currentData)
    return <Failure error={query.error} retry={() => void query.refetch()} />;
  return <ReviewContent key={id} data={query.currentData} />;
}
type ReviewViewData = Omit<RunDetail, 'repository'> & { repository: RunDetail['repository'] | null };
type DemoView = { title: string; revisions: Record<string, string>; caller: ReactNode };

export function ReviewContent({ data, demo }: { data: ReviewViewData; demo?: DemoView }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState('all');
  const [retryOpen, setRetryOpen] = useState(false);
  const [retry, retryState] = api.useRetryMutation();
  const [notice, setNotice] = useState('');
  const { repository, pullRequest: pr, report } = data;
  const maintainer = repository?.role === 'maintainer';
  const changeRevision = (id: string) => navigate(
    `${demo ? '/demo/runs' : '/runs'}/${id}${params.get('finding') ? `?finding=${params.get('finding')}` : ''}`,
  );
  const otherDemoRevision = demo && data.revisions.find(run => run.id !== data.id);
  const entries =
    report?.history?.findings ??
    report?.findings.map((finding) => ({
      findingId: finding.id,
      state: 'new' as const,
      reason: 'First observation in this review.',
      observation: finding,
      lastObservation: finding,
      lastObservedRunId: data.id,
      lastObservedConfigurationDigest: data.configurationDigest,
    })) ??
    [];
  const filtered = entries.filter(
    (entry) => filter === 'all' || entry.state === filter,
  );
  const selected =
    filtered.find((entry) => entry.findingId === params.get('finding')) ??
    filtered[0];
  const activeTarget = pr?.eligible && isActive(pr.desiredRun);
  return (
    <>
      {repository && <Breadcrumb repository={repository} number={pr?.number} />}
      <div className="page-heading review-page-heading">
        <div>
          <div className="review-eyebrow">
            <span className="eyebrow">{demo ? 'SYNTHETIC REPOSITORY' : 'PULL REQUEST REVIEW'}</span>
            {pr && (
              <span className="pr-number">
                <GitPullRequest size={12} />#{pr.number}
              </span>
            )}
          </div>
          <h1>{demo?.title ?? pr?.title ?? 'Review snapshot'}</h1>
          <p className="muted">
            <span className="inline-repo">
              {repository ? `${repository.owner}/${repository.name}` : data.report?.input.repositoryId}
            </span>
            {!demo && <><span className="dot-divider">·</span>{when(data.createdAt)}<span className="dot-divider">·</span>Attempt {data.attempt + 1}</>}
          </p>
        </div>
        <div className="actions">
          {maintainer && ['completed', 'failed'].includes(data.state) && (
            <button
              className="button secondary"
              disabled={retryState.isLoading || !!activeTarget}
              onClick={() => setRetryOpen(true)}
            >
              <RotateCcw size={14} />
              Retry review
            </button>
          )}
          {demo && otherDemoRevision && <button className="button secondary" onClick={() => changeRevision(otherDemoRevision.id)}>
            View {demo.revisions[otherDemoRevision.id]?.toLowerCase()} <ArrowRight size={14} />
          </button>}
          {pr && repository && (
            <External
              href={`https://github.com/${repository.owner}/${repository.name}/pull/${pr.number}`}
            >
              Open in GitHub
            </External>
          )}
        </div>
      </div>
      <div className="revision-bar">
        <div>
          <span className="eyebrow">REVIEWED COMPARISON</span>
          <Revision base={data.baseSha} head={data.headSha} />
        </div>
        <div className="revision-select-wrap">
          <History size={15} />
          <label htmlFor="revision-select">Revision</label>
          <select
            id="revision-select"
            value={data.id}
            onKeyDown={(event) => {
              if (
                event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
              )
                return;
              event.preventDefault();
              const current = data.revisions.findIndex(
                (run) => run.id === data.id,
              );
              const index =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? data.revisions.length - 1
                    : Math.max(
                        0,
                        Math.min(
                          data.revisions.length - 1,
                          current + (event.key === 'ArrowDown' ? 1 : -1),
                        ),
                      );
              const next = data.revisions[index];
              if (next && next.id !== data.id) changeRevision(next.id);
            }}
            onChange={(event) => changeRevision(event.target.value)}
          >
            {data.revisions.map((run) => (
              <option value={run.id} key={run.id}>
                {demo ? `${demo.revisions[run.id]} · ${shortSha(run.headSha)}` : <>{shortSha(run.baseSha)} → {shortSha(run.headSha)} · Attempt{' '}
                  {run.attempt + 1} · {when(run.createdAt)} · {run.state}</>}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </div>
      </div>
      {pr &&
        (pr.headSha !== data.headSha ||
          pr.baseSha !== data.baseSha ||
          (activeTarget && pr.desiredRun?.id !== data.id)) && (
          <div className="target-notice">
            <GitBranch size={17} />
            <div>
              <strong>
                {activeTarget
                  ? 'A new review is in progress'
                  : 'You’re viewing an earlier review'}
              </strong>
              <span>
                Latest target <Revision base={pr.baseSha} head={pr.headSha} />
                {activeTarget && <Status value={pr.desiredRun!.state} />}
              </span>
            </div>
            {pr.desiredRun && pr.desiredRun.id !== data.id && (
              <Link to={`/runs/${pr.desiredRun.id}`} className="text-button">
                View target
                <ArrowRight size={14} />
              </Link>
            )}
          </div>
        )}
      {notice && (
        <div className="success-notice" role="status">
          <Check size={15} />
          {notice}
        </div>
      )}
      {report ? (
        <>
          <Coverage report={report} />
          <div className="findings-heading">
            <div>
              <h2>
                Review findings{' '}
                <span className="count-badge">{entries.length}</span>
              </h2>
              <p className="muted">Claims and their evidence, side by side.</p>
            </div>
            {!demo && <span className="read-only-note">
              <ShieldCheck size={13} />
              {maintainer ? 'Maintainer access' : 'Member · read access'}
            </span>}
          </div>
          {entries.length ? (
            <div className="review-workspace">
              <aside className="findings-panel" aria-label="Findings">
                <div className="finding-filters" aria-label="Filter findings">
                  {[
                    ['all', 'All findings'],
                    ['new', 'New'],
                    ['still_present', 'Still present'],
                    ['needs_verification', 'Needs verification'],
                    ['cleared_by_recheck', 'Cleared'],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      aria-pressed={filter === value}
                      className={filter === value ? 'selected' : ''}
                      onClick={() => setFilter(value!)}
                    >
                      {label}
                      <span>
                        {value === 'all'
                          ? entries.length
                          : entries.filter((entry) => entry.state === value)
                              .length}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="finding-list">
                  {filtered.length ? (
                    filtered.map((entry, index) => {
                      const finding =
                        entry.observation ?? entry.lastObservation;
                      return (
                        <button
                          key={entry.findingId}
                          className={`finding-item ${entry.findingId === selected?.findingId ? 'selected' : ''}`}
                          onClick={() =>
                            setParams({ finding: entry.findingId })
                          }
                          aria-pressed={entry.findingId === selected?.findingId}
                        >
                          <span className="finding-item-top">
                            <span className="finding-index">
                              {String(index + 1).padStart(2, '0')}
                            </span>
                            <Status value={entry.state} />
                          </span>
                          <strong>{finding.title}</strong>
                          <span className="finding-item-path">
                            <FileCode2 size={12} />
                            {finding.evidence.path}
                          </span>
                          <span className="finding-item-bottom">
                            <span
                              className={`severity-dot ${finding.severity}`}
                            />
                            {finding.severity} severity
                            <span className="dot-divider">·</span>
                            {entry.observation
                              ? `Line ${finding.evidence.startLine}`
                              : 'Prior evidence'}
                          </span>
                        </button>
                      );
                    })
                  ) : (
                    <div className="filter-empty">
                      No findings in this category.
                    </div>
                  )}
                </div>
                <div className="findings-panel-footer">
                  <BookOpen size={13} />
                  Every claim is bound to a revision.
                </div>
              </aside>
              <section className="evidence-panel" aria-label="Finding evidence">
                {selected ? (
                  <FindingDetail
                    key={selected.findingId}
                    entry={selected}
                    data={data}
                    notify={setNotice}
                    demo={demo}
                  />
                ) : (
                  <Empty title="Nothing in this view">
                    <p>Select another finding category.</p>
                  </Empty>
                )}
              </section>
            </div>
          ) : (
            <Empty
              title={
                report.coverage.status === 'complete' &&
                report.stages.every(
                  (stage) => !['failed', 'partial'].includes(stage.status),
                )
                  ? 'A clear review, within the analyzed scope'
                  : 'No findings confirmed in this scan'
              }
            >
              <p>
                {report.coverage.analyzedFiles.length} file
                {report.coverage.analyzedFiles.length === 1 ? '' : 's'} analyzed ·{' '}
                {report.coverage.skippedFiles.length} skipped.
              </p>
              <p>
                {report.coverage.status === 'complete'
                  ? 'No findings were reported by the completed checks. See the stage outcomes for the scope of this review.'
                  : 'Coverage is incomplete. Check the skipped files and stage outcomes before treating this as a clean review.'}
              </p>
            </Empty>
          )}
        </>
      ) : (
        <div className="pending-report">
          <span className="pending-icon">
            {isActive(data) ? (
              <ScanLine size={30} />
            ) : (
              <AlertCircle size={30} />
            )}
          </span>
          <Status value={data.state} />
          <h2>
            {isActive(data)
              ? 'Bringing this revision into focus'
              : data.state === 'cancelled'
                ? 'This review was cancelled'
                : 'This review couldn’t finish'}
          </h2>
          <p className="muted">
            {isActive(data)
              ? 'The worker is preparing the source and analysis. This page updates automatically until the review finishes.'
              : (data.error ?? 'No report is available for this attempt.')}
          </p>
          {pr?.latestRunId && pr.latestRunId !== data.id && (
            <Link className="button secondary" to={`/runs/${pr.latestRunId}`}>
              Read the latest completed summary
              <ArrowRight size={14} />
            </Link>
          )}
        </div>
      )}
      {data.retries.length > 0 && (
        <details className="coverage-details retry-history">
          <summary>
            <History size={15} />
            Retry history<span>{data.retries.length} recorded</span>
            <ChevronDown size={15} />
          </summary>
          <div className="retry-history-body">
            {data.retries.map((item) => (
              <div key={item.id}>
                <strong>{item.actor} requested a fresh attempt</strong>
                <time>{when(item.createdAt)}</time>
                <p>{item.reason}</p>
                <Link className="text-button" to={`/runs/${item.runId}`}>
                  Open attempt
                  <ArrowRight size={13} />
                </Link>
              </div>
            ))}
          </div>
        </details>
      )}
      <div className="run-footnote">
        <code>Run {data.id}</code>
        <span>
          Configuration{' '}
          <code title={data.configurationDigest}>
            {data.configurationDigest.slice(0, 12)}
          </code>
        </span>
      </div>
      {retryOpen && (
        <ActionDialog
          title="Run a fresh review"
          description="Use the same revision and analysis configuration. This report and its evidence will remain available."
          label="Queue review"
          close={() => setRetryOpen(false)}
          submit={async (reason, id) => {
            await retry({ runId: data.id, reason, id }).unwrap();
            setNotice(
              'A fresh review is queued. Your selected revision has been preserved.',
            );
          }}
        />
      )}
    </>
  );
}
function Coverage({ report }: { report: Report }) {
  const analyzedFiles = [...new Set([...report.coverage.analyzedFiles, ...(report.crossFileRecheck?.callers ?? [])])];
  return (
    <section
      className={`coverage-card coverage-${report.coverage.status}`}
      aria-label="Review coverage"
    >
      <div className="coverage-overview">
        <div className="coverage-title">
          <span className="coverage-icon">
            {report.coverage.status === 'complete' ? (
              <ShieldCheck size={23} />
            ) : (
              <CircleDashed size={23} />
            )}
          </span>
          <div>
            <Status value={report.coverage.status} />
            <p>
              {report.coverage.status === 'complete'
                ? 'The analyzed scope is fully accounted for.'
                : report.coverage.status === 'partial'
                  ? 'Some checks or files need a closer look.'
                  : 'Analysis coverage could not be established.'}
            </p>
          </div>
        </div>
        <div className="coverage-metrics">
          <div>
            <strong>
              {analyzedFiles.length.toString().padStart(2, '0')}
            </strong>
            <span>Files analyzed</span>
          </div>
          <div>
            <strong>
              {report.coverage.skippedFiles.length.toString().padStart(2, '0')}
            </strong>
            <span>Files skipped</span>
          </div>
          <div>
            <strong>
              {report.findings.length.toString().padStart(2, '0')}
            </strong>
            <span>Findings observed</span>
          </div>
        </div>
      </div>
      <div className="stage-strip">
        {report.stages.map((stage) => (
          <div key={stage.name}>
            {stage.name === 'model' ? (
              <Sparkles size={14} />
            ) : stage.name === 'repository' ? (
              <Files size={14} />
            ) : (
              <ScanLine size={14} />
            )}
            <span>
              {stage.name === 'semgrep'
                ? 'Static analysis'
                : stage.name === 'cross-file'
                  ? 'TypeScript caller analysis'
                : stage.name === 'model'
                  ? 'Model analysis'
                  : stage.name === 'repository'
                    ? 'Source retrieval'
                    : 'Analysis'}
            </span>
            <Status value={stage.status} />
          </div>
        ))}
      </div>
      <details className="coverage-details">
        <summary>
          <span>Coverage & stage details</span>
          <ChevronDown size={14} />
        </summary>
        <div className="coverage-body">
          <p>{report.coverage.detail}</p>
          <div className="stage-details">
            {report.stages.map((stage) => (
              <div key={stage.name}>
                <strong>{stage.name === 'cross-file' ? 'TypeScript caller analysis' : stage.name}</strong>
                <code>{stage.version}</code>
                <p>{stage.detail}</p>
              </div>
            ))}
          </div>
          {report.coverage.skippedFiles.length > 0 && (
            <>
              <h3>Skipped files</h3>
              <ul className="skipped-files">
                {report.coverage.skippedFiles.map((file, index) => (
                  <li key={`${file.path}-${index}`}>
                    <code>{file.path}</code>
                    <span>{file.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3>Analyzed files</h3>
          {analyzedFiles.length ? (
            <ul className="analyzed-files">
              {analyzedFiles.map((path) => (
                <li key={path}>
                  <FileCode2 size={12} />
                  <code>{path}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p>No files were analyzed.</p>
          )}
        </div>
      </details>
    </section>
  );
}
const evidenceLabels = {
  'changed-throw': 'Changed throw',
  'caller-fallback': 'Caller fallback',
  'base-return': 'Previous return',
};

function FindingDetail({
  entry,
  data,
  notify,
  demo,
}: {
  entry: FindingHistoryEntry;
  data: ReviewViewData;
  notify: (message: string) => void;
  demo?: DemoView;
}) {
  const finding = entry.observation ?? entry.lastObservation;
  const citations = finding.citations?.length
    ? finding.citations
    : [
        {
          kind: finding.identity?.kind ?? 'static',
          ruleId: finding.ruleId,
          evidence: finding.evidence,
          role: undefined,
        },
      ];
  const [citation, setCitation] = useState(0);
  const proof = citations[citation] ?? citations[0]!;
  const [action, setAction] = useState<'dismiss' | 'reopen'>();
  const [decide] = api.useDecideMutation();
  const decisions = data.decisions.filter(
    (item) => item.findingId === entry.findingId,
  );
  const latestDecision = decisions.at(-1) ?? entry.decision;
  const confirmed = !!entry.observation && entry.state !== 'needs_verification';
  const canDecide =
    data.repository?.role === 'maintainer' &&
    data.state === 'completed' &&
    confirmed;
  const { repository } = data;
  const evidence = proof.evidence;
  const evidenceUrl = repository && `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/blob/${evidence.revision}/${evidence.path.split('/').map(encodeURIComponent).join('/')}#L${evidence.startLine}-L${evidence.endLine}`;
  return (
    <>
      <div className="finding-detail-heading">
        <div className="finding-badges">
          <Status value={finding.severity} />
          <Status value={entry.state} />
          {confirmed && latestDecision && (
            <Status value={latestDecision.action} />
          )}
        </div>
        <h2>{finding.title}</h2>
        <p className="finding-reason">{entry.reason}</p>
      </div>
      {!entry.observation && (
        <div className="prior-evidence-notice">
          <History size={15} />
          <span>
            Retained evidence from <code>{shortSha(finding.evidence.revision)}</code>.
            This is a prior observation, not a confirmed finding on the selected
            revision.
          </span>
        </div>
      )}
      <div className="source-header">
        <div>
          <Code2 size={15} />
          <span>Source evidence</span>
        </div>
        <span>
          {citations.length} source{citations.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="source-tabs" aria-label="Evidence sources">
        {citations.map((item, index) => (
          <button
            key={`${item.kind}-${index}`}
            aria-pressed={index === citation}
            className={citation === index ? 'selected' : ''}
            onClick={() => setCitation(index)}
          >
            {item.kind === 'model' ? (
              <Sparkles size={13} />
            ) : (
              <ScanLine size={13} />
            )}{' '}
            {item.role ? evidenceLabels[item.role] : item.kind === 'static'
              ? 'Static rule'
              : item.kind === 'model'
                ? 'Model observation'
                : 'Fixture rule'}
            {!item.role && <code>{item.ruleId}</code>}
          </button>
        ))}
      </div>
      <SourceExcerpt evidence={evidence} side={proof.role === 'base-return' ? 'base' : 'head'} url={evidenceUrl || undefined} />
      <div className="finding-explanation">
        <Explanation icon={<AlertCircle size={16} />} title="Why it matters">
          <p>{finding.impact}</p>
        </Explanation>
        <Explanation icon={<Check size={16} />} title="How to verify">
          <p>{finding.verification}</p>
        </Explanation>
        <details className="excerpt-details">
          <summary>
            Exact source excerpt
            <ChevronDown size={13} />
          </summary>
          <pre>{evidence.excerpt}</pre>
        </details>
      </div>
      {demo?.caller}
      {entry.previous && (
        <Link
          className="prior-observation"
          to={`${demo ? '/demo/runs' : '/runs'}/${entry.previous.runId}?finding=${entry.previous.findingId}`}
        >
          <History size={17} />
          <span>
            <strong>Previous observation</strong>
            <small>Follow the evidence across revisions</small>
          </span>
          <ArrowRight size={16} />
        </Link>
      )}
      {!demo && <section className="decision-section">
        <div className="decision-heading">
          <h3>
            <History size={15} />
            Decision history
          </h3>
          {canDecide && (
            <button
              className="button secondary compact"
              onClick={() =>
                setAction(
                  latestDecision?.action === 'dismiss' ? 'reopen' : 'dismiss',
                )
              }
            >
              {latestDecision?.action === 'dismiss' ? (
                <RotateCcw size={13} />
              ) : (
                <ShieldCheck size={13} />
              )}{' '}
              {latestDecision?.action === 'dismiss'
                ? 'Reopen finding'
                : 'Dismiss finding'}
            </button>
          )}
        </div>
        {decisions.length ? (
          <ol className="decision-timeline">
            {decisions.map((item) => (
              <li key={item.id}>
                <span className="timeline-dot" />
                <div>
                  <strong>{item.actor}</strong>{' '}
                  <span>
                    {item.action === 'dismiss' ? 'dismissed' : 'reopened'} this
                    finding
                  </span>
                  <time dateTime={item.createdAt}>{when(item.createdAt)}</time>
                  <p>{item.reason}</p>
                  <Link to={`/runs/${item.runId}?finding=${item.findingId}`}>
                    View decision revision
                  </Link>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="decision-empty">
            No reviewer decisions yet.{' '}
            {data.repository?.role === 'member'
              ? 'Maintainers can record a reasoned dismissal or reopening.'
              : !confirmed
                ? 'Decisions require a confirmed observation.'
                : 'Any decision will be recorded here with its reason.'}
          </p>
        )}
      </section>}
      {action && (
        <ActionDialog
          title={
            action === 'dismiss'
              ? 'Dismiss this finding'
              : 'Reopen this finding'
          }
          description="Your decision is recorded separately from the analysis, with your identity, reason, and the selected revision."
          label={action === 'dismiss' ? 'Dismiss finding' : 'Reopen finding'}
          close={() => setAction(undefined)}
          submit={async (reason, id) => {
            await decide({
              runId: data.id,
              findingId: entry.findingId,
              id,
              action,
              reason,
            }).unwrap();
            notify(
              action === 'dismiss'
                ? 'Finding dismissed. Your reason is saved in the decision history.'
                : 'Finding reopened. Your reason is saved in the decision history.',
            );
          }}
        />
      )}
    </>
  );
}
export function SourceExcerpt({ evidence, url, side = 'head' }: {
  evidence: Finding['evidence']; url?: string; side?: 'base' | 'head';
}) {
  return (
    <div className="code-viewer">
      <div className="code-toolbar">
        <span><FileCode2 size={14} />{evidence.path}</span>
        <code title={evidence.revision}>{shortSha(evidence.revision)} · L{evidence.startLine}–{evidence.endLine}</code>
      </div>
      <Diff hunk={evidence.hunk} evidence={evidence} side={side} />
      {url && <div className="code-footer">
        <span><span className="evidence-indicator" />Finding evidence at the cited revision</span>
        <External href={url} className="source-link">View source</External>
      </div>}
    </div>
  );
}
function Explanation({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="explanation">
      <h3>
        {icon}
        {title}
      </h3>
      {children}
    </div>
  );
}
export function Diff({
  hunk,
  evidence,
  side = 'head',
}: {
  hunk: string;
  evidence: Finding['evidence'];
  side?: 'base' | 'head';
}) {
  let oldLine = 0;
  let headLine = 0;
  const lines = hunk ? hunk.split('\n') : evidence.excerpt.split('\n');
  const rows = lines.map((line, index) => {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      headLine = Number(header[2]);
      return (
        <div className="diff-line diff-hunk" key={index}>
          <span />
          <span />
          <code>{line}</code>
        </div>
      );
    }
    if (!hunk) {
      const number = evidence.startLine + index;
      return (
        <div className="diff-line diff-evidence" key={index}>
          <span>{side === 'base' ? number : null}</span>
          <span>{side === 'head' ? number : null}</span>
          <code>{line || ' '}</code>
        </div>
      );
    }
    if (
      line.startsWith('\\') ||
      line.startsWith('+++') ||
      line.startsWith('---') ||
      (!line.startsWith(' ') && !line.startsWith('+') && !line.startsWith('-'))
    )
      return (
        <div className="diff-line diff-meta" key={index}>
          <span />
          <span />
          <code>{line || ' '}</code>
        </div>
      );
    const removed = line.startsWith('-');
    const added = line.startsWith('+');
    const currentHead = removed ? null : headLine++;
    const currentOld = added ? null : oldLine++;
    const highlighted =
      currentHead !== null &&
      currentHead >= evidence.startLine &&
      currentHead <= evidence.endLine;
    return (
      <div
        className={`diff-line ${removed ? 'diff-removed' : added ? 'diff-added' : ''} ${highlighted ? 'diff-evidence' : ''}`}
        key={index}
      >
        <span>{currentOld}</span>
        <span>{currentHead}</span>
        <code>
          <b>{line[0]}</b>
          {line.slice(1) || ' '}
        </code>
      </div>
    );
  });
  return (
    <div
      className="diff-scroll"
      tabIndex={0}
      role="region"
      aria-label={`${hunk ? 'Source hunk' : 'Source excerpt'} at ${shortSha(evidence.revision)}. Evidence at ${side} lines ${evidence.startLine} to ${evidence.endLine}`}
    >
      <div className="diff-lines">{rows}</div>
    </div>
  );
}
