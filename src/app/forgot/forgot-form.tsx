"use client";

import { useActionState } from "react";
import { forgotPasswordAction, type ForgotState } from "@/lib/reset-actions";

export function ForgotForm() {
  const [state, action, pending] = useActionState<ForgotState, FormData>(
    forgotPasswordAction,
    {},
  );

  if (state.sent) {
    return (
      <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-sm text-emerald-800">
        If that address has an account, a link to set a new password is on its way. It works
        once and expires in 24 hours.
      </p>
    );
  }

  return (
    <form action={action} className="space-y-4">
      {state.error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
          {state.error}
        </p>
      )}

      <div>
        <label className="label" htmlFor="email">Work email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          placeholder="you@company.com"
          className="field"
        />
      </div>

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Sending…" : "Send me a link"}
      </button>
    </form>
  );
}
