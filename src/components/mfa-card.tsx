"use client";

import Image from "next/image";
import { useActionState, useState } from "react";
import {
  activateAction,
  beginEnrollmentAction,
  cancelEnrollmentAction,
  disableAction,
  regenerateRecoveryCodesAction,
  type MfaFormState,
} from "@/lib/mfa-actions";
import type { MfaState } from "@/lib/mfa";
import { Text } from "./form-fields";
import { Badge } from "./ui";

const BUTTON =
  "rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60";

function Alert({ state }: { state: MfaFormState }) {
  if (state.error) {
    return (
      <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {state.error}
      </p>
    );
  }
  if (state.ok) {
    return (
      <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
        {state.ok}
      </p>
    );
  }
  return null;
}

function RecoveryCodesGrid({ codes }: { codes: string[] }) {
  return (
    <ul className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-paper-50 p-4 font-mono text-sm sm:grid-cols-3">
      {codes.map((code) => (
        <li key={code} className="tnum text-ink-800">{code}</li>
      ))}
    </ul>
  );
}

/**
 * The whole second-factor lifecycle in one card, because it is one decision: off, being
 * set up, or on. `qrUri` is rendered on the server — the secret is never sent to the
 * browser except as the image and the typed-entry string on this page.
 */
export function MfaCard({ state, qrUri }: { state: MfaState; qrUri: string | null }) {
  const [activation, activateFormAction, activating] = useActionState<MfaFormState, FormData>(
    activateAction,
    {},
  );
  const [removal, disableFormAction, disabling] = useActionState<MfaFormState, FormData>(
    disableAction,
    {},
  );
  const [regeneration, regenerateFormAction, regenerating] = useActionState<MfaFormState, FormData>(
    regenerateRecoveryCodesAction,
    {},
  );
  const [showRegenerate, setShowRegenerate] = useState(false);

  // Shown exactly once, straight after activation: they are stored only as hashes.
  if (activation.recoveryCodes) {
    return (
      <div className="space-y-4">
        <Alert state={activation} />
        <p className="text-sm text-ink-700">
          Save these recovery codes now. Each one signs you in once if you lose your phone,
          and this is the only time they can be shown.
        </p>
        <RecoveryCodesGrid codes={activation.recoveryCodes} />
      </div>
    );
  }

  if (regeneration.recoveryCodes) {
    return (
      <div className="space-y-4">
        <Alert state={regeneration} />
        <p className="text-sm text-ink-700">
          Save these recovery codes now. The old ones no longer work, and this is the only
          time these can be shown.
        </p>
        <RecoveryCodesGrid codes={regeneration.recoveryCodes} />
      </div>
    );
  }

  if (state.active) {
    return (
      <div className="space-y-6">
        <form action={disableFormAction} className="space-y-4">
          <Alert state={removal} />
          <p className="flex flex-wrap items-center gap-2 text-sm text-ink-700">
            <Badge tone="green">On</Badge>
            <span>
              Since {new Date(state.activatedAt!).toLocaleDateString()} ·{" "}
              <span className="tnum">{state.recoveryRemaining}</span> recovery code
              {state.recoveryRemaining === 1 ? "" : "s"} left
            </span>
          </p>
          <div className="max-w-xs">
            <Text
              name="code"
              label="Code from your app"
              inputMode="numeric"
              required
              placeholder="000000"
              hint="Confirms it is you before the second factor comes off."
            />
          </div>
          <button type="submit" disabled={disabling} className={BUTTON}>
            {disabling ? "Turning off…" : "Turn off two-factor"}
          </button>
        </form>

        {showRegenerate ? (
          <form action={regenerateFormAction} className="space-y-4 border-t border-line pt-4">
            <Alert state={regeneration} />
            <div className="max-w-xs">
              <Text
                name="code"
                label="Code from your app"
                inputMode="numeric"
                required
                placeholder="000000"
                hint="Issues a fresh set of ten and retires the old ones."
              />
            </div>
            <button type="submit" disabled={regenerating} className={BUTTON}>
              {regenerating ? "Issuing…" : "Get new recovery codes"}
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setShowRegenerate(true)}
            className="text-xs text-ink-500 underline hover:text-ink-800"
          >
            Get new recovery codes
          </button>
        )}
      </div>
    );
  }

  if (state.enrolling && qrUri) {
    return (
      <div className="space-y-4">
        <Alert state={activation} />
        <div className="flex flex-wrap items-start gap-6">
          <Image
            src={qrUri}
            alt="QR code for your authenticator app"
            width={168}
            height={168}
            unoptimized
            className="rounded-lg border border-line bg-white p-2"
          />
          <div className="space-y-2 text-sm text-ink-700">
            <p>Scan this with Google Authenticator, 1Password, Authy or similar.</p>
            <p className="text-ink-500">Cannot scan? Type this key instead:</p>
            <code className="block break-all rounded border border-line bg-paper-50 px-2 py-1 font-mono text-xs text-ink-800">
              {state.secretText}
            </code>
          </div>
        </div>
        <form action={activateFormAction} className="space-y-4">
          <div className="max-w-xs">
            <Text
              name="code"
              label="Enter the six-digit code it shows"
              inputMode="numeric"
              required
              placeholder="000000"
              hint="Nothing changes until this code checks out."
            />
          </div>
          <button type="submit" disabled={activating} className={BUTTON}>
            {activating ? "Checking…" : "Turn on two-factor"}
          </button>
        </form>
        <form action={cancelEnrollmentAction}>
          <button type="submit" className="text-xs text-ink-500 underline hover:text-ink-800">
            Cancel setup
          </button>
        </form>
      </div>
    );
  }

  return (
    <form action={beginEnrollmentAction} className="space-y-4">
      <p className="text-sm text-ink-700">
        A password alone is one stolen note away from someone else. With this on, signing
        in also needs a code from your phone.
      </p>
      <button type="submit" className={BUTTON}>Set up two-factor</button>
    </form>
  );
}
