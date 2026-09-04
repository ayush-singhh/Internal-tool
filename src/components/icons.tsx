/** Monoline 20px icon set. Inline SVG beats an icon dependency for a fixed set this small. */
const base = {
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export type IconName =
  | "dashboard" | "carriers" | "active" | "onboarding" | "offboarded"
  | "investigations" | "reports" | "team" | "settings" | "import"
  | "search" | "plus" | "filter" | "chevron" | "columns" | "download"
  | "logout" | "note" | "history" | "warning" | "check" | "close" | "edit" | "back"
  | "loads" | "drivers" | "brokers" | "leads" | "chat" | "calendar" | "money";

const PATHS: Record<IconName, React.ReactNode> = {
  dashboard: <><rect x="2.5" y="2.5" width="6" height="6" rx="1.3"/><rect x="11.5" y="2.5" width="6" height="6" rx="1.3"/><rect x="2.5" y="11.5" width="6" height="6" rx="1.3"/><rect x="11.5" y="11.5" width="6" height="6" rx="1.3"/></>,
  carriers: <><rect x="1.8" y="5" width="11" height="8" rx="1.5"/><path d="M12.8 7.5h2.6a1.4 1.4 0 0 1 1.2.68l1.3 2.2a1.4 1.4 0 0 1 .2.72V12a1 1 0 0 1-1 1h-4.3"/><circle cx="6" cy="15" r="1.8"/><circle cx="14.4" cy="15" r="1.8"/></>,
  active: <><circle cx="10" cy="10" r="7.3"/><path d="m6.9 10.2 2.1 2.1 4.1-4.4"/></>,
  // A funnel — the pipeline, narrowing toward a carrier.
  leads: <><path d="M3 3.6h14l-5.4 6.4v6.2l-3.2-1.8v-4.4L3 3.6Z"/></>,
  chat: <><path d="M3.2 5.4a1.8 1.8 0 0 1 1.8-1.8h10a1.8 1.8 0 0 1 1.8 1.8v6.4a1.8 1.8 0 0 1-1.8 1.8H8.2l-4 3v-3H5a1.8 1.8 0 0 1-1.8-1.8V5.4Z"/></>,
  calendar: <><rect x="2.8" y="4.4" width="14.4" height="12.4" rx="1.6"/><path d="M2.8 8.2h14.4M6.6 2.8v3M13.4 2.8v3"/></>,
  onboarding: <><path d="M10 2.6v9.8M6.6 9l3.4 3.4L13.4 9"/><path d="M3.2 13.4v2.2a1.8 1.8 0 0 0 1.8 1.8h10a1.8 1.8 0 0 0 1.8-1.8v-2.2"/></>,
  offboarded: <><path d="M10 12.4V2.6M6.6 6l3.4-3.4L13.4 6"/><path d="M3.2 13.4v2.2a1.8 1.8 0 0 0 1.8 1.8h10a1.8 1.8 0 0 0 1.8-1.8v-2.2"/></>,
  investigations: <><circle cx="8.8" cy="8.8" r="5.6"/><path d="m13 13 4 4"/><path d="M8.8 6.2v2.8M8.8 11.3v.05"/></>,
  reports: <><path d="M3.4 16.6V9.4M8.4 16.6V4.2M13.4 16.6v-5M17.2 16.6H2.8"/></>,
  team: <><circle cx="7.6" cy="7" r="2.9"/><path d="M2.6 16.2a5 5 0 0 1 10 0"/><path d="M13.6 4.4a2.9 2.9 0 0 1 0 5.5M14.8 11.6a5 5 0 0 1 2.7 4.6"/></>,
  settings: <><circle cx="10" cy="10" r="2.6"/><path d="M16.1 12.3a1.4 1.4 0 0 0 .28 1.54l.05.05a1.7 1.7 0 1 1-2.4 2.4l-.05-.05a1.4 1.4 0 0 0-1.54-.28 1.4 1.4 0 0 0-.85 1.28v.14a1.7 1.7 0 1 1-3.4 0v-.07a1.4 1.4 0 0 0-.92-1.28 1.4 1.4 0 0 0-1.54.28l-.05.05a1.7 1.7 0 1 1-2.4-2.4l.05-.05a1.4 1.4 0 0 0 .28-1.54 1.4 1.4 0 0 0-1.28-.85h-.14a1.7 1.7 0 1 1 0-3.4h.07a1.4 1.4 0 0 0 1.28-.92 1.4 1.4 0 0 0-.28-1.54l-.05-.05a1.7 1.7 0 1 1 2.4-2.4l.05.05a1.4 1.4 0 0 0 1.54.28h.07a1.4 1.4 0 0 0 .85-1.28v-.14a1.7 1.7 0 1 1 3.4 0v.07a1.4 1.4 0 0 0 .85 1.28 1.4 1.4 0 0 0 1.54-.28l.05-.05a1.7 1.7 0 1 1 2.4 2.4l-.05.05a1.4 1.4 0 0 0-.28 1.54v.07a1.4 1.4 0 0 0 1.28.85h.14a1.7 1.7 0 1 1 0 3.4h-.07a1.4 1.4 0 0 0-1.28.85Z"/></>,
  import: <><path d="M10 2.6v9.8M6.6 9l3.4 3.4L13.4 9"/><path d="M3.2 13.4v2.2a1.8 1.8 0 0 0 1.8 1.8h10a1.8 1.8 0 0 0 1.8-1.8v-2.2"/></>,
  search: <><circle cx="8.8" cy="8.8" r="5.6"/><path d="m13 13 4 4"/></>,
  plus: <path d="M10 4.2v11.6M4.2 10h11.6"/>,
  // A pallet on the move: the load itself, distinct from the truck used for carriers.
  loads: <><rect x="2.4" y="6.2" width="8.4" height="7.6" rx="1.2"/><path d="M2.4 9.4h8.4"/><path d="M6.6 6.2v7.6"/><path d="M13.2 8.4h1.9a1.4 1.4 0 0 1 1.25.77l1.05 2.05a1.4 1.4 0 0 1 .15.63v1.15a.8.8 0 0 1-.8.8h-3.55Z"/><circle cx="15.4" cy="15.6" r="1.5"/></>,
  drivers: <><circle cx="10" cy="6.2" r="2.8"/><path d="M4.6 16.6a5.4 5.4 0 0 1 10.8 0"/><path d="M2.6 12.2h1.6M15.8 12.2h1.6"/></>,
  // A briefcase: the broker is the outside party, distinct from drivers and the load itself.
  brokers: <><rect x="3" y="7.2" width="14" height="9" rx="1.6"/><path d="M7.4 7.2V5.6a1.6 1.6 0 0 1 1.6-1.6h2a1.6 1.6 0 0 1 1.6 1.6v1.6"/><path d="M3 11.6h14"/></>,
  filter: <path d="M3 4.6h14M5.8 10h8.4M8.6 15.4h2.8"/>,
  chevron: <path d="m7.5 4.5 5 5.5-5 5.5"/>,
  columns: <><rect x="2.6" y="3.4" width="14.8" height="13.2" rx="1.6"/><path d="M7.6 3.4v13.2M12.4 3.4v13.2"/></>,
  download: <><path d="M10 2.8v9M6.8 8.4 10 11.8l3.2-3.4"/><path d="M3.6 14v1.6a1.6 1.6 0 0 0 1.6 1.6h9.6a1.6 1.6 0 0 0 1.6-1.6V14"/></>,
  logout: <><path d="M12.4 14v1.6a1.6 1.6 0 0 1-1.6 1.6H4.6A1.6 1.6 0 0 1 3 15.6V4.4a1.6 1.6 0 0 1 1.6-1.6h6.2a1.6 1.6 0 0 1 1.6 1.6V6"/><path d="M8 10h9.2M14.6 7.2 17.4 10l-2.8 2.8"/></>,
  note: <><path d="M4 3.4h9.2L16.4 6.6V16.6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4.4a1 1 0 0 1 1-1Z"/><path d="M6 8.6h7M6 11.6h7M6 14.4h4.4"/></>,
  history: <><path d="M3.2 10a6.8 6.8 0 1 0 2-4.8L3 7.4"/><path d="M2.8 3.6v3.9h3.9"/><path d="M10 6.6V10l2.4 1.6"/></>,
  warning: <><path d="M10 3.4 2.8 16.2h14.4L10 3.4Z"/><path d="M10 8v3.4M10 13.7v.05"/></>,
  check: <path d="m4.6 10.4 3.4 3.4 7.4-7.8"/>,
  close: <path d="M5 5l10 10M15 5 5 15"/>,
  edit: <><path d="M13.2 3.6a1.9 1.9 0 0 1 2.7 2.7L7 15.2l-3.6.9.9-3.6 8.9-8.9Z"/></>,
  back: <path d="m11.5 4.5-5 5.5 5 5.5"/>,
  money: <><rect x="2.2" y="5" width="15.6" height="10" rx="1.6"/><circle cx="10" cy="10" r="2.4"/><path d="M5.4 10h.05M14.55 10h.05"/></>,
};

export function Icon({
  name,
  className = "h-[18px] w-[18px]",
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg {...base} className={className}>
      {PATHS[name]}
    </svg>
  );
}
