import { useState } from 'react';
import { MotionToggle, PageMotion, SignalScene, SignalMarquee } from './motion';
import { useSelector } from 'react-redux';
import {
  ArrowRight,
  ArrowUpRight,
  GitFork as Github,
  LogOut,
  Menu,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, errorMessage, store } from './api';
import { Loading, Mark } from './components';
import { Repositories, PullRequests } from './repositories';
import { Review } from './review';

export function App() {
  const expired = useSelector(
    (state: ReturnType<typeof store.getState>) => state.auth.expired,
  );
  const session = api.useSessionQuery(undefined, { refetchOnFocus: true });
  const [logout, logoutState] = api.useLogoutMutation();
  const [mobileOpen, setMobileOpen] = useState(false);
  if (session.isLoading)
    return (
      <div className="app-boot">
        <Mark />
        <Loading label="Opening your workspace" />
      </div>
    );
  if (expired || session.error || !session.data)
    return (
      <PageMotion fullBleed>
        <SignIn error={session.error} retry={() => void session.refetch()} />
      </PageMotion>
    );
  return (
    <div className="app-layout">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <Link className="brand" to="/repos" aria-label="OpticPR home">
          <Mark />
          optic<span>pr</span>
          <span className="brand-period">✳</span>
        </Link>
        <nav
          aria-label="Main navigation"
          className={`main-nav ${mobileOpen ? 'is-open' : ''}`}
        >
          <Link
            className="nav-item active"
            to="/repos"
            onClick={() => setMobileOpen(false)}
          >
            <span>01</span> Workspace <ArrowUpRight size={13} />
          </Link>
          <a
            className="nav-item"
            href="https://github.com/apps"
            target="_blank"
            rel="noreferrer"
          >
            <span>02</span> GitHub Apps <ArrowUpRight size={13} />
          </a>
        </nav>
        <div className="header-controls">
          <MotionToggle />
          <div className="header-account">
            <span className="live-dot" />
            <span>{session.data.user.login}</span>
            <span className="avatar">
              {session.data.user.login.slice(0, 2).toUpperCase()}
            </span>
            <button
              className="icon-button"
              aria-label="Sign out"
              title="Sign out"
              disabled={logoutState.isLoading}
              onClick={async () => {
                try {
                  await logout().unwrap();
                  store.dispatch(api.util.resetApiState());
                  window.location.assign('/');
                } catch {
                  /* Retain session when logout fails. */
                }
              }}
            >
              <LogOut size={15} />
            </button>
          </div>
          <button
            className="mobile-menu icon-button"
            aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen(!mobileOpen)}
          >
            {mobileOpen ? <X /> : <Menu />}
          </button>
        </div>
      </header>
      {logoutState.error && (
        <p role="alert" className="global-error">
          {errorMessage(logoutState.error)}
        </p>
      )}
      <div className="workspace">
        <main id="main">
          <PageMotion>
            <Routes>
              <Route path="/repos" element={<Repositories />} />
              <Route path="/repos/:id" element={<PullRequests />} />
              <Route path="/runs/:id" element={<Review />} />
              <Route path="/" element={<Navigate to="/repos" replace />} />
              <Route
                path="*"
                element={
                  <div className="empty-state">
                    <h1>This page isn’t here</h1>
                    <Link to="/repos" className="button primary">
                      Back to repositories
                      <ArrowRight size={15} />
                    </Link>
                  </div>
                }
              />
            </Routes>
          </PageMotion>
        </main>
        <footer className="workspace-footer">
          <Link className="footer-wordmark" to="/repos">
            opticpr<span>✳</span>
          </Link>
          <p>
            Every finding.
            <br />
            <strong>A clear line to the source.</strong>
          </p>
          <span className="footer-caption">
            <span className="live-dot" />
            Revision-aware review
            <br />
            Built for your next commit.
          </span>
          <a href="#main" className="back-top" aria-label="Back to top">
            <ArrowUpRight size={22} />
          </a>
        </footer>
      </div>
    </div>
  );
}

