"use client";

import { useActionState } from "react";
import { Text } from "@/components/form-fields";
import { verifyAction, resendAction, type VerifyState } from "@/lib/apply-actions";

export function VerifyForm({ slug }: { slug: string }) {
  const [state, runVerify, verifying] = useActionState<VerifyState, FormData>(verifyAction, {});
  const [resend, runResend, resending] = useActionState<VerifyState, FormData>(resendAction, {});

  return (
    <div className="space-y-4">
      <form action={runVerify} className="space-y-4">
        <input type="hidden" name="slug" value={slug} />
        {state.errors?.form && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
            {state.errors.form}
          </p>
        )}
        {resend.resent && (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
            A new code is on its way. The previous one no longer works.
          </p>
        )}
        {resend.errors?.form && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
            {resend.errors.form}
          </p>
        )}

        <Text
          name="code"
          label="Six-digit code"
          required
          inputMode="numeric"
          error={state.errors?.code}
          autoComplete="one-time-code"
        />
        <button
          type="submit"
          disabled={verifying}
          className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {verifying ? "Checking…" : "Confirm"}
        </button>
      </form>

      <form action={runResend}>
        <input type="hidden" name="slug" value={slug} />
        <button
          type="submit"
          disabled={resending}
          className="text-sm text-ink-500 underline transition hover:text-ink-800 disabled:opacity-60"
        >
          {resending ? "Sending…" : "Send me a new code"}
        </button>
      </form>
    </div>
  );
}
