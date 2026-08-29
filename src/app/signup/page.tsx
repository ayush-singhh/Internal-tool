import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { signupOpen } from "@/lib/signup";
import { Logo } from "@/components/logo";
import { SignupForm } from "./signup-form";

export const metadata: Metadata = { title: "Create an account" };
// SIGNUP_OPEN is read at run time, not build time: the container is told whether it is a
// SaaS deployment when it starts, and a prerendered page would freeze that answer.
export const dynamic = "force-dynamic";

export default function SignupPage() {
  // A self-hosted install must not let strangers create organisations on its server.
  if (!signupOpen()) notFound();

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-[26rem]">
        <span className="text-brand-600"><Logo className="h-9 w-9" /></span>
        <h1 className="mt-6 text-xl font-semibold tracking-tight text-ink-900">
          Start your carrier hub
        </h1>
        <p className="mt-1.5 mb-7 text-sm text-ink-500">
          Your company gets its own database, its own dropdowns and its own people. Nothing
          is shared with anyone else.
        </p>

        <SignupForm />

        <p className="mt-6 text-xs text-ink-500">
          Already have an account?{" "}
          <Link href="/login" className="underline hover:text-ink-800">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
