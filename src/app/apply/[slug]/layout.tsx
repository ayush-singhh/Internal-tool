import { Logo } from "@/components/logo";

/**
 * Chrome for the public onboarding portal.
 *
 * This layout authenticates nothing and gates nothing. Next runs the page whether or not
 * a layout is happy, so every page under here resolves the portal for itself — the same
 * reasoning the `/support` layout carries.
 */
export default function ApplyLayout({ children }: LayoutProps<"/apply/[slug]">) {
  return (
    <div className="min-h-screen bg-paper-50">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-2xl items-center gap-2.5 px-6 py-4">
          <span className="text-brand-600"><Logo className="h-7 w-7" /></span>
          <span className="text-sm font-semibold tracking-tight text-ink-900">
            Carrier onboarding
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-6 py-10">{children}</main>
      <footer className="mx-auto max-w-2xl px-6 pb-10 text-xs text-ink-400">
        Your details are sent only to the dispatcher you are applying to.
      </footer>
    </div>
  );
}
