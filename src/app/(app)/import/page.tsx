import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { PageHeader } from "@/components/ui";
import { ImportWizard } from "@/components/import-wizard";

export const metadata: Metadata = { title: "Import Data" };

export default async function ImportPage() {
  const user = await requireUser();
  if (!can(user, "import:run")) redirect("/carriers");

  return (
    <>
      <PageHeader
        title="Import carrier data"
        subtitle="Bring your existing spreadsheet in. Values are preserved exactly as written — anything we cannot match is flagged for review rather than changed."
      />
      <ImportWizard />
    </>
  );
}
