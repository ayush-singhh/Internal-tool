"use client";

import { useActionState } from "react";
import {
  revokeOtherSessionsAction, revokeSessionAction, type SessionState,
} from "@/lib/session-actions";
import type { ActiveSession } from "@/lib/sessions";
import { Badge } from "./ui";

/** Where this account is signed in, and how to end any of it. */
export function SessionsCard({ sessions }: { sessions: ActiveSession[] }) {
  const [state, action, pending] = useActionState<SessionState, FormData>(revokeSessionAction, {});
  const others = sessions.filter((s) => !s.current).length;

  return (
    <div className="space-y-4">
      {state.error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {state.ok}
        </p>
      )}

      <ul className="divide-y divide-line rounded-lg border border-line">
        {sessions.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
            <span className="text-sm font-medium text-ink-800" title={s.user_agent ?? undefined}>
              {s.device}
            </span>
            {s.current && <Badge tone="green">This browser</Badge>}
            <span className="text-xs text-ink-500">
              {s.ip ?? "unknown address"} · last used{" "}
              {new Date(s.last_seen_at ?? s.created_at).toLocaleString()}
            </span>
            {!s.current && (
              <form action={action} className="ml-auto">
                <input type="hidden" name="id" value={s.id} />
                <button
                  type="submit"
                  disabled={pending}
                  className="rounded px-2 py-1 text-xs font-medium text-ink-500 transition hover:bg-ink-100 hover:text-ink-900 disabled:opacity-50"
                >
                  Sign out
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>

      {others > 0 && (
        <form action={revokeOtherSessionsAction}>
          <button
            type="submit"
            className="rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-semibold text-ink-700 transition hover:bg-ink-50"
          >
            Sign out the other {others === 1 ? "session" : `${others} sessions`}
          </button>
        </form>
      )}
      <p className="text-xs leading-relaxed text-ink-500">
        A session ends the moment you sign it out — there is no token left working
        somewhere. The device name is read from the browser and is a label, not proof.
      </p>
    </div>
  );
}
