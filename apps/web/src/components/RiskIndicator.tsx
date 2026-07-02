import { cn } from "@/lib/utils";

export function RiskIndicator({
  score,
  showLabel = true,
}: {
  score: number;
  showLabel?: boolean;
}): JSX.Element {
  const tone =
    score >= 80
      ? "bg-red-400"
      : score >= 60
        ? "bg-orange-400"
        : score >= 35
          ? "bg-amber-400"
          : "bg-emerald-400";
  const label = score >= 80 ? "Critical" : score >= 60 ? "High" : score >= 35 ? "Medium" : "Low";

  return (
    <div className="flex items-center gap-2.5">
      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-white/[0.07]">
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${score}%` }} />
      </div>
      <span className="font-mono text-xs text-zinc-300">{score}</span>
      {showLabel ? <span className="hidden text-xs text-zinc-500 xl:inline">{label}</span> : null}
    </div>
  );
}
