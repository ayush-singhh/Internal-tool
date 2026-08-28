import Link from "next/link";
import type { Slice, TrendPoint } from "@/lib/stats";
import type { Tone } from "@/lib/constants";

/**
 * Charts are inline SVG/CSS — no charting dependency.
 *
 * Colour follows the data's job. Every chart here compares magnitude across
 * categories, which is a *sequential* job: one hue, more-is-longer. Identity comes
 * from the direct text label on every row, never from colour, so nothing depends on
 * telling seven hues apart — a palette check showed the seven status colours are
 * indistinguishable in pairs (purple/blue ΔE 1.3 for deuteranopia). The status dot
 * beside a label reinforces the badge language the rest of the app uses; it is never
 * the only carrier of meaning.
 */
const SERIES = "#3a67ac"; // brand-500 — passes lightness band, chroma floor and 3:1 contrast

const DOT: Record<Tone, string> = {
  green: "bg-emerald-500",
  blue: "bg-blue-500",
  amber: "bg-amber-500",
  slate: "bg-ink-300",
  orange: "bg-orange-500",
  red: "bg-red-500",
  purple: "bg-purple-500",
};

export function BarList({
  data,
  emptyLabel = "No data yet",
  max: fixedMax,
  showDots = false,
  limit,
}: {
  data: Slice[];
  emptyLabel?: string;
  max?: number;
  showDots?: boolean;
  limit?: number;
}) {
  if (data.length === 0) {
    return <p className="py-6 text-center text-sm text-ink-400">{emptyLabel}</p>;
  }

  const rows = limit ? data.slice(0, limit) : data;
  const max = fixedMax ?? Math.max(...data.map((d) => d.value), 1);
  const total = data.reduce((sum, d) => sum + d.value, 0);

  return (
    <ul className="space-y-2.5">
      {rows.map((row) => {
        const pct = max === 0 ? 0 : (row.value / max) * 100;
        const share = total === 0 ? 0 : Math.round((row.value / total) * 100);
        const body = (
          <>
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-center gap-1.5">
                {showDots && (
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[row.tone ?? "slate"]}`}
                  />
                )}
                <span className="truncate text-[0.82rem] text-ink-700">{row.label}</span>
              </span>
              <span className="tnum shrink-0 text-[0.82rem] font-semibold text-ink-900">
                {row.value.toLocaleString()}
                <span className="ml-1.5 font-normal text-ink-400">{share}%</span>
              </span>
            </div>
            {/* Track is one step off the surface; the bar is a thin mark with a
                rounded data-end and a square baseline. */}
            <div className="h-2 w-full overflow-hidden rounded-sm bg-ink-100">
              <div
                className="h-full rounded-r-[4px]"
                style={{ width: `${Math.max(pct, row.value > 0 ? 2 : 0)}%`, background: SERIES }}
              />
            </div>
          </>
        );

        return (
          <li key={row.label}>
            {row.href ? (
              <Link
                href={row.href}
                title={`${row.label}: ${row.value.toLocaleString()} (${share}%)`}
                className="block rounded px-1 py-0.5 -mx-1 transition hover:bg-ink-50"
              >
                {body}
              </Link>
            ) : (
              <div title={`${row.label}: ${row.value.toLocaleString()} (${share}%)`}>{body}</div>
            )}
          </li>
        );
      })}
      {limit && data.length > limit && (
        <li className="pt-1 text-xs text-ink-400">
          + {data.length - limit} more
        </li>
      )}
    </ul>
  );
}

const MONTH_LABEL = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });

function monthShort(key: string): string {
  return MONTH_LABEL.format(new Date(`${key}-01T00:00:00Z`));
}

/** Single-series trend: 2px line, 10% area wash, 8px end marker with a surface ring. */
export function TrendChart({
  data,
  label,
  height = 132,
}: {
  data: TrendPoint[];
  label: string;
  height?: number;
}) {
  if (data.length === 0) {
    return <p className="py-6 text-center text-sm text-ink-400">No data yet</p>;
  }

  const W = 520;
  const H = height;
  const PAD = { top: 12, right: 14, bottom: 22, left: 26 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const max = Math.max(...data.map((d) => d.value), 1);
  // Round the axis top to a clean number rather than the raw maximum.
  const step = max <= 5 ? 1 : max <= 20 ? 5 : max <= 50 ? 10 : 25;
  const top = Math.ceil(max / step) * step;

  const x = (i: number) =>
    PAD.left + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / top) * innerH;

  const line = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(d.value)}`).join(" ");
  const area = `${line} L${x(data.length - 1)},${PAD.top + innerH} L${x(0)},${PAD.top + innerH} Z`;
  const last = data[data.length - 1]!;
  const ticks = [0, top / 2, top];

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${label}. ${data.map((d) => `${monthShort(d.month)}: ${d.value}`).join(", ")}.`}
      >
        {ticks.map((t) => (
          <g key={t}>
            {/* Hairline, solid, recessive — never dashed. */}
            <line
              x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)}
              stroke="var(--color-line)" strokeWidth="1" shapeRendering="crispEdges"
            />
            <text
              x={PAD.left - 6} y={y(t) + 3} textAnchor="end"
              className="fill-ink-400" style={{ fontSize: "9px" }}
            >
              {t}
            </text>
          </g>
        ))}

        <path d={area} fill={SERIES} opacity="0.1" />
        <path d={line} fill="none" stroke={SERIES} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

        {data.map((d, i) => (
          <g key={d.month}>
            {/* Generous invisible hit target, then the visible marker. */}
            <circle cx={x(i)} cy={y(d.value)} r="10" fill="transparent">
              <title>{`${monthShort(d.month)} ${d.month.slice(0, 4)}: ${d.value}`}</title>
            </circle>
            {i === data.length - 1 && (
              <circle
                cx={x(i)} cy={y(d.value)} r="4"
                fill={SERIES} stroke="var(--color-surface)" strokeWidth="2"
              />
            )}
          </g>
        ))}

        {data.map((d, i) =>
          // Every other month, so labels never collide at this width.
          i % 2 === 0 || i === data.length - 1 ? (
            <text
              key={`l-${d.month}`}
              x={x(i)} y={H - 6} textAnchor="middle"
              className="fill-ink-400" style={{ fontSize: "9px" }}
            >
              {monthShort(d.month)}
            </text>
          ) : null,
        )}

        {/* Only the endpoint is labelled — a number on every point goes unread. */}
        <text
          x={x(data.length - 1)} y={y(last.value) - 9} textAnchor="end"
          className="fill-ink-900" style={{ fontSize: "10px", fontWeight: 600 }}
        >
          {last.value}
        </text>
      </svg>
    </figure>
  );
}

export function StatTile({
  label,
  value,
  hint,
  href,
  tone,
  emphasis = false,
}: {
  label: string;
  value: number | string;
  hint?: string;
  href?: string;
  tone?: Tone;
  emphasis?: boolean;
}) {
  const content = (
    <>
      <div className="flex items-center gap-1.5">
        {tone && (
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${DOT[tone]}`} />
        )}
        <p className="text-xs font-medium text-ink-500">{label}</p>
      </div>
      <p
        className={`tnum mt-1.5 font-semibold tracking-tight text-ink-900 ${
          emphasis ? "text-[2rem] leading-none" : "text-[1.5rem] leading-none"
        }`}
      >
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
      {hint && <p className="mt-1 text-xs text-ink-400">{hint}</p>}
    </>
  );

  const className = `block rounded-card border border-line bg-surface p-4 shadow-card transition ${
    href ? "hover:border-brand-300 hover:shadow-raised" : ""
  }`;

  return href ? (
    <Link href={href} className={className}>{content}</Link>
  ) : (
    <div className={className}>{content}</div>
  );
}
