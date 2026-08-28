"use client";

import { useActionState } from "react";
import Link from "next/link";
import { completeResetAction, type ResetState } from "@/lib/reset-actions";

export function ResetForm({ token, name }: { token: string; name: string }) {
  const [state, action, pending] = useActionState<ResetState, FormData>(
    completeResetAction,
    {},
  );

  if (state.done) {
    return (
      <div className="space-y-4">
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-sm text-emerald-800">
          Your password has been set. Any other sessions for this account were signed out.
        </p>
        <Link
          href="/login"
          className="block w-full rounded-lg bg-brand-600 px-4 py-2.5 text-center text-sm font-semibold text-white transition hover:bg-brand-700"
        >
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      {state.error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
          {state.error}
        </p>
      )}
      <p className="text-sm text-ink-600">
        Setting a new password for <span className="font-medium text-ink-900">{name}</span>.
      </p>
      <div>
        <label className="label" htmlFor="password">New password</label>
        <input
          id="password" name="password" type="password" required minLength={8}
          autoComplete="new-password" autoFocus className="field"
        />
        <p className="mt-1 text-xs text-ink-400">At least 8 characters.</p>
      </div>
      <div>
        <label className="label" htmlFor="confirm">Confirm password</label>
        <input
          id="confirm" name="confirm" type="password" required minLength={8}
          autoComplete="new-password" className="field"
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
      >
        {pending ? "Saving…" : "Set password"}
      </button>
    </form>
  );
}
