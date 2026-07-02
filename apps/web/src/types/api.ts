export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type PullRequestStatus = "OPEN" | "MERGED" | "CLOSED";
export type ReviewStatus = "QUEUED" | "IN_PROGRESS" | "COMPLETED" | "FAILED";

export interface User {
  id: string;
  name: string;
  login: string;
  email?: string;
  avatarUrl: string;
}

export interface Repository {
  id: string;
  owner: string;
  name: string;
  fullName: string;
}

export interface PullRequestListItem {
  id: string;
  number: number;
  title: string;
  repository: Repository;
  author: {
    login: string;
    avatarUrl: string;
  };
  status: PullRequestStatus;
  riskScore: number;
  reviewStatus: ReviewStatus;
  updatedAt: string;
}

export interface CodeReviewIssue {
  id: string;
  severity: Severity;
  file: string;
  line: number;
  description: string;
  suggestion: string;
}

export interface SecurityAlert {
  id: string;
  severity: Severity;
  type: string;
  file: string;
  description: string;
  recommendation: string;
}

export interface PullRequestDetail extends PullRequestListItem {
  sourceBranch: string;
  targetBranch: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  htmlUrl: string;
  summary: string;
  issues: CodeReviewIssue[];
  alerts: SecurityAlert[];
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface PullRequestListResponse {
  items: PullRequestListItem[];
  total: number;
}
