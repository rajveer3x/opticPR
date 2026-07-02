import { Router } from "express";

export const pullRequestsRouter: Router = Router();

const mockPullRequests = [
  {
    id: 1,
    number: 1,
    title: "Add insecure code",
    repository: "rajveer3x/opticpr-test",
    status: "OPEN",
  },
];

const frontendMockPullRequests = {
  items: [
    {
      id: "1",
      number: 1,
      title: "Add insecure code",
      repository: {
        id: "repo-1",
        owner: "rajveer3x",
        name: "opticpr-test",
        fullName: "rajveer3x/opticpr-test",
      },
      author: {
        login: "rajveer3x",
        avatarUrl: "https://avatars.githubusercontent.com/u/1000?v=4",
      },
      status: "OPEN",
      riskScore: 85,
      reviewStatus: "COMPLETED",
      updatedAt: new Date().toISOString(),
    },
  ],
  total: 1,
};

pullRequestsRouter.get("/", (req, res) => {
  const origin = req.header("origin");
  const referer = req.header("referer");
  const isFrontend =
    (origin?.includes("localhost:5173") ?? false) || (referer?.includes("localhost:5173") ?? false);

  if (isFrontend) {
    res.json(frontendMockPullRequests);
  } else {
    res.json(mockPullRequests);
  }
});

pullRequestsRouter.get("/:id", (req, res) => {
  const id = req.params.id;
  if (id === "1") {
    res.json({
      id: "1",
      number: 1,
      title: "Add insecure code",
      repository: {
        id: "repo-1",
        owner: "rajveer3x",
        name: "opticpr-test",
        fullName: "rajveer3x/opticpr-test",
      },
      author: {
        login: "rajveer3x",
        avatarUrl: "https://avatars.githubusercontent.com/u/1000?v=4",
      },
      status: "OPEN",
      riskScore: 85,
      reviewStatus: "COMPLETED",
      updatedAt: new Date().toISOString(),
      sourceBranch: "feature/insecure-code",
      targetBranch: "main",
      additions: 45,
      deletions: 12,
      changedFiles: 3,
      htmlUrl: "https://github.com/rajveer3x/opticpr-test/pull/1",
      summary:
        "### AI Summary\n\nThis pull request introduces critical security risks by adding hardcoded credentials and unsafe SQL queries.",
      issues: [
        {
          id: "issue-1",
          severity: "HIGH",
          file: "src/db.ts",
          line: 15,
          description: "SQL injection vulnerability detected in database query.",
          suggestion: "Use parameterized queries instead of string concatenation.",
        },
      ],
      alerts: [
        {
          id: "alert-1",
          severity: "CRITICAL",
          type: "Hardcoded Credentials",
          file: "src/config.ts",
          description: "API keys are hardcoded in the configuration file.",
          recommendation: "Use environment variables to store secrets.",
        },
      ],
    });
  } else {
    res.status(404).json({ error: "Pull request not found" });
  }
});
