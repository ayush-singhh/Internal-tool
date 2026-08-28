import type { Metadata } from "next";
import Link from "next/link";
import { checkReset } from "@/lib/reset";
import { Logo } from "@/components/logo";
import { ResetForm } from "./reset-form";

export const metadata: Metadata = { title: "Set your password", robots: { index: false } };

export default async function ResetPage(props: PageProps<"/reset/[token]">) {
  const { token } = await props.params;
  const check = checkReset(token);

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-[23rem]">
        <span className="text-brand-600"><Logo className="h-9 w-9" /></span>
        <h1 className="mt-6 text-xl font-semibold tracking-tight text-ink-900">
          {check.valid ? "Set your password" : "Reset link problem"}
        </h1>

        <div className="mt-6">
          {check.valid ? (
            <ResetForm token={token} name={check.name} />
          ) : (
            <div className="space-y-4">
              <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-900">
                {check.reason}
              </p>
              <p className="text-sm text-ink-500">
                Ask an administrator for a new reset link.
              </p>
              <Link
                href="/login"
                className="block w-full rounded-lg border border-line-strong bg-surface px-4 py-2.5 text-center text-sm font-semibold text-ink-700 transition hover:bg-ink-50"
              >
                Back to sign in
              </Link>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
