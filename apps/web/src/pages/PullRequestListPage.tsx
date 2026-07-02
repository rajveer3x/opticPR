import {
  AlertTriangle,
  ChevronRight,
  GitPullRequest,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { RiskIndicator } from "@/components/RiskIndicator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatRelativeDate } from "@/lib/utils";
import { useGetPullRequestsQuery } from "@/store/api";
import type { ReviewStatus } from "@/types/api";

const reviewLabels: Record<
  ReviewStatus,
  { label: string; variant: "neutral" | "success" | "medium" }
> = {
  QUEUED: { label: "Queued", variant: "neutral" },
  IN_PROGRESS: { label: "Reviewing", variant: "medium" },
  COMPLETED: { label: "Reviewed", variant: "success" },
  FAILED: { label: "Failed", variant: "neutral" },
};

export function PullRequestListPage(): JSX.Element {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const query = {
    ...(search === "" ? {} : { search }),
    ...(status === "all" ? {} : { status }),
  };
  const { data, isError, isFetching } = useGetPullRequestsQuery(query);
  const pullRequests = data?.items ?? [];
  const openCount = useMemo(
    () => pullRequests.filter((pullRequest) => pullRequest.status === "OPEN").length,
    [pullRequests],
  );

  return (
    <div className="mx-auto max-w-[1480px] px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs text-zinc-600">
            <span>Workspace</span>
            <ChevronRight className="size-3" />
            <span className="text-zinc-400">Pull requests</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-[-0.025em] text-white">Pull requests</h1>
          <p className="mt-2 text-sm text-zinc-500">
            Monitor review quality, risk, and security across your repositories.
          </p>
        </div>
        <div className="flex items-center gap-6 text-sm">
          <div>
            <span className="font-mono text-zinc-200">{data?.total ?? 0}</span>
            <span className="ml-2 text-zinc-600">total</span>
          </div>
          <div className="h-5 w-px bg-white/[0.08]" />
          <div>
            <span className="font-mono text-zinc-200">{openCount}</span>
            <span className="ml-2 text-zinc-600">open</span>
          </div>
        </div>
      </div>
      <Card className="overflow-hidden animate-fade-in-up">
        <div className="flex flex-col gap-3 border-b border-white/[0.07] p-3 sm:flex-row sm:items-center">
          <div className="relative flex-1 sm:max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-600" />
            <input
              className="h-9 w-full rounded-lg border border-white/[0.08] bg-black/20 pl-9 pr-3 text-sm text-zinc-200 outline-none placeholder:text-zinc-700 focus:border-violet-500/40 focus:ring-2 focus:ring-violet-500/10"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search pull requests"
              value={search}
            />
          </div>
          <div className="flex items-center gap-2">
            {["all", "open", "merged"].map((value) => (
              <button
                className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                  status === value
                    ? "bg-white/[0.08] text-zinc-200"
                    : "text-zinc-600 hover:text-zinc-300"
                }`}
                key={value}
                onClick={() => setStatus(value)}
                type="button"
              >
                {value}
              </button>
            ))}
            <Button className="ml-1" size="sm" variant="secondary">
              <SlidersHorizontal className="size-3.5" />
              Filter
            </Button>
          </div>
        </div>
        <div className="hidden grid-cols-[minmax(320px,1.8fr)_minmax(160px,0.8fr)_120px_150px_110px_32px] gap-4 border-b border-white/[0.06] px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.13em] text-zinc-700 lg:grid">
          <span>Pull request</span>
          <span>Repository</span>
          <span>Risk</span>
          <span>Review</span>
          <span>Updated</span>
          <span />
        </div>
        {isFetching
          ? Array.from({ length: 5 }).map((_, index) => (
              <div
                className="h-[78px] animate-pulse border-b border-white/[0.05] bg-white/[0.015]"
                key={index}
              />
            ))
          : null}
        {!isFetching && isError ? (
          <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center">
            <div className="flex size-10 items-center justify-center rounded-xl border border-red-400/15 bg-red-400/[0.06] text-red-400">
              <AlertTriangle className="size-4" />
            </div>
            <div className="mt-4 text-sm font-medium text-zinc-300">
              Unable to load pull requests
            </div>
            <div className="mt-1 text-xs text-zinc-600">
              Check the API connection and try again.
            </div>
          </div>
        ) : null}
        {!isFetching && !isError && pullRequests.length === 0 ? (
          <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center">
            <div className="flex size-10 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.03] text-zinc-500">
              <GitPullRequest className="size-4" />
            </div>
            <div className="mt-4 text-sm font-medium text-zinc-300">No pull requests found</div>
            <div className="mt-1 text-xs text-zinc-600">
              New pull requests from connected repositories will appear here.
            </div>
          </div>
        ) : null}
        {!isFetching && !isError
          ? pullRequests.map((pullRequest) => {
              const review = reviewLabels[pullRequest.reviewStatus];

              return (
                <Link
                  className="group grid gap-3 border-b border-white/[0.055] px-5 py-4 transition-all duration-300 last:border-0 hover:-translate-y-0.5 hover:bg-white/[0.04] hover:shadow-lg lg:grid-cols-[minmax(320px,1.8fr)_minmax(160px,0.8fr)_120px_150px_110px_32px] lg:items-center lg:gap-4"
                  key={pullRequest.id}
                  to={`/pull-requests/${pullRequest.id}`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <GitPullRequest className="size-4 shrink-0 text-emerald-400" />
                      <span className="truncate text-sm font-medium text-zinc-200 group-hover:text-white">
                        {pullRequest.title}
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-2 pl-6 text-xs text-zinc-600">
                      <span>#{pullRequest.number}</span>
                      <span>opened by {pullRequest.author.login}</span>
                    </div>
                  </div>
                  <div className="truncate font-mono text-xs text-zinc-500">
                    {pullRequest.repository.fullName}
                  </div>
                  <RiskIndicator score={pullRequest.riskScore} showLabel={false} />
                  <div>
                    <Badge variant={review.variant}>{review.label}</Badge>
                  </div>
                  <div className="text-xs text-zinc-600">
                    {formatRelativeDate(pullRequest.updatedAt)}
                  </div>
                  <ChevronRight className="hidden size-4 text-zinc-700 group-hover:text-zinc-400 lg:block" />
                </Link>
              );
            })
          : null}
      </Card>
    </div>
  );
}
