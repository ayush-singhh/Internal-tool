import "server-only";
import { randomUUID } from "node:crypto";
import { all, get, run } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import { destination, putObject } from "./s3.ts";
import { DOCUMENT_ALLOWED_TYPES, DOCUMENT_KIND, DOCUMENT_MAX_BYTES, type DocumentKind } from "./constants.ts";

export type DocumentRow = {
  id: number;
  organization_id: number;
  load_id: number;
  kind: DocumentKind;
  filename: string;
  storage_key: string;
  content_type: string;
  size_bytes: number;
  uploaded_by: number;
  uploaded_by_name: string;
  created_at: string;
};

export type Result = { ok: true; id: number } | { ok: false; error: string };

export function documentsConfigured(): boolean {
  return Boolean(process.env.DOCUMENTS_S3_URL);
}

const SELECT = `
  SELECT d.*, u.name AS uploaded_by_name
    FROM load_documents d
    JOIN users u ON u.organization_id = d.organization_id AND u.id = d.uploaded_by
`;

export function listLoadDocuments(org: Org, loadId: number): DocumentRow[] {
  return all<DocumentRow>(
    // `, d.id DESC` tiebreaks two documents written in the same millisecond, so "newest
    // first" is deterministic rather than whatever order SQLite happens to return.
    `${SELECT} WHERE d.organization_id = ? AND d.load_id = ? ORDER BY d.created_at DESC, d.id DESC`,
    [org.id, loadId],
  );
}

/** Tenant-scoped single-row lookup by id — what the download route resolves against.
 *  Undefined for a missing id or one that belongs to another tenant; the route turns
 *  either into the same 404, so it never distinguishes "not found" from "not yours". */
export function getLoadDocument(org: Org, id: number): DocumentRow | undefined {
  return get<DocumentRow>(`${SELECT} WHERE d.organization_id = ? AND d.id = ?`, [org.id, id]);
}

export async function uploadLoadDocument(
  org: Org,
  loadId: number,
  kind: string,
  file: { name: string; type: string; size: number; buffer: Buffer },
  userId: number,
): Promise<Result> {
  if (!Object.values(DOCUMENT_KIND).includes(kind as DocumentKind)) {
    return { ok: false, error: "Unknown document kind." };
  }
  if (!get("SELECT 1 FROM loads WHERE organization_id = ? AND id = ?", [org.id, loadId])) {
    return { ok: false, error: "Unknown load." };
  }
  if (!(DOCUMENT_ALLOWED_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, error: "Only PDF, JPEG or PNG files are accepted." };
  }
  // The buffer, not file.size: file.size is the caller's claim about what it is about to
  // upload, and what actually gets stored/checked has to be the thing that was actually
  // uploaded — otherwise a caller that passes a mismatched pair validates one size and
  // persists another.
  if (file.buffer.length > DOCUMENT_MAX_BYTES) {
    return { ok: false, error: `File is larger than ${DOCUMENT_MAX_BYTES / 1024 / 1024}MB.` };
  }
  if (!documentsConfigured()) {
    return { ok: false, error: "Document storage is not configured." };
  }

  // No filename in the key: the original name is never trusted for a path, and a
  // random key needs no collision check.
  const key = `${org.id}/loads/${loadId}/${randomUUID()}`;
  await putObject(destination(process.env.DOCUMENTS_S3_URL!, "DOCUMENTS_S3_URL"), key, file.buffer);

  // Array.from, not .slice: .slice(0, 200) counts UTF-16 code units and can split a
  // surrogate pair at the boundary, storing an unpaired surrogate — which is > U+00FF and
  // hits the same header ByteString wall as I2 the moment the document is downloaded.
  // Array.from iterates by codepoint, so the cut never lands inside one.
  const filename = Array.from(file.name).slice(0, 200).join("");
  run(
    `INSERT INTO load_documents
       (organization_id, load_id, kind, filename, storage_key, content_type, size_bytes, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [org.id, loadId, kind, filename, key, file.type, file.buffer.length, userId, new Date().toISOString()],
  );
  return { ok: true, id: get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id };
}
