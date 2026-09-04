import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { currentMonth, isMonth, monthEntries, monthGrid, todayIso } from "@/lib/calendar";
import { carrierOptions } from "@/lib/form-options";
import { PageHeader } from "@/components/ui";
import { CalendarBoard } from "@/components/calendar-board";

export const metadata: Metadata = { title: "Planning Calendar" };

export default async function CalendarPage({ searchParams }: PageProps<"/calendar">) {
  const { user, org } = await requireOrg();
  if (!can(user, "calendar:view")) redirect("/");

  // A malformed `?month=` falls back to this month rather than erroring: the parameter is
  // a view preference, and a bad one is not worth a page nobody can read.
  const requested = (await searchParams).month;
  const month = isMonth(typeof requested === "string" ? requested : undefined)
    ? (requested as string)
    : currentMonth();

  const grid = monthGrid(month);

  return (
    <>
      <PageHeader
        title="Planning Calendar"
        subtitle="Pickups, deliveries, task due dates and insurance expiries, read live from the records they belong to — plus whatever you put on it yourself."
      />
      <CalendarBoard
        month={month}
        label={grid.label}
        days={grid.days}
        leadingBlanks={grid.leadingBlanks}
        previous={grid.previous}
        next={grid.next}
        today={todayIso()}
        entries={monthEntries(org, user, month)}
        carriers={can(user, "carrier:view") ? carrierOptions(org) : []}
        canManage={can(user, "calendar:manage")}
      />
    </>
  );
}
