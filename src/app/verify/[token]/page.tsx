import type { Metadata } from "next";
import Link from "next/link";
import { verifyEmail } from "@/lib/signup";
import { Logo } from "@/components/logo";

export const metadata: Metadata = { title: "Confirm your email", robots: { index: false } };

export default async function VerifyPage(props: PageProps<"/verify/[token]">) {
  const { token } = await props.params;
  const result = verifyEmail(token);

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-[23rem]">
        <span className="text-brand-600"><Logo className="h-9 w-9" /></span>
        <h1 className="mt-6 text-xl font-semibold tracking-tight text-ink-900">
          {result.ok ? "Email confirmed" : "Confirmation problem"}
        </h1>

        <div className="mt-6 space-y-4">
          {result.ok ? (
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-sm text-emerald-800">
              {result.email} is confirmed. Sign in to set your company up.
            </p>
          ) : (
            <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-900">
              {result.reason}
            </p>
          )}
          <Link
            href="/login"
            className="block w-full rounded-lg border border-line-strong bg-surface px-4 py-2.5 text-center text-sm font-semibold text-ink-700 transition hover:bg-ink-50"
          >
            Go to sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
