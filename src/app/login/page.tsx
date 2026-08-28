import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser, isFirstRun } from "@/lib/auth";
import { Logo } from "@/components/logo";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");
  const firstRun = isFirstRun();

  return (
    <main className="flex min-h-screen">
      {/* Brand panel — hidden on small screens where the form is all that matters. */}
      <aside className="relative hidden w-[46%] max-w-2xl flex-col justify-between overflow-hidden bg-ink-950 p-12 lg:flex">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.35]"
          style={{
            backgroundImage:
              "linear-gradient(to right, rgba(255,255,255,.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,.05) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
            maskImage: "radial-gradient(120% 90% at 30% 20%, #000 30%, transparent 75%)",
          }}
        />
        <div className="relative flex items-center gap-3 text-brand-300">
          <Logo className="h-8 w-8" />
          <span className="text-base font-semibold tracking-tight text-white">
            Carrier Management Hub
          </span>
        </div>

        <div className="relative max-w-md">
          <h1 className="text-[2.1rem] font-semibold leading-[1.15] tracking-tight text-white">
            Every carrier, every change, one record.
          </h1>
          <p className="mt-4 text-[0.95rem] leading-relaxed text-ink-400">
            Onboarding, dispatch assignment, commercial terms and offboarding — tracked in
            one system with a full audit trail, instead of a spreadsheet nobody trusts.
          </p>
        </div>

        <p className="relative text-xs text-ink-500">
          Internal system · Authorized personnel only
        </p>
      </aside>

      <section className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-[23rem]">
          <div className="mb-8 lg:hidden">
            <span className="text-brand-600"><Logo className="h-9 w-9" /></span>
          </div>

          <h2 className="text-xl font-semibold tracking-tight text-ink-900">
            Sign in to Carrier Hub
          </h2>
          <p className="mt-1.5 mb-7 text-sm text-ink-500">
            Use the account issued to you by your administrator.
          </p>

          <LoginForm />

          <p className="mt-5 text-xs leading-relaxed text-ink-500">
            Forgotten your password? Ask an administrator to send you a reset link — they
            can issue one from the Team page without ever seeing your password.
          </p>

          {firstRun && (
            <div className="mt-7 rounded-lg border border-amber-200 bg-amber-50 p-3.5 text-xs leading-relaxed text-amber-900">
              <p className="font-semibold">First run</p>
              <p className="mt-1">
                A default administrator was created. Sign in with{" "}
                <code className="font-mono font-semibold">
                  {process.env.ADMIN_EMAIL ?? "admin@carrierhub.local"}
                </code>{" "}
                and the password from <code className="font-mono">ADMIN_PASSWORD</code>{" "}
                (default <code className="font-mono font-semibold">ChangeMe123!</code>),
                then change it in Settings.
              </p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
