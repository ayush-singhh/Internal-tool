import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { ForgotForm } from "./forgot-form";

export const metadata: Metadata = { title: "Forgotten password", robots: { index: false } };

export default function ForgotPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-[23rem]">
        <span className="text-brand-600"><Logo className="h-9 w-9" /></span>
        <h1 className="mt-6 text-xl font-semibold tracking-tight text-ink-900">
          Forgotten your password
        </h1>
        <p className="mt-1.5 mb-7 text-sm text-ink-500">
          Give us the address you sign in with and we will send a link to set a new password.
        </p>

        <ForgotForm />

        <p className="mt-6 text-xs text-ink-500">
          <Link href="/login" className="underline hover:text-ink-800">Back to sign in</Link>
        </p>
      </div>
    </main>
  );
}
