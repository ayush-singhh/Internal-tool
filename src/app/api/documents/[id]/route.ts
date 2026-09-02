import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { documentsConfigured, getLoadDocument } from "@/lib/documents";
import { destination, getObject } from "@/lib/s3";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, org } = await requireOrg();
  if (!can(user, "load:view")) return new Response(null, { status: 404 });

  const id = Number((await params).id);
  if (!Number.isInteger(id)) return new Response(null, { status: 404 });

  const doc = getLoadDocument(org, id);
  if (!doc || !documentsConfigured()) return new Response(null, { status: 404 });

  let upstream: Response;
  try {
    upstream = await getObject(destination(process.env.DOCUMENTS_S3_URL!, "DOCUMENTS_S3_URL"), doc.storage_key);
  } catch {
    // The row exists but the object is missing/corrupted, credentials expired, or
    // DOCUMENTS_S3_URL is malformed — an upstream problem, not "doesn't exist or isn't
    // yours" (that stays a 404, above).
    return new Response(null, { status: 502 });
  }

  // HTTP header values must be ByteStrings (every character <= U+00FF), so a filename with
  // any CJK/Cyrillic/Arabic/Hebrew/Greek/Thai character or an emoji throws inside the
  // Response constructor if used raw. filename= carries an ASCII fallback; filename*=
  // (RFC 5987/6266) carries the real name, which every current browser prefers.
  const ascii = doc.filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return new Response(upstream.body, {
    headers: {
      "content-type": doc.content_type,
      // Forces a download rather than an inline render — same-origin uploaded content is
      // not something the app should ever let a browser execute or render as HTML/SVG.
      // The global `nosniff` header (security-headers.ts) covers the rest.
      "content-disposition":
        `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
    },
  });
}
