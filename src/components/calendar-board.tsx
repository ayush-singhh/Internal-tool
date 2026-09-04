"use client";

import Link from "next/link";
import { useActionState, useRef, useState } from "react";
import { saveEventAction, deleteEventAction, type CalendarState } from "@/lib/calendar-actions";
import type { CalendarEntry, EntryKind } from "@/lib/calendar";
import { Banner, Dialog, DialogActions } from "./ui";
import { Icon } from "./icons";
import { Text, Select, TextArea, type FormOption } from "./form-fields";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** One colour per source, used on the chips and in the key below the grid. */
const KIND_STYLE: Record<EntryKind, { dot: string; chip: string; label: string }> = {
  event:     { dot: "bg-blue-500",    chip: "bg-blue-50 text-blue-900 hover:bg-blue-100",       label: "Event" },
  pickup:    { dot: "bg-amber-500",   chip: "bg-amber-50 text-amber-900 hover:bg-amber-100",    label: "Pickup" },
  delivery:  { dot: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-900 hover:bg-emerald-100", label: "Delivery" },
  task:      { dot: "bg-purple-500",  chip: "bg-purple-50 text-purple-900 hover:bg-purple-100", label: "Task due" },
  insurance: { dot: "bg-red-500",     chip: "bg-red-50 text-red-900 hover:bg-red-100",          label: "Insurance expiry" },
};

export function CalendarBoard({
  month,
  label,
  days,
  leadingBlanks,
  previous,
  next,
  today,
  entries,
  carriers,
  canManage,
}: {
  month: string;
  label: string;
  days: string[];
  leadingBlanks: number;
  previous: string;
  next: string;
  today: string;
  entries: CalendarEntry[];
  carriers: FormOption[];
  canManage: boolean;
}) {
  const [editing, setEditing] = useState<CalendarEntry | null>(null);
  const [addDate, setAddDate] = useState<string>(today);
  const addRef = useRef<HTMLDialogElement>(null);
  const editRef = useRef<HTMLDialogElement>(null);

  const byDay = new Map<string, CalendarEntry[]>();
  for (const entry of entries) {
    const list = byDay.get(entry.date);
    if (list) list.push(entry);
    else byDay.set(entry.date, [entry]);
  }

  const openAdd = (date: string) => {
    setAddDate(date);
    addRef.current?.showModal();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <Link
            href={`/calendar?month=${previous}`}
            aria-label="Previous month"
            className="rounded-lg border border-line-strong bg-surface p-2 text-ink-600 transition hover:bg-ink-50"
          >
            <Icon name="back" className="h-4 w-4" />
          </Link>
          <Link
            href={`/calendar?month=${next}`}
            aria-label="Next month"
            className="rounded-lg border border-line-strong bg-surface p-2 text-ink-600 transition hover:bg-ink-50"
          >
            <Icon name="chevron" className="h-4 w-4" />
          </Link>
          <h2 className="ml-1.5 text-sm font-semibold text-ink-900">{label}</h2>
          {month !== today.slice(0, 7) && (
            <Link
              href="/calendar"
              className="ml-1.5 rounded-lg px-2 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50"
            >
              Today
            </Link>
          )}
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => openAdd(today.slice(0, 7) === month ? today : days[0]!)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
          >
            <Icon name="plus" className="h-4 w-4" />
            New event
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
        <div className="grid grid-cols-7 border-b border-line bg-ink-50/70">
          {WEEKDAYS.map((day) => (
            <div key={day} className="px-2 py-2 text-center text-xs font-semibold text-ink-600">
              {day}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {Array.from({ length: leadingBlanks }, (_, i) => (
            <div key={`blank-${i}`} className="min-h-[6.5rem] border-b border-r border-line/70 bg-ink-50/30" />
          ))}
          {days.map((date) => {
            const dayEntries = byDay.get(date) ?? [];
            const isToday = date === today;
            return (
              <div
                key={date}
                className={`min-h-[6.5rem] border-b border-r border-line/70 p-1.5 ${
                  isToday ? "bg-brand-50/40" : ""
                }`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`tnum text-xs ${
                      isToday
                        ? "flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 font-semibold text-white"
                        : "text-ink-500"
                    }`}
                  >
                    {Number(date.slice(8))}
                  </span>
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => openAdd(date)}
                      aria-label={`Add an event on ${date}`}
                      className="rounded p-0.5 text-ink-300 transition hover:bg-ink-100 hover:text-ink-700"
                    >
                      <Icon name="plus" className="h-3 w-3" />
                    </button>
                  )}
                </div>
                <ul className="mt-1 space-y-1">
                  {dayEntries.map((entry) => (
                    <li key={entry.key}>
                      <EntryChip
                        entry={entry}
                        canManage={canManage}
                        onEdit={() => { setEditing(entry); editRef.current?.showModal(); }}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-500">
        {(Object.keys(KIND_STYLE) as EntryKind[]).map((kind) => (
          <span key={kind} className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${KIND_STYLE[kind].dot}`} />
            {KIND_STYLE[kind].label}
          </span>
        ))}
      </div>

      <p className="text-xs text-ink-500">
        Only events are edited here. A pickup, a task due date or an insurance expiry is a
        window onto the record it belongs to — change it there, and the calendar follows.
      </p>

      {canManage && (
        <>
          <Dialog ref={addRef} title="New event">
            <EventForm date={addDate} carriers={carriers} dialogRef={addRef} />
          </Dialog>
          <Dialog ref={editRef} title={editing ? `Edit “${editing.title}”` : "Edit event"}>
            {editing?.eventId !== undefined && (
              <EventForm entry={editing} carriers={carriers} dialogRef={editRef} />
            )}
          </Dialog>
        </>
      )}
    </div>
  );
}

/**
 * A derived entry links to the record it came from; an event opens its editor. That
 * difference is the whole model, so the chip renders it rather than hiding it behind a
 * uniform click target that does two different things.
 */
function EntryChip({
  entry,
  canManage,
  onEdit,
}: {
  entry: CalendarEntry;
  canManage: boolean;
  onEdit: () => void;
}) {
  const style = KIND_STYLE[entry.kind];
  const inner = (
    <>
      {entry.time && <span className="tnum mr-1 font-semibold">{entry.time}</span>}
      {entry.title}
      {entry.detail && <span className="block truncate opacity-70">{entry.detail}</span>}
    </>
  );
  const className = `block w-full truncate rounded px-1.5 py-1 text-left text-[0.68rem] leading-tight transition ${style.chip}`;

  if (entry.eventId !== undefined) {
    return canManage ? (
      <button type="button" onClick={onEdit} className={className} title={entry.title}>
        {inner}
      </button>
    ) : (
      <span className={className} title={entry.title}>{inner}</span>
    );
  }
  return entry.href ? (
    <Link href={entry.href} className={className} title={entry.title}>{inner}</Link>
  ) : (
    <span className={className} title={entry.title}>{inner}</span>
  );
}

function EventForm({
  entry,
  date,
  carriers,
  dialogRef,
}: {
  entry?: CalendarEntry;
  date?: string;
  carriers: FormOption[];
  dialogRef: React.RefObject<HTMLDialogElement | null>;
}) {
  const [state, action, pending] = useActionState<CalendarState, FormData>(saveEventAction, {});
  return (
    <div className="space-y-3">
      <form action={action} className="space-y-4">
        {entry?.eventId !== undefined && <input type="hidden" name="id" value={entry.eventId} />}
        <Banner state={state} />
        <Text name="title" label="Event" required defaultValue={entry?.title} />
        <div className="grid gap-4 sm:grid-cols-3">
          <Text name="starts_on" label="Date" type="date" required defaultValue={entry?.date ?? date} />
          <Text name="ends_on" label="Ends" type="date" hint="Only for something spanning days." />
          <Text name="starts_at" label="Time" type="time" defaultValue={entry?.time ?? ""} />
        </div>
        {carriers.length > 0 && (
          <Select name="carrier_id" label="About carrier" options={carriers} placeholder="None" />
        )}
        <TextArea name="details" label="Details" rows={2} />
        <DialogActions dialogRef={dialogRef} pending={pending} label={entry ? "Save changes" : "Add event"} />
      </form>

      {entry?.eventId !== undefined && (
        <form action={deleteEventAction} className="border-t border-line pt-3">
          <input type="hidden" name="id" value={entry.eventId} />
          <button
            type="submit"
            className="text-xs font-medium text-red-600 transition hover:underline"
          >
            Remove this event
          </button>
        </form>
      )}
    </div>
  );
}
