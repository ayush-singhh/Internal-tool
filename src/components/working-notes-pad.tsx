"use client";

import { useActionState } from "react";
import {
  saveWorkingNotesAction, type WorkingNotesState,
} from "@/lib/working-notes-actions";
import { relativeTime } from "@/lib/format";
import { Banner } from "./ui";

/**
 * A textarea and a save button. That is the whole feature.
 *
 * ponytail: no autosave, no draft in localStorage, no rich text. Add autosave the first
 * time somebody loses a page of typing — until then a Save button is a promise the page
 * can actually keep.
 */
export function WorkingNotesPad({
  body,
  savedAt,
  maxLength,
}: {
  body: string;
  savedAt: string | null;
  maxLength: number;
}) {
  const [state, action, pending] = useActionState<WorkingNotesState, FormData>(
    saveWorkingNotesAction,
    {},
  );

  return (
    <form action={action} className="space-y-3">
      <Banner state={state} />
      <textarea
        name="body"
        rows={22}
        defaultValue={body}
        maxLength={maxLength}
        aria-label="Working notes"
        placeholder="Numbers to call back, lanes worth remembering, what you told the broker on Tuesday. Nobody else can read this."
        className="field resize-y font-mono text-[0.82rem] leading-relaxed"
      />
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-ink-400">
          {savedAt ? `Last saved ${relativeTime(savedAt)}` : "Not saved yet"}
        </p>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
