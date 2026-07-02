import { Badge } from "@/components/ui/badge";
import type { Severity } from "@/types/api";

const variants = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
} as const;

export function SeverityBadge({ severity }: { severity: Severity }): JSX.Element {
  return <Badge variant={variants[severity]}>{severity}</Badge>;
}
