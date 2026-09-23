"use client";

import { useActionState } from "react";
import { Text } from "@/components/form-fields";
import {
  lookupAction, startAction, type LookupState, type StartState,
} from "@/lib/apply-actions";

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
      {children}
    </p>
  );
}

function Submit({ pending, children }: { pending: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {children}
    </button>
  );
}

export function ApplyForm({ slug }: { slug: string }) {
  const [lookup, runLookup, looking] = useActionState<LookupState, FormData>(lookupAction, {});

  // The second step appears once we know who this is — either because FMCSA answered, or
  // because it could not and the carrier is telling us itself.
  if (lookup.carrier || lookup.manual) {
    return <ContactStep slug={slug} lookup={lookup} />;
  }

  return (
    <form action={runLookup} className="space-y-4">
      <input type="hidden" name="slug" value={slug} />
      {lookup.errors?.form && <Alert>{lookup.errors.form}</Alert>}
      <Text
        name="usdot"
        label="USDOT number"
        required
        inputMode="numeric"
        error={lookup.errors?.usdot}
        hint="Digits only — the number on your MC authority."
      />
      <Submit pending={looking}>{looking ? "Checking…" : "Continue"}</Submit>
    </form>
  );
}

function ContactStep({ slug, lookup }: { slug: string; lookup: LookupState }) {
  const [state, runStart, starting] = useActionState<StartState, FormData>(startAction, {});
  const found = lookup.carrier;

  return (
    <form action={runStart} className="space-y-4">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="usdot" value={lookup.usdot ?? found?.usdot ?? ""} />
      <input type="hidden" name="nameSource" value={found ? "fmcsa" : "manual"} />
      <input type="hidden" name="dbaName" value={found?.dbaName ?? ""} />
      <input type="hidden" name="state" value={found?.state ?? ""} />
      {found && (
        <input type="hidden" name="allowedToOperate" value={found.allowedToOperate ? "1" : "0"} />
      )}

      {state.errors?.form && <Alert>{state.errors.form}</Alert>}
      {lookup.reason && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
          {lookup.reason}
        </p>
      )}

      {found && (
        <div className="rounded-lg border border-line bg-white px-3.5 py-3 text-sm">
          <p className="font-semibold text-ink-900">{found.legalName}</p>
          {found.dbaName && <p className="text-ink-500">Trading as {found.dbaName}</p>}
          <p className="mt-1 text-xs text-ink-500">
            USDOT {found.usdot}
            {found.state ? ` · ${found.state}` : ""}
          </p>
          {!found.allowedToOperate && (
            // Shown, never used to refuse: whether to onboard is a commercial decision.
            <p className="mt-2 text-xs text-amber-700">
              FMCSA currently shows this carrier as not authorised to operate. You can still
              apply — we will go through it with you.
            </p>
          )}
        </div>
      )}

      {/* Editable even when FMCSA answered: the register can be stale, and a name is not
          normalised on somebody's behalf without them agreeing to it. */}
      <Text
        name="legalName"
        label="Company legal name"
        required
        defaultValue={found?.legalName ?? ""}
        error={state.errors?.legalName}
        hint={found ? "From the FMCSA register — correct it if it is out of date." : undefined}
      />
      <Text
        name="phone"
        label="Mobile number"
        type="tel"
        required
        error={state.errors?.phone}
        hint="We text a six-digit code to confirm it is you."
      />
      <Text name="email" label="Email" type="email" required error={state.errors?.email} />

      <Submit pending={starting}>{starting ? "Sending code…" : "Send my code"}</Submit>
    </form>
  );
}
