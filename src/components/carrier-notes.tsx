"use client";

import { useActionState, useEffect, useRef } from "react";
import { addNoteAction, toggleNotePinAction, type NoteState } from "@/lib/note-actions";
import { formatDateTime, relativeTime } from "@/lib/format";
import { Icon } from "./icons";

export type NoteView = {
  id: number;
  body: string;
  pinned: number;
  created_at: string;
  user_name: string | null;
};

function initials(name: string | null) {
  if (!name) return "?";
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
}

export function CarrierNotes({
  carrierId,
  notes,
  canWrite,
}: {
  carrierId: number;
  notes: NoteView[];
  canWrite: boolean;
}) {
  const [state, action, pending] = useActionState<NoteState, FormData>(addNoteAction, {});
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state.ok]);

  return (
    <div className="space-y-4">
      {canWrite && (
        <form ref={formRef} action={action} className="space-y-2">
          <input type="hidden" name="carrierId" value={carrierId} />
          <textarea
            name="body"
            rows={3}
            required
            maxLength={4000}
            placeholder="Add an internal note — call outcome, paperwork status, anything the next person needs."
            className="field resize-y"
          />
          {state.error && (
            <p role="alert" className="text-xs text-red-600">{state.error}</p>
          )}
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-1.5 text-xs text-ink-600">
              <input
                type="checkbox"
                name="important"
                className="h-3.5 w-3.5 accent-[var(--color-brand-600)]"
              />
              Mark important (adds to activity history)
            </label>
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-[0.8rem] font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
            >
              {pending ? "Saving…" : "Add note"}
            </button>
          </div>
        </form>
      )}

      {notes.length === 0 ? (
        <p className="py-4 text-center text-sm text-ink-400">No notes yet.</p>
      ) : (
        <ul className="space-y-3">
          {notes.map((note) => (
            <li
              key={note.id}
              className={`rounded-lg border p-3 ${
                note.pinned
                  ? "border-amber-200 bg-amber-50/60"
                  : "border-line bg-ink-50/50"
              }`}
            >
              <div className="mb-1.5 flex items-center gap-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-600 text-[0.6rem] font-semibold text-white">
                  {initials(note.user_name)}
                </span>
                <span className="text-xs font-medium text-ink-800">
                  {note.user_name ?? "Unknown user"}
                </span>
                <span
                  className="text-xs text-ink-400"
                  title={formatDateTime(note.created_at)}
                >
                  {relativeTime(note.created_at)}
                </span>
                {canWrite && (
                  <form action={toggleNotePinAction} className="ml-auto">
                    <input type="hidden" name="noteId" value={note.id} />
                    <button
                      type="submit"
                      title={note.pinned ? "Unmark as important" : "Mark as important"}
                      className={`rounded p-1 transition ${
                        note.pinned
                          ? "text-amber-600 hover:text-amber-700"
                          : "text-ink-300 hover:text-ink-600"
                      }`}
                    >
                      <Icon name="warning" className="h-3.5 w-3.5" />
                    </button>
                  </form>
                )}
              </div>
              <p className="whitespace-pre-wrap text-[0.83rem] leading-relaxed text-ink-700">
                {note.body}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
