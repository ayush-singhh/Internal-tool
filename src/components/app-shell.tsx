"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./icons";
import { Wordmark } from "./logo";
import { signOutAction } from "@/lib/session-actions";
import { ROLE_LABELS, type Role } from "@/lib/constants";
import type { NavCounts, NavGroup } from "@/lib/nav";

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export function AppShell({
  user,
  counts,
  groups,
  canSearchCarriers,
  canAddCarrier,
  children,
}: {
  user: { name: string; email: string; role: Role };
  counts: NavCounts;
  /** Already filtered by `visibleNav()` in the layout — this component renders, it never decides. */
  groups: NavGroup[];
  canSearchCarriers: boolean;
  canAddCarrier: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);


  const nav = (
    <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
      {groups.map((group, gi) => {
        return (
          <div key={gi}>
            {group.heading && (
              <p className="mb-1.5 px-2.5 text-[0.65rem] font-semibold uppercase tracking-[0.13em] text-ink-500">
                {group.heading}
              </p>
            )}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const current = isActive(pathname, item.href);
                const n = item.count ? counts[item.count] : undefined;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={() => setOpen(false)}
                      aria-current={current ? "page" : undefined}
                      className={`group relative flex items-center gap-2.5 rounded-md px-2.5 py-[0.44rem] text-[0.83rem] font-medium transition ${
                        current
                          ? "bg-white/[0.08] text-white"
                          : "text-ink-300 hover:bg-white/[0.05] hover:text-white"
                      }`}
                    >
                      {current && (
                        <span className="absolute inset-y-1.5 -left-[3px] w-[3px] rounded-full bg-brand-400" />
                      )}
                      <span className={current ? "text-brand-300" : "text-ink-400 group-hover:text-ink-200"}>
                        <Icon name={item.icon} />
                      </span>
                      <span className="flex-1 truncate">{item.label}</span>
                      {n !== undefined && n > 0 && (
                        <span
                          className={`tnum rounded px-1.5 py-px text-[0.68rem] font-semibold ${
                            current ? "bg-brand-400/20 text-brand-200" : "bg-white/[0.06] text-ink-400"
                          }`}
                        >
                          {n}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );

  const sidebar = (
    <div className="flex h-full flex-col bg-ink-950">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.07] px-4">
        <Wordmark subdued />
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md p-1 text-ink-400 hover:text-white lg:hidden"
          aria-label="Close navigation"
        >
          <Icon name="close" />
        </button>
      </div>

      {nav}

      <div className="shrink-0 border-t border-white/[0.07] p-3">
        <div className="flex items-center gap-2.5 rounded-md px-1.5 py-1.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600 text-[0.7rem] font-semibold text-white">
            {initials(user.name)}
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[0.8rem] font-medium text-white">{user.name}</span>
            <span className="block truncate text-[0.7rem] text-ink-500">
              {ROLE_LABELS[user.role]}
            </span>
          </span>
          <form action={signOutAction}>
            <button
              type="submit"
              title="Sign out"
              aria-label="Sign out"
              className="rounded-md p-1.5 text-ink-400 transition hover:bg-white/[0.06] hover:text-white"
            >
              <Icon name="logout" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] lg:block">{sidebar}</aside>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-ink-950/60"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute inset-y-0 left-0 w-[260px] shadow-pop">{sidebar}</div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col lg:pl-[248px]">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur-sm sm:px-6">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-md p-1.5 text-ink-600 hover:bg-ink-100 lg:hidden"
            aria-label="Open navigation"
          >
            <Icon name="filter" />
          </button>

          {canSearchCarriers && (
            <form action="/carriers" className="relative max-w-md flex-1">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400">
                <Icon name="search" className="h-4 w-4" />
              </span>
              <input
                type="search"
                name="q"
                placeholder="Search name, owner, phone, email, MC, USDOT…"
                aria-label="Search carriers"
                className="field field-sm pl-8"
              />
            </form>
          )}

          {canAddCarrier && (
            <Link
              href="/carriers/new"
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-[0.44rem] text-[0.82rem] font-semibold text-white shadow-sm transition hover:bg-brand-700"
            >
              <Icon name="plus" className="h-4 w-4" />
              <span className="hidden sm:inline">Add Carrier</span>
            </Link>
          )}
        </header>

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
