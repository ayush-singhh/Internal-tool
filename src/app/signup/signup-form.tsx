"use client";

import { useActionState } from "react";
import { Text } from "@/components/form-fields";
import { signupAction, type SignupState } from "./actions";

export function SignupForm() {
  const [state, action, pending] = useActionState<SignupState, FormData>(signupAction, {});

  if (state.sent) {
    return (
      <div className="space-y-3">
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-sm text-emerald-800">
          Check your email. If that address can start an account, a confirmation link is on
          its way — it works once and expires in 24 hours.
        </p>
        <p className="text-sm text-ink-500">
          Nothing to open yet? Look in spam, then try again from this page to get a new link.
        </p>
      </div>
    );
  }

  const errors = state.errors ?? {};

  return (
    <form action={action} className="space-y-4">
      {errors.form && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
          {errors.form}
        </p>
      )}

      <Text name="orgName" label="Company name" required error={errors.orgName} />
      <Text name="ownerName" label="Your name" required error={errors.ownerName} />
      <Text name="email" label="Work email" type="email" required error={errors.email} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Text
          name="password"
          label="Password"
          type="password"
          required
          error={errors.password}
          hint="At least 8 characters."
        />
        <Text name="confirm" label="Confirm password" type="password" required error={errors.confirm} />
      </div>

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Creating…" : "Create account"}
      </button>
    </form>
  );
}
