import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Bell,
  BookOpen,
  Boxes,
  ChevronDown,
  CircleHelp,
  GitPullRequest,
  LogOut,
  Menu,
  Settings,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";

import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

export function AppShell(): JSX.Element {
  const { logout, user } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  const sidebar = (
    <aside className="flex h-full w-[248px] flex-col border-r border-white/[0.07] bg-black/20 backdrop-blur-3xl shadow-xl">
      <div className="flex h-16 items-center px-5">
        <Logo />
        <button
          className="ml-auto text-zinc-500 lg:hidden"
          onClick={() => setMobileOpen(false)}
          type="button"
        >
          <X className="size-4" />
        </button>
      </div>
      <nav className="flex-1 space-y-1 px-3 py-4">
        <div className="mb-3 px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600">
          Workspace
        </div>
        <NavLink
          className={({ isActive }) =>
            cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
              isActive
                ? "bg-white/[0.07] text-white"
                : "text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300",
            )
          }
          onClick={() => setMobileOpen(false)}
          to="/pull-requests"
        >
          <GitPullRequest className="size-4" />
          Pull requests
        </NavLink>
        <div className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-zinc-700">
          <Boxes className="size-4" />
          Repositories
          <span className="ml-auto rounded bg-white/[0.04] px-1.5 py-0.5 text-[9px] uppercase">
            Soon
          </span>
        </div>
        <div className="mb-3 mt-8 px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600">
          Intelligence
        </div>
        <div className="flex items-center gap-3 rounded-lg bg-gradient-to-r from-violet-500/[0.09] to-transparent px-3 py-2 text-sm text-violet-300">
          <Sparkles className="size-4" />
          AI review
          <span className="ml-auto size-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
        </div>
        <div className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-zinc-600">
          <ShieldCheck className="size-4" />
          Security rules
        </div>
      </nav>
      <div className="border-t border-white/[0.07] p-3">
        <a
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-zinc-500 hover:text-zinc-300"
          href="#"
        >
          <BookOpen className="size-4" />
          Documentation
        </a>
        <a
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-zinc-500 hover:text-zinc-300"
          href="#"
        >
          <CircleHelp className="size-4" />
          Support
        </a>
      </div>
    </aside>
  );

  return (
    <div className="flex min-h-screen text-zinc-100 bg-transparent">
      <div className="fixed inset-y-0 left-0 z-40 hidden lg:block">{sidebar}</div>
      {mobileOpen ? (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          {sidebar}
          <button
            aria-label="Close navigation"
            className="flex-1 bg-black/70 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
            type="button"
          />
        </div>
      ) : null}
      <div className="min-w-0 flex-1 lg:pl-[248px]">
        <header className="sticky top-0 z-30 flex h-16 items-center border-b border-white/[0.07] bg-white/[0.02] px-4 backdrop-blur-2xl sm:px-6 shadow-sm">
          <Button
            className="mr-3 lg:hidden"
            onClick={() => setMobileOpen(true)}
            size="icon"
            variant="ghost"
          >
            <Menu className="size-4" />
          </Button>
          <div className="hidden items-center gap-2 text-xs text-zinc-600 sm:flex">
            <span className="size-1.5 rounded-full bg-emerald-400" />
            All systems operational
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button size="icon" variant="ghost">
              <Bell className="size-4" />
            </Button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  className="flex items-center gap-2 rounded-lg p-1.5 hover:bg-white/[0.05]"
                  type="button"
                >
                  <img
                    alt={user?.name ?? "User"}
                    className="size-7 rounded-md bg-zinc-800 object-cover"
                    src={user?.avatarUrl ?? "https://github.com/identicons/opticpr.png"}
                  />
                  <span className="hidden text-sm font-medium text-zinc-300 sm:block">
                    {user?.name ?? user?.login ?? "Developer"}
                  </span>
                  <ChevronDown className="hidden size-3 text-zinc-600 sm:block" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  className="z-50 min-w-52 rounded-xl border border-white/10 bg-[#151518] p-1.5 text-sm shadow-2xl"
                  sideOffset={8}
                >
                  <div className="px-2 py-2">
                    <div className="font-medium text-zinc-200">{user?.name ?? "Developer"}</div>
                    <div className="text-xs text-zinc-600">@{user?.login ?? "developer"}</div>
                  </div>
                  <DropdownMenu.Separator className="my-1 h-px bg-white/[0.07]" />
                  <DropdownMenu.Item className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-zinc-400 outline-none hover:bg-white/[0.06] hover:text-white">
                    <Settings className="size-4" />
                    Settings
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-zinc-400 outline-none hover:bg-white/[0.06] hover:text-white"
                    onSelect={logout}
                  >
                    <LogOut className="size-4" />
                    Log out
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </header>
        <main className="min-h-[calc(100vh-4rem)]">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
