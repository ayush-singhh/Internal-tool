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

  const upstream = await getObject(destination(process.env.DOCUMENTS_S3_URL!), doc.storage_key);
  return new Response(upstream.body, {
    headers: {
      "content-type": doc.content_type,
      // Forces a download rather than an inline render — same-origin uploaded content is
      // not something the app should ever let a browser execute or render as HTML/SVG.
      // The global `nosniff` header (security-headers.ts) covers the rest.
      "content-disposition": `attachment; filename="${doc.filename.replace(/"/g, "")}"`,
    },
  });
}
