import {
  AlertTriangle,
  ArrowLeft,
  Braces,
  ExternalLink,
  FileCode2,
  GitBranch,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Link, useParams } from "react-router-dom";
import remarkGfm from "remark-gfm";

import { FindingCard } from "@/components/FindingCard";
import { RiskIndicator } from "@/components/RiskIndicator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatRelativeDate } from "@/lib/utils";
import { useGetPullRequestQuery } from "@/store/api";

export function PullRequestDetailPage(): JSX.Element {
  const { id } = useParams();
  const { data, isError, isLoading } = useGetPullRequestQuery(id ?? "", {
    skip: id === undefined,
  });

  if (isLoading) {
    return (
      <div className="mx-auto max-w-[1480px] animate-pulse px-4 py-8 sm:px-6 lg:px-8">
        <div className="h-8 w-2/3 rounded bg-white/[0.04]" />
        <div className="mt-8 grid gap-5 xl:grid-cols-[1fr_360px]">
          <div className="h-[540px] rounded-xl bg-white/[0.025]" />
          <div className="h-[360px] rounded-xl bg-white/[0.025]" />
        </div>
      </div>
    );
  }

  if (isError || data === undefined) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center">
        <AlertTriangle className="size-5 text-red-400" />
        <div className="mt-4 text-sm text-zinc-400">Unable to load this pull request.</div>
        <Button asChild className="mt-5" size="sm" variant="secondary">
          <Link to="/pull-requests">Return to pull requests</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1480px] px-4 py-7 sm:px-6 lg:px-8 animate-fade-in-up">
      <Link
        className="mb-5 inline-flex items-center gap-2 text-xs text-zinc-600 hover:text-zinc-300"
        to="/pull-requests"
      >
        <ArrowLeft className="size-3.5" />
        Pull requests
      </Link>
      <div className="mb-7 flex flex-col justify-between gap-5 xl:flex-row xl:items-start">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-zinc-600">{data.repository.fullName}</span>
            <span className="text-zinc-800">/</span>
            <span className="font-mono text-xs text-zinc-600">#{data.number}</span>
            <Badge variant="success">{data.status}</Badge>
          </div>
          <h1 className="max-w-4xl text-2xl font-semibold leading-9 tracking-[-0.025em] text-white">
            {data.title}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-zinc-600">
            <span>by {data.author.login}</span>
            <span>updated {formatRelativeDate(data.updatedAt)}</span>
            <span className="flex items-center gap-1.5">
              <GitBranch className="size-3" />
              {data.sourceBranch}
              <span className="text-zinc-800">→</span>
              {data.targetBranch}
            </span>
          </div>
        </div>
        <Button asChild size="sm" variant="secondary">
          <a href={data.htmlUrl} rel="noreferrer" target="_blank">
            Open in GitHub
            <ExternalLink className="size-3.5" />
          </a>
        </Button>
      </div>
      <div className="mb-5 grid gap-px overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.07] sm:grid-cols-4 shadow-sm">
        {[
          { label: "Risk score", value: <RiskIndicator score={data.riskScore} /> },
          { label: "Files changed", value: <span>{data.changedFiles}</span> },
          {
            label: "Additions",
            value: <span className="text-emerald-400">+{data.additions}</span>,
          },
          {
            label: "Deletions",
            value: <span className="text-red-400">-{data.deletions}</span>,
          },
        ].map(({ label, value }) => (
          <div className="bg-black/20 backdrop-blur-md px-5 py-4" key={label}>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-700">
              {label}
            </div>
            <div className="mt-2 font-mono text-sm text-zinc-300">{value}</div>
          </div>
        ))}
      </div>
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-5">
          <Card className="overflow-hidden">
            <PanelHeader
              description="Generated from the complete diff"
              icon={<Sparkles className="size-4" />}
              tone="violet"
              title="AI Summary"
            />
            <div className="optic-markdown px-6 py-5">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.summary}</ReactMarkdown>
            </div>
          </Card>
          <Card className="overflow-hidden">
            <PanelHeader
              count={data.issues.length}
              description="Correctness, logic, and maintainability"
              icon={<Braces className="size-4" />}
              tone="sky"
              title="Code Review Findings"
            />
            {data.issues.length === 0 ? (
              <EmptyFinding
                icon={<FileCode2 className="size-4" />}
                text="No code review findings."
              />
            ) : (
              data.issues.map((issue) => (
                <FindingCard
                  description={issue.description}
                  file={issue.file}
                  key={issue.id}
                  line={issue.line}
                  resolution={issue.suggestion}
                  resolutionLabel="Suggested change"
                  severity={issue.severity}
                  title={issue.description.split(".")[0] ?? issue.description}
                />
              ))
            )}
          </Card>
        </div>
        <Card className="overflow-hidden xl:sticky xl:top-[84px]">
          <PanelHeader
            count={data.alerts.length}
            description="Semgrep and OWASP analysis"
            icon={<ShieldAlert className="size-4" />}
            tone="orange"
            title="Security Alerts"
          />
          {data.alerts.length === 0 ? (
            <EmptyFinding
              icon={<ShieldAlert className="size-4" />}
              text="No OWASP or static analysis risks were detected."
            />
          ) : (
            data.alerts.map((alert) => (
              <FindingCard
                description={alert.description}
                file={alert.file}
                key={alert.id}
                resolution={alert.recommendation}
                resolutionLabel="Recommendation"
                security
                severity={alert.severity}
                title={alert.type}
              />
            ))
          )}
        </Card>
      </div>
    </div>
  );
}

function PanelHeader({
  count,
  description,
  icon,
  title,
  tone,
}: {
  count?: number;
  description: string;
  icon: JSX.Element;
  title: string;
  tone: "violet" | "sky" | "orange";
}): JSX.Element {
  const colors = {
    violet: "bg-violet-400/10 text-violet-300",
    sky: "bg-sky-400/10 text-sky-300",
    orange: "bg-orange-400/10 text-orange-300",
  };

  return (
    <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
      <div className="flex items-center gap-3">
        <div className={`flex size-8 items-center justify-center rounded-lg ${colors[tone]}`}>
          {icon}
        </div>
        <div>
          <h2 className="text-sm font-medium text-zinc-200">{title}</h2>
          <p className="mt-0.5 text-[11px] text-zinc-600">{description}</p>
        </div>
      </div>
      {count === undefined ? null : (
        <span className="font-mono text-xs text-zinc-600">{count}</span>
      )}
    </div>
  );
}

function EmptyFinding({ icon, text }: { icon: JSX.Element; text: string }): JSX.Element {
  return (
    <div className="flex items-center gap-3 px-5 py-6 text-sm text-zinc-500">
      <span className="text-emerald-400">{icon}</span>
      {text}
    </div>
  );
}
