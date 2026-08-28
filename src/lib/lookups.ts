import "server-only";
import { cache } from "react";
import { all } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import type { LookupKind, Tone } from "./constants.ts";

export type Lookup = {
  id: number;
  kind: LookupKind;
  value: string;
  label: string;
  tone: Tone | null;
  sort: number;
  active: number;
};

/**
 * The whole lookup table is a few dozen rows, so it is loaded once per request and
 * indexed in memory. Every screen needs several kinds; this avoids a query per dropdown.
 */
export const loadLookups = cache((org: Org): {
  byId: Map<number, Lookup>;
  byKind: Map<LookupKind, Lookup[]>;
  byValue: Map<string, Lookup>;
} => {
  const rows = all<Lookup>(
    `SELECT id, kind, value, label, tone, sort, active FROM lookups
      WHERE organization_id = ? ORDER BY sort, label`,
    [org.id],
  );
  const byId = new Map<number, Lookup>();
  const byKind = new Map<LookupKind, Lookup[]>();
  const byValue = new Map<string, Lookup>();
  for (const r of rows) {
    byId.set(r.id, r);
    byValue.set(`${r.kind}:${r.value}`, r);
    const list = byKind.get(r.kind);
    if (list) list.push(r);
    else byKind.set(r.kind, [r]);
  }
  return { byId, byKind, byValue };
});

/** Options for a `<select>`; inactive values are hidden unless one is already selected. */
export function options(org: Org, kind: LookupKind, keepId?: number | null): Lookup[] {
  const list = loadLookups(org).byKind.get(kind) ?? [];
  return list.filter((l) => l.active === 1 || l.id === keepId);
}

export function lookup(org: Org, id: number | null | undefined): Lookup | undefined {
  return id == null ? undefined : loadLookups(org).byId.get(id);
}

export function labelOf(org: Org, id: number | null | undefined): string {
  return lookup(org, id)?.label ?? "";
}

export function toneOf(org: Org, id: number | null | undefined): Tone | null {
  return lookup(org, id)?.tone ?? null;
}

/** Resolve a controlled value slug (e.g. STATUS.ACTIVE) to its row id. */
export function idOf(org: Org, kind: LookupKind, value: string): number | undefined {
  return loadLookups(org).byValue.get(`${kind}:${value}`)?.id;
}

export function idsOf(org: Org, kind: LookupKind, values: string[]): number[] {
  return values.map((v) => idOf(org, kind, v)).filter((v): v is number => v !== undefined);
}
