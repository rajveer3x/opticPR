import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FolderGit2,
  GitPullRequest,
  Search,
  RefreshCw,
  ShieldCheck,
  Workflow,
} from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { SignalScene, SignalMarquee, useCardTilt } from './motion';
import { api, isActive, usePullRequests } from './api';
import {
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

export function Repositories() {
  const tilt = useCardTilt();
  const query = api.useRepositoriesQuery(undefined, {
    refetchOnMountOrArgChange: true,
    refetchOnFocus: true,
  });
  const [search, setSearch] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (
        event.key === '/' &&
        !(
          event.target instanceof HTMLElement &&
          (event.target.matches('input, textarea, select') ||
            event.target.isContentEditable)
        )
      ) {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);
  if (query.isLoading) return <Loading />;
  if (query.error || !query.data)
    return <Failure error={query.error} retry={() => void query.refetch()} />;
  const { repositories, installationUrl } = query.data;
  const filtered = repositories.filter((repo) =>
    `${repo.owner}/${repo.name}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="workspace-hero">
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="live-dot" />
            YOUR WORKSPACE. REIMAGINED.
          </span>
          <p className="display-heading">
            <span className="text-reveal">CODE IN</span>
            <span className="text-reveal accent-text">CLEAR SIGHT.</span>
          </p>
          <p className="hero-description">
            Every commit has a story.
            <br />
            See the signal. Follow the evidence.
          </p>
          <a className="button chrome-button" href="#repositories">
            Explore your repositories
            <ArrowUpRight size={17} />
          </a>
          <span className="hero-footnote">
            CONNECTED TO GITHUB / BUILT FOR WHAT’S NEXT
          </span>
        </div>
        <SignalScene compact />
        <span className="hero-index">01 — WORKSPACE</span>
      </div>
      <SignalMarquee />
      <section id="repositories" className="repository-section" data-reveal>
        <div className="section-kicker">
          <span>YOUR SOURCE. YOUR SPACE.</span>
          <span>01 / REPOSITORIES</span>
        </div>
        <div className="page-heading">
          <div>
            <h1>
              Repositories
              <span className="heading-count">
                {repositories.length.toString().padStart(2, '0')}
              </span>
            </h1>
            <p className="muted">The starting point for a sharper review.</p>
          </div>
          {installationUrl && (
            <External href={installationUrl}>
              <GithubIcon />
              Manage installation
            </External>
          )}
        </div>
        <div className="overview-band">
          <div>
            <span className="overview-icon">
              <FolderGit2 size={19} />
            </span>
            <span>
              <strong>{repositories.length}</strong>
              <small>Connected repositories</small>
            </span>
          </div>
          <div>
            <span className="overview-icon green">
              <ShieldCheck size={19} />
            </span>
            <span>
              <strong>
                {repositories.filter((repo) => repo.canPublish).length}
              </strong>
              <small>Publishing permission granted</small>
            </span>
          </div>
          <p>
            <span className="live-dot" />
            Synced with your GitHub access
          </p>
        </div>
        <div className="section-toolbar">
          <div>
            <h2>Connected repositories</h2>
            <span className="muted">
              Selected installations · current access only
            </span>
          </div>
          <label className="search-box">
            <Search size={16} />
            <input
              ref={searchInput}
              aria-label="Find a repository"
              placeholder="Find a repository…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <kbd>/</kbd>
          </label>
        </div>
        {!repositories.length ? (
          <Empty
            title="Your workspace is ready for its first repository"
            icon="shield"
          >
            <p>
              Install the GitHub App on a repository you can access, then return
              here. If access was removed, ask a maintainer to restore it.
            </p>
            {installationUrl && (
              <External href={installationUrl}>Connect a repository</External>
            )}
            <button
              className="text-button"
              onClick={() => void query.refetch()}
            >
              Refresh access
            </button>
          </Empty>
        ) : !filtered.length ? (
          <Empty title="No matching repositories">
            <p>Try a different repository or owner name.</p>
            <button className="text-button" onClick={() => setSearch('')}>
              Clear search
            </button>
          </Empty>
        ) : (
          <div className="repository-grid">
            {filtered.map((repo, index) => (
              <Link
                className="repository-card"
                {...tilt}
                data-reveal
                to={`/repos/${repo.id}`}
                key={repo.id}
              >
                <div className="repo-card-top">
                  <span className="repo-index">
                    /{String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="repository-icon">
                    <FolderGit2 size={23} />
                  </span>
                  <span className="role-badge">
                    {repo.role === 'maintainer' ? 'Maintainer' : 'Member'}
                  </span>
                </div>
                <span className="repo-owner">{repo.owner}</span>
                <h2>
                  {repo.name}
                  <ArrowUpRight size={18} />
                </h2>
                <p className="repo-installation">
                  Installation <code>#{repo.installationId}</code>
                </p>
                <div className="repo-card-bottom">
                  <span className={repo.canPublish ? 'publish-ready' : 'muted'}>
                    {repo.canPublish ? (
                      <Check size={13} />
                    ) : (
                      <Workflow size={13} />
                    )}{' '}
                    {repo.canPublish
                      ? 'Review publishing permitted'
                      : 'Read access · publishing unavailable'}
                  </span>
                  <span title="Last accepted pull request event">
                    <Clock3 size={12} />
                    {when(repo.lastEventAt)}
                  </span>
                </div>
                <span className="repo-open">
                  Explore reviews
                  <ArrowRight size={14} />
                </span>
              </Link>
            ))}
          </div>
        )}
        <div className="access-note">
          <ShieldCheck size={16} />
          <p>
            Your workspace reflects the intersection of your GitHub access and
            the App’s selected repositories.
          </p>
        </div>
      </section>
      <section className="workflow-section" data-reveal>
        <div className="section-kicker">
          <span>FROM COMMIT TO CLARITY.</span>
          <span>THE PROCESS /</span>
        </div>
        <div className="workflow-grid">
          <div>
            <span>01 / CONNECT</span>
            <h2>
              Your code.
              <br />
              Your permissions.
            </h2>
            <p>Only the repositories you and the App can access.</p>
          </div>
          <div>
            <span>02 / REVIEW</span>
            <h2>
              Find the signal.
              <br />
              Keep the context.
            </h2>
            <p>Source-linked findings with explicit stage outcomes.</p>
          </div>
          <div>
            <span>03 / TRACE</span>
            <h2>
              Every revision.
              <br />A clearer picture.
            </h2>
            <p>Follow evidence and reviewer decisions across commits.</p>
          </div>
        </div>
      </section>
    </>
  );
}
function GithubIcon() {
  return <Workflow size={15} />;
}
export function PullRequests() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get('page') ?? 1);
  const page = Number.isSafeInteger(raw) && raw > 0 ? raw : 1;
  const query = usePullRequests(id, page);
  if (query.isLoading || (!query.currentData && !query.error))
    return <Loading label="Loading pull requests" />;
  if (query.error || !query.currentData)
    return <Failure error={query.error} retry={() => void query.refetch()} />;
  const { repository, items, total, pageSize } = query.currentData;
  return (
    <>
      <Breadcrumb repository={repository} />
      <div className="page-heading">
        <div>
          <span className="eyebrow">
            {repository.owner.toUpperCase()} / REPOSITORY
          </span>
          <h1>{repository.name}</h1>
          <p className="muted">
            Pull requests received by OpticPR. Their latest targets and review
            evidence.
          </p>
        </div>
        <External
          href={`https://github.com/${repository.owner}/${repository.name}`}
        >
          View repository
        </External>
      </div>
      <div className="list-heading">
        <div className="list-title">
          <GitPullRequest size={18} />
          <h2>Pull requests</h2>
          <span className="count-badge">{total}</span>
        </div>
        <button
          className="button secondary compact"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={14} />
          {query.isFetching ? 'Refreshing…' : 'Refresh pull requests'}
        </button>
      </div>
      {!items.length ? (
        <Empty
          title={
            total
              ? 'No pull requests on this page'
              : 'A fresh start, ready for review'
          }
        >
          <p>
            {total
              ? 'Return to the first page to see available reviews.'
              : 'Reviews will appear here after OpticPR receives an eligible pull request event. Existing GitHub pull requests are not imported automatically; push a commit or reopen a ready pull request to trigger a review.'}
          </p>
          {total > 0 && (
            <button
              className="button secondary"
              onClick={() => setParams({ page: '1' })}
            >
              First page
            </button>
          )}
        </Empty>
      ) : (
        <div className="pr-table-wrap">
          <table className="pr-table">
            <thead>
              <tr>
                <th>Pull request</th>
                <th>Target / reviewed</th>
                <th>Review status</th>
                <th>
                  <span className="sr-only">Open review</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((pr) => {
                const target = pr.desiredRun;
                const latest = pr.latestRun;
                const link = latest?.id ?? target?.id;
                return (
                  <tr key={pr.number}>
                    <td>
                      <div className="pr-title">
                        <GitPullRequest size={17} />
                        <div>
                          {link ? (
                            <Link to={`/runs/${link}`}>{pr.title}</Link>
                          ) : (
                            <span>{pr.title}</span>
                          )}
                          <span>
                            #{pr.number} <span className="dot-divider">·</span>{' '}
                            Updated {when(pr.updatedAt)}
                            {!pr.eligible && ' · Closed, draft, or unavailable'}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="pr-revisions">
                        <span>
                          <small>Target</small>
                          <code title={pr.headSha}>{shortSha(pr.headSha)}</code>
                        </span>
                        <span>
                          <small>Reviewed</small>
                          {latest ? (
                            <code title={latest.headSha}>
                              {shortSha(latest.headSha)}
                            </code>
                          ) : (
                            <span className="muted">Not yet reviewed</span>
                          )}
                        </span>
                      </div>
                    </td>
                    <td>
                      <Status
                        value={
                          isActive(target)
                            ? target!.state
                            : target?.state === 'failed' ||
                                target?.state === 'cancelled'
                              ? target.state
                              : (latest?.coverage ?? target?.state ?? 'queued')
                        }
                      />
                      {latest && (
                        <span className="table-subtext">
                          {latest.findings} finding
                          {latest.findings === 1 ? '' : 's'} ·{' '}
                          {pr.publicationState ?? 'Not published'}
                        </span>
                      )}
                    </td>
                    <td>
                      {link && (
                        <Link
                          className="row-arrow"
                          to={`/runs/${link}`}
                          aria-label={`Open review for PR #${pr.number}`}
                        >
                          <ArrowRight size={18} />
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {total > 0 && (
        <div className="pagination">
          <span>
            Showing {Math.min((page - 1) * pageSize + 1, total)}–
            {Math.min(page * pageSize, total)} of {total} pull requests
          </span>
          <div>
            <button
              className="button secondary compact"
              disabled={page <= 1 || query.isFetching}
              onClick={() => setParams({ page: String(page - 1) })}
            >
              <ChevronLeft size={14} />
              Previous
            </button>
            <span>Page {page}</span>
            <button
              className="button secondary compact"
              disabled={page * pageSize >= total || query.isFetching}
              onClick={() => setParams({ page: String(page + 1) })}
            >
              Next
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
      <div className="access-note">
        <Revision
          base={items[0]?.baseSha ?? '—'}
          head={items[0]?.headSha ?? '—'}
        />
        <p>
          Summaries stay available while the latest target is being reviewed.
          Open a review to explore revision history.
        </p>
      </div>
    </>
  );
}
