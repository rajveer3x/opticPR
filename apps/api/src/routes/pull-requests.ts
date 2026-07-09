import { Router } from "express";
import { prisma } from "../config/prisma.js";

export const pullRequestsRouter: Router = Router();

// GET /api/v1/pull-requests
pullRequestsRouter.get("/", async (req, res) => {
  try {
    const prs = await prisma.pullRequest.findMany({
      orderBy: { updatedAt: "desc" },
      include: {
        repository: true,
        author: true,
      },
    });

    const formattedPrs = prs.map((pr) => ({
      id: pr.id,
      number: pr.number || parseInt(pr.githubPrId, 10),
      title: pr.title,
      repository: {
        id: pr.repository.id,
        owner: pr.repository.owner,
        name: pr.repository.name,
        fullName: `${pr.repository.owner}/${pr.repository.name}`,
      },
      author: {
        login: pr.author.name,
        avatarUrl: `https://avatars.githubusercontent.com/u/${pr.author.githubId}?v=4`,
      },
      status: pr.status,
      riskScore: pr.riskScore,
      reviewStatus: pr.reviewStatus,
      updatedAt: pr.updatedAt.toISOString(),
    }));

    res.json({
      items: formattedPrs,
      total: formattedPrs.length,
    });
  } catch (error) {
    console.error("Error fetching pull requests:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET /api/v1/pull-requests/:id
pullRequestsRouter.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate UUID format securely
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      return res.status(400).json({ error: "Invalid PR ID format" });
    }

    const pr = await prisma.pullRequest.findUnique({
      where: { id },
      include: {
        repository: true,
        author: true,
      },
    });

    if (!pr) {
      return res.status(404).json({ error: "Pull request not found" });
    }

    res.json({
      id: pr.id,
      number: pr.number || parseInt(pr.githubPrId, 10),
      title: pr.title,
      repository: {
        id: pr.repository.id,
        owner: pr.repository.owner,
        name: pr.repository.name,
        fullName: `${pr.repository.owner}/${pr.repository.name}`,
      },
      author: {
        login: pr.author.name,
        avatarUrl: `https://avatars.githubusercontent.com/u/${pr.author.githubId}?v=4`,
      },
      status: pr.status,
      riskScore: pr.riskScore,
      reviewStatus: pr.reviewStatus,
      updatedAt: pr.updatedAt.toISOString(),
      sourceBranch: pr.sourceBranch,
      targetBranch: pr.targetBranch,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      htmlUrl: pr.htmlUrl,
      summary: pr.summary,
      issues: pr.issues,
      alerts: pr.alerts,
    });
  } catch (error) {
    console.error("Error fetching pull request details:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});
