import Link from "next/link";
import { requireSupport } from "@/lib/auth";
import { Logo } from "@/components/logo";

/**
 * The only surface with cross-tenant reach, and the only place it is allowed.
 *
 * The gate is `requireSupport()`, and this layout is not where it is enforced — a layout
 * cannot enforce anything, because Next runs the page whether or not the layout rejects
 * the request. Every page under here calls it for itself; this call only decides whether
 * to draw the chrome, and reads the name to put in it. The MFA check is the page's, since
 * `/support/account` must open without one.
 */
export default async function SupportLayout({ children }: LayoutProps<"/support">) {
  const user = await requireSupport(false);

  return (
    <div className="min-h-screen bg-paper-50">
      <header className="border-b border-line bg-ink-950">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-3">
          <Link href="/support" className="flex items-center gap-2.5 text-brand-300">
            <Logo className="h-6 w-6" />
            <span className="text-sm font-semibold tracking-tight text-white">
              Platform support
            </span>
          </Link>
          <span className="rounded bg-amber-400/15 px-2 py-0.5 text-[0.68rem] font-semibold uppercase tracking-wide text-amber-300">
            Read only · every view recorded
          </span>
          <span className="ml-auto text-xs text-ink-400">{user.name}</span>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
