import { ArrowRight, Check, Github, GitPullRequest, ShieldCheck, Sparkles } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Navigate } from "react-router-dom";

import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000/api/v1";
const features: { icon: LucideIcon; title: string; description: string }[] = [
  { icon: GitPullRequest, title: "Code-aware", description: "Diff-level review" },
  { icon: ShieldCheck, title: "Security-first", description: "OWASP analysis" },
  { icon: Sparkles, title: "Built for flow", description: "Signal, not noise" },
];

export function LoginPage(): JSX.Element {
  const { isAuthenticated } = useAuth();

  if (isAuthenticated) return <Navigate replace to="/pull-requests" />;

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#08080a] text-zinc-100">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_20%,rgba(124,58,237,0.12),transparent_32%),radial-gradient(circle_at_82%_72%,rgba(79,70,229,0.08),transparent_28%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.018)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.018)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:linear-gradient(to_bottom,black,transparent_90%)]" />
      <header className="relative z-10 mx-auto flex h-20 max-w-7xl items-center px-6 lg:px-8">
        <Logo />
        <div className="ml-auto text-xs text-zinc-600">AI-native pull request intelligence</div>
      </header>
      <main className="relative z-10 mx-auto grid min-h-[calc(100vh-5rem)] max-w-7xl items-center gap-16 px-6 py-12 lg:grid-cols-[1.15fr_0.85fr] lg:px-8">
        <section className="max-w-2xl">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-violet-400/15 bg-violet-400/[0.06] px-3 py-1.5 text-xs font-medium text-violet-300">
            <Sparkles className="size-3.5" />
            Precision review for modern teams
          </div>
          <h1 className="text-5xl font-semibold leading-[1.06] tracking-[-0.045em] text-white sm:text-6xl">
            See the risk before
            <span className="block bg-gradient-to-r from-violet-300 via-indigo-300 to-zinc-400 bg-clip-text text-transparent">
              it reaches production.
            </span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-8 text-zinc-500">
            OpticPR turns every pull request into an actionable review with code intelligence,
            security analysis, and clear engineering context.
          </p>
          <div className="mt-10 grid max-w-xl gap-4 sm:grid-cols-3">
            {features.map(({ description, icon: Icon, title }) => (
              <div className="border-l border-white/[0.09] pl-4" key={title}>
                <Icon className="mb-3 size-4 text-violet-400" />
                <div className="text-sm font-medium text-zinc-200">{title}</div>
                <div className="mt-1 text-xs text-zinc-600">{description}</div>
              </div>
            ))}
          </div>
        </section>
        <section className="mx-auto w-full max-w-md">
          <div className="rounded-2xl border border-white/[0.09] bg-[#111114]/90 p-1 shadow-[0_40px_100px_rgba(0,0,0,0.5)] backdrop-blur-xl">
            <div className="rounded-[14px] border border-white/[0.04] bg-gradient-to-b from-white/[0.03] to-transparent p-7 sm:p-8">
              <div className="mb-8">
                <div className="mb-2 text-xl font-semibold tracking-tight text-white">
                  Connect your workspace
                </div>
                <p className="text-sm leading-6 text-zinc-500">
                  Sign in with GitHub to review pull requests from your installed repositories.
                </p>
              </div>
              <Button
                className="h-11 w-full"
                onClick={() => window.location.assign(`${apiBaseUrl}/auth/github`)}
              >
                <Github className="size-4" />
                Continue with GitHub
                <ArrowRight className="ml-auto size-4 text-zinc-500" />
              </Button>
              <div className="my-7 h-px bg-white/[0.07]" />
              <div className="space-y-3">
                {[
                  "Read access to pull request metadata",
                  "Review comments require your approval",
                  "Repository code stays within your workspace",
                ].map((item) => (
                  <div className="flex items-center gap-3 text-xs text-zinc-500" key={item}>
                    <div className="flex size-5 items-center justify-center rounded-full bg-emerald-400/10 text-emerald-400">
                      <Check className="size-3" />
                    </div>
                    {item}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <p className="mt-5 text-center text-[11px] leading-5 text-zinc-700">
            By continuing, you agree to the Terms of Service and Privacy Policy.
          </p>
        </section>
      </main>
    </div>
  );
}
