/** Monoline trailer mark — geometric, not illustrative. */
export function Logo({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <rect
        x="2.5" y="7.5" width="18" height="12" rx="2"
        stroke="currentColor" strokeWidth="2"
      />
      <path
        d="M20.5 11h4.2a2 2 0 0 1 1.7.95l2.3 3.8a2 2 0 0 1 .3 1.05V17.5a2 2 0 0 1-2 2h-6.5"
        stroke="currentColor" strokeWidth="2" strokeLinejoin="round"
      />
      <circle cx="9.5" cy="23" r="2.6" stroke="currentColor" strokeWidth="2" />
      <circle cx="23" cy="23" r="2.6" stroke="currentColor" strokeWidth="2" />
      <path d="M12.2 23h8.1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark({ subdued = false }: { subdued?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className={subdued ? "text-brand-300" : "text-brand-600"}>
        <Logo className="h-6 w-6" />
      </span>
      <span className="leading-tight">
        <span
          className={`block text-[0.9rem] font-semibold tracking-tight ${
            subdued ? "text-white" : "text-ink-900"
          }`}
        >
          Carrier Hub
        </span>
        <span
          className={`block text-[0.65rem] font-medium uppercase tracking-[0.14em] ${
            subdued ? "text-ink-400" : "text-ink-500"
          }`}
        >
          Management
        </span>
      </span>
    </span>
  );
}
