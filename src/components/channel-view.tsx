"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef } from "react";
import {
  postMessageAction, createChannelAction, archiveChannelAction, type CommsState,
} from "@/lib/communication-actions";
import type { ChannelRow, MessageRow } from "@/lib/communication";
import { relativeTime } from "@/lib/format";
import { Badge, Banner, Dialog, DialogActions, EmptyState } from "./ui";
import { Icon } from "./icons";
import { Text, TextArea } from "./form-fields";

export type AudienceOption = { value: string; label: string };

export function ChannelView({
  channels,
  active,
  messages,
  audiences,
  canManage,
  canPost,
  currentUserId,
}: {
  channels: ChannelRow[];
  active: ChannelRow | null;
  messages: MessageRow[];
  audiences: AudienceOption[];
  canManage: boolean;
  canPost: boolean;
  currentUserId: number;
}) {
  const newChannelRef = useRef<HTMLDialogElement>(null);

  if (channels.length === 0) {
    return (
      <EmptyState
        title="No channels"
        description="There is nowhere to talk yet. An administrator can open a channel for the whole company or for one team."
        action={
          canManage ? (
            <button
              type="button"
              onClick={() => newChannelRef.current?.showModal()}
              className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              Open the first channel
            </button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[15rem_1fr]">
      <aside className="space-y-2">
        {canManage && (
          <button
            type="button"
            onClick={() => newChannelRef.current?.showModal()}
            className="flex w-full items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm font-medium text-ink-700 transition hover:bg-ink-50"
          >
            <Icon name="plus" className="h-4 w-4" />
            New channel
          </button>
        )}
        <nav className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
          <ul className="divide-y divide-line">
            {channels.map((channel) => {
              const current = active?.id === channel.id;
              return (
                <li key={channel.id}>
                  <Link
                    href={`/communication?channel=${channel.id}`}
                    aria-current={current ? "page" : undefined}
                    className={`flex items-center justify-between gap-2 px-3.5 py-2.5 text-sm transition ${
                      current ? "bg-brand-50 font-semibold text-brand-800" : "text-ink-700 hover:bg-ink-50"
                    }`}
                  >
                    <span className="min-w-0 truncate">
                      {channel.name}
                      {channel.archived === 1 && (
                        <span className="ml-1.5 text-xs font-normal text-ink-400">archived</span>
                      )}
                    </span>
                    {channel.unread > 0 && <Badge tone="purple">{channel.unread}</Badge>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>

      <section className="flex min-h-[28rem] flex-col overflow-hidden rounded-card border border-line bg-surface shadow-card">
        {active === null ? (
          <div className="flex flex-1 items-center justify-center p-8 text-sm text-ink-400">
            Pick a channel.
          </div>
        ) : (
          <>
            <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-ink-900">{active.name}</h2>
                <p className="mt-0.5 text-xs text-ink-500">
                  {active.description ?? "No description."}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge tone={active.audience === "all" ? "slate" : "blue"}>
                  {audiences.find((a) => a.value === active.audience)?.label ?? active.audience}
                </Badge>
                {canManage && active.seeded === 0 && (
                  <form action={archiveChannelAction}>
                    <input type="hidden" name="id" value={active.id} />
                    <input type="hidden" name="archived" value={active.archived ? "0" : "1"} />
                    <button
                      type="submit"
                      className="rounded px-2 py-1 text-xs font-medium text-ink-500 transition hover:bg-ink-100 hover:text-ink-900"
                    >
                      {active.archived ? "Reopen" : "Archive"}
                    </button>
                  </form>
                )}
              </div>
            </header>

            <MessageList messages={messages} currentUserId={currentUserId} />

            {active.archived === 1 ? (
              <p className="border-t border-line px-4 py-3 text-xs text-ink-500">
                This channel is archived. Everything said in it is kept; nothing new can be added.
              </p>
            ) : canPost ? (
              <Composer channelId={active.id} channelName={active.name} />
            ) : (
              <p className="border-t border-line px-4 py-3 text-xs text-ink-500">
                You can read this channel but not post to it.
              </p>
            )}
          </>
        )}
      </section>

      {canManage && (
        <Dialog ref={newChannelRef} title="Open a channel">
          <NewChannelForm audiences={audiences} dialogRef={newChannelRef} />
        </Dialog>
      )}
    </div>
  );
}

function MessageList({ messages, currentUserId }: { messages: MessageRow[]; currentUserId: number }) {
  const endRef = useRef<HTMLDivElement>(null);

  // A conversation is read at the bottom. Jumping there on load is the difference between
  // "here is what was just said" and "here is what was said the day this channel opened".
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-ink-400">
        Nothing here yet. Say something.
      </div>
    );
  }

  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-4">
      {messages.map((message, i) => {
        // Consecutive messages from one person are one block: repeating the name on every
        // line turns a conversation into a log.
        const sameAuthor = i > 0 && messages[i - 1]!.author_id === message.author_id;
        const mine = message.author_id === currentUserId;
        return (
          <div key={message.id} className={sameAuthor ? "" : "pt-1"}>
            {!sameAuthor && (
              <p className="mb-0.5 flex items-baseline gap-2">
                <span className={`text-xs font-semibold ${mine ? "text-brand-700" : "text-ink-800"}`}>
                  {mine ? "You" : (message.author_name ?? "Someone")}
                </span>
                <span className="text-[0.68rem] text-ink-400">{relativeTime(message.created_at)}</span>
              </p>
            )}
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-700">
              {message.body}
            </p>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}

function Composer({ channelId, channelName }: { channelId: number; channelName: string }) {
  const [state, action, pending] = useActionState<CommsState, FormData>(postMessageAction, {});
  const formRef = useRef<HTMLFormElement>(null);

  // Cleared on a successful post — the action returns an empty state for that, so a
  // failure keeps what was typed rather than throwing the message away with the error.
  useEffect(() => {
    if (!pending && !state.error) formRef.current?.reset();
  }, [pending, state]);

  return (
    <form ref={formRef} action={action} className="border-t border-line p-3">
      <input type="hidden" name="channel_id" value={channelId} />
      {state.error && (
        <p role="alert" className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {state.error}
        </p>
      )}
      <div className="flex items-end gap-2">
        <label htmlFor="body" className="sr-only">{`Message ${channelName}`}</label>
        <textarea
          id="body"
          name="body"
          rows={2}
          required
          maxLength={4000}
          placeholder={`Message ${channelName}…`}
          className="field flex-1 resize-y"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
        >
          {pending ? "Sending…" : "Send"}
        </button>
      </div>
      <p className="mt-1.5 text-[0.68rem] text-ink-400">
        Messages cannot be edited or deleted. Correct one by sending another.
      </p>
    </form>
  );
}

function NewChannelForm({
  audiences,
  dialogRef,
}: {
  audiences: AudienceOption[];
  dialogRef: React.RefObject<HTMLDialogElement | null>;
}) {
  const [state, action, pending] = useActionState<CommsState, FormData>(createChannelAction, {});
  return (
    <form action={action} className="space-y-4">
      <Banner state={state} />
      <Text name="name" label="Name" required />
      <TextArea name="description" label="What is it for" rows={2} />
      <div>
        <label htmlFor="audience" className="mb-1 block text-xs font-medium text-ink-600">
          Who can read it
        </label>
        <select id="audience" name="audience" defaultValue="all" className="field">
          {audiences.map((a) => (
            <option key={a.value} value={a.value}>{a.label}</option>
          ))}
        </select>
        <p className="mt-1 text-xs text-ink-500">
          Administrators can read every channel. This cannot be changed afterwards.
        </p>
      </div>
      <DialogActions dialogRef={dialogRef} pending={pending} label="Open channel" />
    </form>
  );
}
