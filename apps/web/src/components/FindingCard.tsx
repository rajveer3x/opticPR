import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronDown, FileCode2, ShieldAlert } from "lucide-react";
import { useState } from "react";

import { SeverityBadge } from "@/components/SeverityBadge";
import { cn } from "@/lib/utils";
import type { Severity } from "@/types/api";

interface FindingCardProps {
  severity: Severity;
  title: string;
  file: string;
  line?: number;
  description: string;
  resolutionLabel: string;
  resolution: string;
  security?: boolean;
}

export function FindingCard({
  severity,
  title,
  file,
  line,
  description,
  resolutionLabel,
  resolution,
  security = false,
}: FindingCardProps): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <div className="border-b border-white/[0.06] last:border-0">
        <Collapsible.Trigger className="group flex w-full items-start gap-3 px-5 py-4 text-left hover:bg-white/[0.02]">
          <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.03] text-zinc-500">
            {security ? <ShieldAlert className="size-3.5" /> : <FileCode2 className="size-3.5" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <SeverityBadge severity={severity} />
              <span className="text-sm font-medium text-zinc-200">{title}</span>
            </div>
            <p className="mt-2 line-clamp-2 text-sm leading-6 text-zinc-500">{description}</p>
            <div className="mt-2 font-mono text-[11px] text-zinc-600">
              {file}
              {line === undefined ? "" : `:${line}`}
            </div>
          </div>
          <ChevronDown
            className={cn(
              "mt-1 size-4 shrink-0 text-zinc-600 transition-transform group-hover:text-zinc-300",
              open && "rotate-180",
            )}
          />
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div className="mx-5 mb-5 ml-[60px] rounded-lg border border-violet-400/10 bg-violet-400/[0.04] p-4">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-violet-300">
              {resolutionLabel}
            </div>
            <p className="text-sm leading-6 text-zinc-400">{resolution}</p>
          </div>
        </Collapsible.Content>
      </div>
    </Collapsible.Root>
  );
}
