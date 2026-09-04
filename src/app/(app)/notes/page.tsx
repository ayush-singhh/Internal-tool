import type { Metadata } from "next";
import { requireOrg } from "@/lib/auth";
import { workingNotes, WORKING_NOTES_MAX } from "@/lib/working-notes";
import { Card, PageHeader } from "@/components/ui";
import { WorkingNotesPad } from "@/components/working-notes-pad";

export const metadata: Metadata = { title: "Working Notes" };

export default async function WorkingNotesPage() {
  // No `can()` call, and that is the correct amount. The session names the only person
  // whose notes this page can reach — there is no other user's record in play for a
  // permission to protect.
  const { user, org } = await requireOrg();
  const notes = workingNotes(org, user.id);

  return (
    <>
      <PageHeader
        title="Working Notes"
        subtitle="Your own scratchpad. Nobody else in the organisation can see this page."
      />
      <Card>
        <WorkingNotesPad body={notes.body} savedAt={notes.savedAt} maxLength={WORKING_NOTES_MAX} />
      </Card>
    </>
  );
}
