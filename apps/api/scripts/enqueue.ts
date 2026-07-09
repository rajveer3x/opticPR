import { prReviewQueue, createPullRequestOpenedJobId, PullRequestOpenedPayload } from "../src/queues/pr-review.js";

const payload: PullRequestOpenedPayload = {
  action: "opened",
  pull_request: {
    id: 4,
    number: 4,
    diff_url: "https://github.com/rajveer3x/opticpr-test/pull/4.diff",
    title: "correct code test #4",
    user: { login: "rajveer3x", id: 1000 },
    body: "test",
    html_url: "https://github.com/rajveer3x/opticpr-test/pull/4"
  },
  repository: {
    id: 999,
    name: "opticpr-test",
    full_name: "rajveer3x/opticpr-test",
    owner: { login: "rajveer3x" }
  }
};

async function run() {
  await prReviewQueue.add(`pull_request.opened`, payload, {
    jobId: createPullRequestOpenedJobId(payload),
  });
  console.log("Enqueued PR #4");
  process.exit(0);
}

run();
