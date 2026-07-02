import "../config/load-env.js";

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

export interface AIReviewResult {
  summary: string;
  issues: {
    severity: string;
    file: string;
    line: number;
    description: string;
    suggestion: string;
  }[];
  alerts: {
    severity: string;
    type: string;
    file: string;
    description: string;
    recommendation: string;
  }[];
}

type GitHubCredential = "GITHUB_APP_ID" | "GITHUB_PRIVATE_KEY" | "GITHUB_INSTALLATION_ID";

function readRequiredCredential(name: GitHubCredential): string {
  const value = process.env[name];

  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const githubAppId = readRequiredCredential("GITHUB_APP_ID");
const githubPrivateKey = readRequiredCredential("GITHUB_PRIVATE_KEY").replace(/\\n/g, "\n");
const githubInstallationId = Number.parseInt(readRequiredCredential("GITHUB_INSTALLATION_ID"), 10);

if (!Number.isSafeInteger(githubInstallationId) || githubInstallationId < 1) {
  throw new Error("GITHUB_INSTALLATION_ID must be a positive integer");
}

const octokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: githubAppId,
    privateKey: githubPrivateKey,
    installationId: githubInstallationId,
  },
});

function formatCodeReviewFindings(issues: AIReviewResult["issues"]): string {
  if (issues.length === 0) {
    return "No code review findings.";
  }

  return issues
    .map(
      (issue) =>
        `- **${issue.severity}** \`${issue.file}:${issue.line}\` - ${issue.description}\n  - **Suggestion:** ${issue.suggestion}`,
    )
    .join("\n");
}

function formatSecurityFindings(alerts: AIReviewResult["alerts"]): string {
  if (alerts.length === 0) {
    return "No security findings.";
  }

  return alerts
    .map(
      (alert) =>
        `- **${alert.severity}** ${alert.type} in \`${alert.file}\` - ${alert.description}\n  - **Recommendation:** ${alert.recommendation}`,
    )
    .join("\n");
}

export function formatGitHubReview(review: AIReviewResult): string {
  const summary = review.summary.trim() === "" ? "No summary provided." : review.summary;

  return [
    "## Summary",
    summary,
    "## Code Review Findings",
    formatCodeReviewFindings(review.issues),
    "## Security Findings",
    formatSecurityFindings(review.alerts),
  ].join("\n\n");
}

export async function publishGitHubReview(
  owner: string,
  repo: string,
  pullNumber: number,
  review: AIReviewResult,
): Promise<void> {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body: formatGitHubReview(review),
  });
}

export async function fetchPullRequestDiff(
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<string> {
  const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: pullNumber,
    headers: {
      accept: "application/vnd.github.v3.diff",
    },
  });

  if (typeof response.data !== "string") {
    throw new Error("GitHub pull request diff response was not text");
  }

  return response.data;
}
