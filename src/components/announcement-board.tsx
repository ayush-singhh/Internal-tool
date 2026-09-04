"use client";

import { useActionState, useRef, useState } from "react";
import {
  saveAnnouncementAction, deleteAnnouncementAction, type AnnouncementState,
} from "@/lib/announcement-actions";
import type { AnnouncementRow } from "@/lib/announcements";
import { relativeTime } from "@/lib/format";
import { Banner, Dialog, DialogActions, EmptyState } from "./ui";
import { Icon } from "./icons";
import { Text, TextArea } from "./form-fields";

export function AnnouncementBoard({
  announcements,
  canManage,
  /** Everything published after this was new when the page was opened. */
  unreadSince,
}: {
  announcements: AnnouncementRow[];
  canManage: boolean;
  unreadSince: string | null;
}) {
  const [editing, setEditing] = useState<AnnouncementRow | null>(null);
  const addRef = useRef<HTMLDialogElement>(null);
  const editRef = useRef<HTMLDialogElement>(null);

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => addRef.current?.showModal()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
          >
            <Icon name="plus" className="h-4 w-4" />
            Post announcement
          </button>
        </div>
      )}

      {announcements.length === 0 ? (
        <EmptyState
          title="Nothing posted yet"
          description={
            canManage
              ? "An announcement goes to everybody in the organisation. Post one when something is worth everyone's attention."
              : "When someone posts to the whole organisation, it will appear here."
          }
          action={
            canManage ? (
              <button
                type="button"
                onClick={() => addRef.current?.showModal()}
                className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700"
              >
                Post the first announcement
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          {announcements.map((a) => {
            const isNew = unreadSince === null || a.published_at > unreadSince;
            return (
              <article
                key={a.id}
                className={`rounded-card border bg-surface p-4 shadow-card ${
                  isNew ? "border-brand-300 ring-1 ring-brand-100" : "border-line"
                }`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-900">
                    {isNew && (
                      <span className="rounded-full bg-brand-600 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-white">
                        New
                      </span>
                    )}
                    {a.title}
                  </h2>
                  <p className="text-xs text-ink-400">
                    {a.author_name ?? "System"} · {relativeTime(a.published_at)}
                  </p>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-700">{a.body}</p>
                {canManage && (
                  <div className="mt-3 flex justify-end gap-2 border-t border-line pt-2.5">
                    <button
                      type="button"
                      onClick={() => { setEditing(a); editRef.current?.showModal(); }}
                      className="rounded px-2 py-1 text-xs font-medium text-ink-500 transition hover:bg-ink-100 hover:text-ink-900"
                    >
                      Edit
                    </button>
                    <form action={deleteAnnouncementAction}>
                      <input type="hidden" name="id" value={a.id} />
                      <button
                        type="submit"
                        className="rounded px-2 py-1 text-xs font-medium text-red-600 transition hover:bg-red-50"
                      >
                        Withdraw
                      </button>
                    </form>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {canManage && (
        <>
          <Dialog ref={addRef} title="Post an announcement">
            <AnnouncementForm dialogRef={addRef} />
          </Dialog>
          <Dialog ref={editRef} title={editing ? `Edit “${editing.title}”` : "Edit announcement"}>
            {editing && <AnnouncementForm announcement={editing} dialogRef={editRef} />}
          </Dialog>
        </>
      )}
    </div>
  );
}

function AnnouncementForm({
  announcement,
  dialogRef,
}: {
  announcement?: AnnouncementRow;
  dialogRef: React.RefObject<HTMLDialogElement | null>;
}) {
  const [state, action, pending] = useActionState<AnnouncementState, FormData>(
    saveAnnouncementAction,
    {},
  );
  return (
    <form action={action} className="space-y-4">
      {announcement && <input type="hidden" name="id" value={announcement.id} />}
      <Banner state={state} />
      <Text name="title" label="Title" required defaultValue={announcement?.title} />
      <TextArea name="body" label="Message" defaultValue={announcement?.body ?? ""} rows={6} />
      {announcement && (
        <p className="text-xs text-ink-500">
          Editing does not re-publish. The notice keeps its original date, so fixing a typo
          will not push it back to the top of everybody&rsquo;s unread list.
        </p>
      )}
      <DialogActions
        dialogRef={dialogRef}
        pending={pending}
        label={announcement ? "Save changes" : "Post"}
      />
    </form>
  );
}