function SignIn({ error, retry }: { error: unknown; retry: () => void }) {
  const location = useLocation();
  const signInUrl = `/auth/github?returnTo=${encodeURIComponent(location.pathname + location.search)}`;
  const status =
    error && typeof error === 'object' && 'status' in error
      ? error.status
      : undefined;
  const needsSetup =
    error &&
    typeof error === 'object' &&
    'data' in error &&
    error.data &&
    typeof error.data === 'object' &&
    'code' in error.data &&
    error.data.code === 'AUTH_NOT_CONFIGURED';
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(
    window.location.hostname,
  );
  return (
    <div className="signin">
      <div className="signin-top">
        <Link className="brand" to="/">
          <Mark />
          Optic<span>PR</span>
        </Link>
        <div className="signin-nav">
          <span className="eyebrow">INTELLIGENCE. WITH EVIDENCE.</span>
          <MotionToggle />
        </div>
      </div>
      <div className="signin-content">
        <div>
          <span className="pill">
            <span className="topbar-dot" />
            Clarity at every commit
          </span>
          <h1 className="display-heading">
            <span className="text-reveal">CODE IN</span>
            <span className="text-reveal accent-text">CLEAR SIGHT.</span>
          </h1>
          <p className="signin-description">
            Go beyond the diff. Turn every pull request into a clear view of
            what matters—and the evidence to back it up.
          </p>
          {needsSetup ? (
            <button className="button primary signin-button" disabled>
              <Github size={18} />
              GitHub connection needs setup
            </button>
          ) : (
            <a className="button primary signin-button" href={signInUrl}>
              <Github size={18} />
              Continue with GitHub
              <ArrowRight size={16} />
            </a>
          )}
          <p className="signin-privacy">
            <ShieldCheck size={14} />
            Only repositories you have access to.
          </p>
          {needsSetup ? (
            <section className="signin-setup" aria-labelledby="setup-title">
              <span className="eyebrow">CONNECT YOUR WORKSPACE</span>
              <h2 id="setup-title">One GitHub App. Then you’re in.</h2>
              <p>
                OpticPR needs its own GitHub App registration before it can sign
                you in.
              </p>
              {local ? (
                <>
                  <ol>
                    <li>
                      Open{' '}
                      <a
                        href="https://github.com/settings/apps"
                        target="_blank"
                        rel="noreferrer"
                      >
                        your GitHub Apps
                      </a>{' '}
                      and select an existing App or create a new one.
                    </li>
                    <li>
                      Set its callback URL to{' '}
                      <code>http://127.0.0.1:5173/auth/github/callback</code>.
                    </li>
                    <li>
                      Add the App’s <code>GITHUB_CLIENT_ID</code> and{' '}
                      <code>GITHUB_CLIENT_SECRET</code> to your local{' '}
                      <code>.env</code>, then restart the API.
                    </li>
                  </ol>
                  <p className="setup-note">
                    The client secret stays on your computer.
                  </p>
                </>
              ) : (
                <p>
                  Ask your workspace administrator to configure the GitHub
                  connection.
                </p>
              )}
              <button className="text-button" onClick={retry}>
                Check connection again
                <ArrowRight size={13} />
              </button>
            </section>
          ) : error && status !== 401 ? (
            <div className="signin-error" role="alert">
              <p>{errorMessage(error)}</p>
              <button className="text-button" onClick={retry}>
                Check again
              </button>
            </div>
          ) : null}
        </div>
        <SignalScene />
      </div>
      <div className="signin-bottom">
        <span>01 / CONNECT YOUR CODE</span>
        <span>READ THE SIGNAL. SHIP WITH CLARITY.</span>
        <ArrowUpRight size={17} />
      </div>
      <SignalMarquee />
      <section className="signin-story" data-reveal>
        <span className="eyebrow">THE OPTIC APPROACH /</span>
        <h2>
          Less second-guessing.
          <br />
          <span>More moving forward.</span>
        </h2>
        <div className="principles">
          <article>
            <span>01</span>
            <h3>Grounded in source.</h3>
            <p>
              Every claim lives beside its exact line of code. See the source,
              impact, and a way to verify it.
            </p>
          </article>
          <article>
            <span>02</span>
            <h3>Built for the next push.</h3>
            <p>
              Follow findings across commits. Know what’s new, what persists,
              and what needs verification.
            </p>
          </article>
          <article>
            <span>03</span>
            <h3>Honest about coverage.</h3>
            <p>
              Completed checks, skipped files, and partial scans stay visible.
              Clarity includes the limits.
            </p>
          </article>
        </div>
      </section>
      <footer>
        <span>OPTICPR✳ / CODE REVIEW, IN FOCUS.</span>
        <span>EVERY COMMIT. A CLEARER PICTURE.</span>
      </footer>
    </div>
  );
}
