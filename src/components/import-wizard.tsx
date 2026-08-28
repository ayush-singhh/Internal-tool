"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { parseCsv, sniffDelimiter } from "@/lib/csv";
import { TARGETS, suggestMapping } from "@/lib/import-targets";
import { previewImportAction, commitImportAction } from "@/lib/import-actions";
import type { PreviewRow } from "@/lib/import";
import type { DuplicateMode, ImportSummary } from "@/lib/import";
import { Card, CardHeader, Badge } from "./ui";
import { Icon } from "./icons";

type Step = 1 | 2 | 3 | 4;
const MAX_ROWS = 20000;

const STEPS: [Step, string][] = [
  [1, "Upload file"],
  [2, "Map columns"],
  [3, "Review"],
  [4, "Done"],
];

export function ImportWizard() {
  const [step, setStep] = useState<Step>(1);
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [dataRows, setDataRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [counts, setCounts] = useState({ total: 0, errors: 0, flagged: 0, duplicates: 0 });
  const [mode, setMode] = useState<DuplicateMode>("skip");
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const mappedCount = Object.keys(mapping).length;
  const hasLegalName = Object.values(mapping).includes("legal_name");

  async function onFile(file: File) {
    setError("");
    const text = await file.text();
    const rows = parseCsv(text, sniffDelimiter(text)).filter((r) =>
      r.some((cell) => cell.trim() !== ""),
    );
    if (rows.length < 2) {
      setError("That file has no data rows below the header.");
      return;
    }
    if (rows.length - 1 > MAX_ROWS) {
      setError(`That file has ${rows.length - 1} rows. Split it into files of ${MAX_ROWS} or fewer.`);
      return;
    }
    const [head, ...body] = rows as [string[], ...string[][]];
    setFileName(file.name);
    setHeaders(head);
    setDataRows(body);
    setMapping(suggestMapping(head));
    setStep(2);
  }

  /** Turn the raw grid into records keyed by target field, using the current mapping. */
  const mappedRows = useMemo(
    () =>
      dataRows.map((row) => {
        const record: Record<string, string> = {};
        for (const [index, key] of Object.entries(mapping)) {
          record[key] = row[Number(index)] ?? "";
        }
        return record;
      }),
    [dataRows, mapping],
  );

  function runPreview() {
    setError("");
    startTransition(async () => {
      const result = await previewImportAction(mappedRows);
      if (!result.ok) { setError(result.error); return; }
      setPreview(result.preview);
      setCounts(result.counts);
      setStep(3);
    });
  }

  function runCommit() {
    setError("");
    startTransition(async () => {
      const importable = mappedRows.filter((_, i) => !preview[i]?.skip);
      const result = await commitImportAction(importable, mode);
      if (!result.ok) { setError(result.error); return; }
      setSummary(result.summary);
      setStep(4);
    });
  }

  function reset() {
    setStep(1); setFileName(""); setHeaders([]); setDataRows([]); setMapping({});
    setPreview([]); setSummary(null); setError("");
  }

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8rem]">
        {STEPS.map(([n, label], i) => (
          <li key={n} className="flex items-center gap-2">
            <span
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${
                step === n
                  ? "bg-brand-600 text-white"
                  : step > n
                    ? "bg-brand-50 text-brand-700"
                    : "bg-ink-100 text-ink-500"
              }`}
            >
              <span className="tnum">{step > n ? "✓" : n}</span>
              {label}
            </span>
            {i < STEPS.length - 1 && <span className="text-ink-300">→</span>}
          </li>
        ))}
      </ol>

      {error && (
        <p role="alert" className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}

      {step === 1 && (
        <Card>
          <CardHeader
            title="Upload your carrier spreadsheet"
            subtitle="Export the sheet as CSV, then choose it here. Nothing is written until you confirm the preview."
          />
          <label className="flex cursor-pointer flex-col items-center justify-center rounded-card border-2 border-dashed border-line-strong bg-ink-50/40 px-6 py-12 text-center transition hover:border-brand-400 hover:bg-brand-50/30">
            <span className="text-brand-600"><Icon name="import" className="h-7 w-7" /></span>
            <span className="mt-3 text-sm font-semibold text-ink-800">Choose a CSV file</span>
            <span className="mt-1 text-xs text-ink-500">
              Comma, semicolon, tab or pipe separated · up to {MAX_ROWS.toLocaleString()} rows
            </span>
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              className="sr-only"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }}
            />
          </label>
          <ul className="mt-4 space-y-1 text-xs text-ink-500">
            <li>· Existing carriers are never overwritten unless you choose to update them.</li>
            <li>· Values that don&rsquo;t match a known option are kept exactly as written and flagged for review.</li>
            <li>· Duplicate MC and USDOT numbers are detected before anything is saved.</li>
          </ul>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <CardHeader
            title="Map your columns"
            subtitle={`${fileName} — ${dataRows.length.toLocaleString()} rows. ${mappedCount} of ${headers.length} columns mapped.`}
            action={
              <button type="button" onClick={reset} className="text-xs font-medium text-ink-500 hover:text-ink-900">
                Choose a different file
              </button>
            }
          />

          {!hasLegalName && (
            <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              Map one column to <strong>Lead Legal Name</strong> — it is the only required field.
            </p>
          )}

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-line bg-ink-50/70">
                  <th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-ink-600">Spreadsheet column</th>
                  <th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-ink-600">First value</th>
                  <th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-ink-600">Imports into</th>
                </tr>
              </thead>
              <tbody>
                {headers.map((header, i) => {
                  const taken = new Set(
                    Object.entries(mapping).filter(([k]) => Number(k) !== i).map(([, v]) => v),
                  );
                  return (
                    <tr key={i} className="border-b border-line/70 last:border-0">
                      <td className="px-3 py-2 font-medium text-ink-800">{header || <em className="text-ink-400">Column {i + 1}</em>}</td>
                      <td className="max-w-[16rem] truncate px-3 py-2 text-ink-500">{dataRows[0]?.[i] || "—"}</td>
                      <td className="px-3 py-2">
                        <select
                          aria-label={`Map column ${header || i + 1}`}
                          className="field field-sm max-w-[15rem]"
                          value={mapping[i] ?? ""}
                          onChange={(e) => {
                            const value = e.target.value;
                            setMapping((prev) => {
                              const next = { ...prev };
                              if (value === "") delete next[i];
                              else next[i] = value;
                              return next;
                            });
                          }}
                        >
                          <option value="">Don&rsquo;t import</option>
                          {TARGETS.map((t) => (
                            <option key={t.key} value={t.key} disabled={taken.has(t.key)}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={runPreview}
              disabled={!hasLegalName || pending}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50"
            >
              {pending ? "Checking…" : "Preview import"}
            </button>
          </div>
        </Card>
      )}

      {step === 3 && (
        <>
          <Card>
            <CardHeader title="Review before importing" subtitle="Nothing has been saved yet." />
            <div className="grid gap-3 sm:grid-cols-4">
              {[
                { label: "Rows in file", value: counts.total, tone: undefined },
                { label: "Will be skipped (errors)", value: counts.errors, tone: counts.errors ? ("red" as const) : undefined },
                { label: "Flagged for review", value: counts.flagged, tone: counts.flagged ? ("amber" as const) : undefined },
                { label: "Duplicate MC / USDOT", value: counts.duplicates, tone: counts.duplicates ? ("purple" as const) : undefined },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-line bg-ink-50/40 p-3">
                  <p className="text-xs text-ink-500">{s.label}</p>
                  <p className="tnum mt-1 text-xl font-semibold text-ink-900">{s.value.toLocaleString()}</p>
                </div>
              ))}
            </div>

            {counts.duplicates > 0 && (
              <fieldset className="mt-4 rounded-lg border border-line p-3.5">
                <legend className="px-1 text-xs font-semibold text-ink-700">
                  How should duplicates be handled?
                </legend>
                <div className="space-y-2">
                  {([
                    ["skip", "Skip them", "Leave the existing carrier exactly as it is. Nothing is overwritten."],
                    ["update", "Update the existing carrier", "Fill in values from the spreadsheet. Empty cells never erase what is already on file."],
                    ["create", "Import as new carriers anyway", "Creates a second record. Use only if these are genuinely different carriers."],
                  ] as const).map(([value, label, help]) => (
                    <label key={value} className="flex cursor-pointer items-start gap-2.5">
                      <input
                        type="radio"
                        name="dupmode"
                        value={value}
                        checked={mode === value}
                        onChange={() => setMode(value)}
                        className="mt-0.5 h-3.5 w-3.5 accent-[var(--color-brand-600)]"
                      />
                      <span>
                        <span className="block text-[0.83rem] font-medium text-ink-800">{label}</span>
                        <span className="block text-xs text-ink-500">{help}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </Card>

          <Card padded={false}>
            <div className="max-h-[26rem] overflow-auto">
              <table className="w-full border-collapse text-sm">
                <thead className="sticky top-0">
                  <tr className="border-b border-line bg-ink-50">
                    <th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-ink-600">Row</th>
                    <th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-ink-600">Legal name</th>
                    <th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-ink-600">MC</th>
                    <th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-ink-600">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((row) => (
                    <tr key={row.index} className={`border-b border-line/70 ${row.skip ? "bg-red-50/40" : ""}`}>
                      <td className="tnum px-3 py-2 text-ink-400">{row.index + 2}</td>
                      <td className="px-3 py-2 font-medium text-ink-800">
                        {row.values.legal_name || <em className="text-ink-400">missing</em>}
                      </td>
                      <td className="tnum px-3 py-2 text-ink-600">{row.values.mc_number || "—"}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {row.skip && <Badge tone="red">Skipped</Badge>}
                          {row.duplicateOf && (
                            <span className="inline-flex items-center gap-1">
                              <Badge tone="purple">{row.duplicateOf.on} duplicate</Badge>
                              <Link href={`/carriers/${row.duplicateOf.id}`} target="_blank" className="text-xs text-brand-700 hover:underline">
                                {row.duplicateOf.legal_name}
                              </Link>
                            </span>
                          )}
                          {row.duplicateInFile && <Badge tone="orange">Repeated in file</Badge>}
                          {row.issues.filter((i) => i.severity === "flag").length > 0 && (
                            <Badge tone="amber">
                              {row.issues.filter((i) => i.severity === "flag").length} flagged
                            </Badge>
                          )}
                          {!row.skip && !row.duplicateOf && !row.duplicateInFile && row.issues.length === 0 && (
                            <Badge tone="green">Ready</Badge>
                          )}
                        </div>
                        {row.issues.length > 0 && (
                          <ul className="mt-1 space-y-0.5">
                            {row.issues.map((issue, i) => (
                              <li key={i} className={`text-xs ${issue.severity === "error" ? "text-red-600" : "text-amber-700"}`}>
                                {issue.message}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
              <button type="button" onClick={() => setStep(2)} className="text-[0.83rem] font-medium text-ink-600 hover:text-ink-900">
                ← Back to mapping
              </button>
              <button
                type="button"
                onClick={runCommit}
                disabled={pending || counts.total === counts.errors}
                className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50"
              >
                {pending
                  ? "Importing…"
                  : `Import ${(counts.total - counts.errors).toLocaleString()} carrier${counts.total - counts.errors === 1 ? "" : "s"}`}
              </button>
            </div>
          </Card>
        </>
      )}

      {step === 4 && summary && (
        <Card>
          <CardHeader title="Import complete" subtitle="Every change was written in a single transaction." />
          <div className="grid gap-3 sm:grid-cols-5">
            {[
              ["Created", summary.created],
              ["Updated", summary.updated],
              ["Skipped", summary.skipped],
              ["Failed", summary.failed],
              ["Flagged for review", summary.flagged],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-lg border border-line bg-ink-50/40 p-3">
                <p className="text-xs text-ink-500">{label}</p>
                <p className="tnum mt-1 text-xl font-semibold text-ink-900">{Number(value).toLocaleString()}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/carriers" className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700">
              View carriers
            </Link>
            {summary.flagged > 0 && (
              <Link href="/" className="rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50">
                Review flagged records
              </Link>
            )}
            <button type="button" onClick={reset} className="rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50">
              Import another file
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}
