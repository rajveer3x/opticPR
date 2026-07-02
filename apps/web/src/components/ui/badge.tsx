import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
  {
    variants: {
      variant: {
        neutral: "border-white/10 bg-white/[0.04] text-zinc-400",
        low: "border-sky-400/20 bg-sky-400/10 text-sky-300",
        medium: "border-amber-400/20 bg-amber-400/10 text-amber-300",
        high: "border-orange-400/20 bg-orange-400/10 text-orange-300",
        critical: "border-red-400/20 bg-red-400/10 text-red-300",
        success: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps): JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
