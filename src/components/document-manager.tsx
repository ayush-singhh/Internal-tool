"use client";

import { useActionState } from "react";
import { uploadDocumentAction, type DocumentState } from "@/lib/document-actions";
import type { DocumentRow } from "@/lib/documents";
import { DOCUMENT_KIND_LABELS, DOCUMENT_KIND_TONE } from "@/lib/constants";
import { formatBytes, formatDateTime } from "@/lib/format";
import { Badge, Banner, EmptyState } from "./ui";

export function DocumentManager({
  loadId,
  documents,
  canUpload,
}: {
  loadId: number;
  documents: DocumentRow[];
  canUpload: boolean;
}) {
  const [state, action, pending] = useActionState<DocumentState, FormData>(uploadDocumentAction, {});

  return (
    <div className="space-y-4">
      {documents.length === 0 ? (
        <EmptyState
          title="No documents yet"
          description="Rate confirmations, bills of lading and proofs of delivery attach here."
        />
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-ink-50/70">
                {["Kind", "File", "Uploaded by", "Date", ""].map((h) => (
                  <th key={h} scope="col" className="px-4 py-2.5 text-left text-xs font-semibold text-ink-600">
                    {h === "" ? <span className="sr-only">Download</span> : h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {documents.map((d) => (
                <tr key={d.id} className="border-b border-line/70 last:border-0">
                  <td className="px-4 py-2.5">
                    <Badge tone={DOCUMENT_KIND_TONE[d.kind]}>{DOCUMENT_KIND_LABELS[d.kind]}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-ink-900">
                    {d.filename}
                    <span className="ml-1.5 text-xs text-ink-400">{formatBytes(d.size_bytes)}</span>
                  </td>
                  <td className="px-4 py-2.5 text-ink-600">{d.uploaded_by_name}</td>
                  <td className="px-4 py-2.5 text-ink-600">{formatDateTime(d.created_at)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <a
                      href={`/api/documents/${d.id}`}
                      className="text-sm font-medium text-brand-700 hover:underline"
                    >
                      Download
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canUpload && (
        <div className="space-y-3 border-t border-line pt-4">
          <Banner state={state} />
          <form action={action} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="load_id" value={loadId} />
            <div>
              <label className="label" htmlFor="kind">Kind</label>
              <select id="kind" name="kind" defaultValue="rate_confirmation" className="field" required>
                {Object.entries(DOCUMENT_KIND_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
            <div className="min-w-[12rem] flex-1">
              <label className="label" htmlFor="file">File</label>
              <input
                id="file" name="file" type="file"
                accept="application/pdf,image/jpeg,image/png"
                required className="field"
              />
            </div>
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
            >
              {pending ? "Uploading…" : "Attach"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
