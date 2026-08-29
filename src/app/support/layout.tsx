import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { mfaState } from "@/lib/mfa";
import { isSupport } from "@/lib/support";
import { Logo } from "@/components/logo";

/**
 * The only surface with cross-tenant reach, and the only place it is allowed.
 *
 * Two gates, both here so neither can be forgotten on a page: the account must be
 * platform support, and it must have a second factor. Anyone else gets a 404 rather than
 * a redirect — an ordinary customer has no business learning that this exists.
 */
export default async function SupportLayout({ children }: LayoutProps<"/support">) {
  const user = await requireUser();
  if (!isSupport(user)) notFound();

  const path = (await headers()).get("x-pathname") ?? "";
  if (!mfaState(user.id).active && path !== "/support/account") {
    redirect("/support/account");
  }

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
