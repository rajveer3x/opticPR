import { expect, it } from 'vitest';
import { publicationFailure, summaryBody, summaryMarker } from '../apps/worker/src/publication.js';

it('honors rate limit delays and applies jitter without discarding retry hints', () => {
  const now = Date.UTC(2026, 10, 17);
  const error = { status: 429, response: { headers: { 'retry-after': '120', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 180) } } };
  const failure = publicationFailure(error, 2, now, () => 0.5);
  expect(failure.nextAttemptAt.getTime()).toBe(now + 180500);
  expect(failure.diagnostics).toMatchObject({ status: 429, attempt: 2, code: 'github_rate_or_permission_limit' });
  expect(publicationFailure(new Error('secret response'), 3, now, () => 0).nextAttemptAt.getTime()).toBe(now + 4000);
  expect(publicationFailure({ response: { headers: { 'retry-after': new Date(now + 90000).toUTCString() } } }, 1, now, () => 0).nextAttemptAt.getTime()).toBe(now + 90000);
  expect(JSON.stringify(failure)).not.toContain('secret');
});

it('labels pending comparisons with both exact revisions and a stable recovery marker', () => {
  const body = summaryBody('200', 7, 'a'.repeat(40), 'b'.repeat(40));
  expect(body.split('\n')[0]).toBe(summaryMarker('200', 7));
  expect(body).toContain('Review pending');
  expect(body).toContain('a'.repeat(40));
  expect(body).toContain('b'.repeat(40));
});
