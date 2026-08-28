import type { ActivityRow, ActivityType } from "@/lib/activity";
import { formatDateTime, relativeTime } from "@/lib/format";
import type { Tone } from "@/lib/constants";

const TYPE_TONE: Record<ActivityType, Tone> = {
  created: "blue",
  status: "purple",
  assignment: "blue",
  pricing: "green",
  agreement: "amber",
  subscription: "green",
  offboarding: "red",
  reactivation: "green",
  note: "amber",
  field: "slate",
  import: "slate",
};

const DOT: Record<Tone, string> = {
  green: "bg-emerald-500",
  blue: "bg-blue-500",
  amber: "bg-amber-500",
  slate: "bg-ink-300",
  orange: "bg-orange-500",
  red: "bg-red-500",
  purple: "bg-purple-500",
};

export function ActivityTimeline({ entries }: { entries: ActivityRow[] }) {
  if (entries.length === 0) {
    return <p className="py-4 text-center text-sm text-ink-400">No recorded changes yet.</p>;
  }

  return (
    <ol className="relative space-y-4 pl-5">
      <span
        aria-hidden="true"
        className="absolute bottom-2 left-[0.3rem] top-2 w-px bg-line"
      />
      {entries.map((e) => (
        <li key={e.id} className="relative">
          <span
            aria-hidden="true"
            className={`absolute -left-[0.98rem] top-[0.3rem] h-2 w-2 rounded-full ring-2 ring-surface ${
              DOT[TYPE_TONE[e.type] ?? "slate"]
            }`}
          />
          <p className="text-[0.83rem] leading-snug text-ink-800">{e.summary}</p>
          {e.old_value !== null && e.new_value !== null && (
            <p className="mt-0.5 text-xs text-ink-500">
              <span className="line-through decoration-ink-300">{e.old_value || "—"}</span>
              {" → "}
              <span className="font-medium text-ink-700">{e.new_value || "—"}</span>
            </p>
          )}
          <p className="mt-0.5 text-xs text-ink-400">
            <span title={formatDateTime(e.created_at)}>{formatDateTime(e.created_at)}</span>
            {" · "}
            {e.user_name ?? "System"}
            {" · "}
            {relativeTime(e.created_at)}
          </p>
        </li>
      ))}
    </ol>
  );
}
