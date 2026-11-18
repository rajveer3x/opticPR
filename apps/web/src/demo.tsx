import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Link, useLocation, useMatch } from 'react-router-dom';
import { demoReplaySchema, type DemoReplay, type RunSummary } from '@opticpr/contracts';
import { Empty, Loading, Mark } from './components';
import { ReviewContent, SourceExcerpt } from './review';

const scenarios = ['regression', 'fix'] as const;
const labels = { regression: 'Regression', fix: 'Fix push' };
const headings = { regression: 'Missing-user regression', fix: 'Handle the missing user' };

function summary({ report, createdAt, completedAt }: DemoReplay['regression']): RunSummary {
  const { baseSha, headSha } = report.input;
  return { id: report.runId, baseSha, headSha, state: 'completed', attempt: 0, createdAt, completedAt,
    coverage: report.coverage.status, findings: report.findings.length };
}

export function Demo() {
  const { pathname } = useLocation();
  const revision = useMatch('/demo/runs/:id');
  const [replay, setReplay] = useState<DemoReplay>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/demo', { credentials: 'omit', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Demo reports unavailable');
        setReplay(demoReplaySchema.parse(await response.json()));
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, []);

  const scenario = replay && (pathname === '/demo' || pathname === '/demo/' ? 'regression'
    : scenarios.find(item => replay[item].report.runId === revision?.params.id));
  const snapshot = replay && scenario && replay[scenario];

  return (
    <div className="app-layout demo-layout">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="app-header">
        <Link className="brand" to="/demo" aria-label="OpticPR demo">
          <Mark />optic<span>pr</span><span className="brand-period">✳</span>
        </Link>
        <span className="demo-mode">Read-only demo</span>
      </header>
      <div className="workspace">
        <main id="main" className="demo-main">
          {snapshot && scenario && replay ? (
            <ReviewContent key={snapshot.report.runId}
              data={{ ...summary(snapshot), report: snapshot.report, repository: null, pullRequest: null,
                configurationDigest: snapshot.report.configurationDigest, error: null, decisions: [], retries: [],
                revisions: scenarios.map(item => summary(replay[item])) }}
              demo={{ title: headings[scenario], revisions: Object.fromEntries(scenarios.map(item => [replay[item].report.runId, labels[item]])),
                caller: <details className="excerpt-details demo-caller">
                  <summary>{scenario === 'regression' ? 'Handled caller' : 'Fix in src/route.ts'}<ChevronDown size={13} /></summary>
                  <p>{scenario === 'regression'
                    ? 'This caller already catches the error and returns HTTP 404.'
                    : 'The original route now catches the error and returns HTTP 404.'}</p>
                  <SourceExcerpt evidence={snapshot.caller} />
                </details> }}
            />
          ) : failed || replay ? (
            <Empty title="Demo snapshot unavailable">
              {failed ? <p>Start the bundled viewer with <code>pnpm review:demo</code>.</p> : <Link to="/demo">Open the demo</Link>}
            </Empty>
          ) : <Loading label="Opening the bundled review" />}
        </main>
      </div>
    </div>
  );
}
