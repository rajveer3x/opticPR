import { codeReviewAgent, type CodeReviewResult } from "./codeReviewAgent.js";
import { securityAgent, type SecurityResult } from "./securityAgent.js";
import { summaryAgent } from "./summaryAgent.js";

export interface AIReviewResult {
  summary: string;
  issues: CodeReviewResult["issues"];
  alerts: SecurityResult["alerts"];
}

export async function runPullRequestReview(diff: string): Promise<AIReviewResult> {
  const [codeReviewResult, securityResult, summaryResult] = await Promise.all([
    codeReviewAgent(diff),
    securityAgent(diff),
    summaryAgent(diff),
  ]);

  return {
    summary: summaryResult.summary,
    issues: codeReviewResult.issues,
    alerts: securityResult.alerts,
  };
}
