import { requireOrg } from "@/lib/auth";
import { navCounts, visibleNav } from "@/lib/nav";
import { can } from "@/lib/permissions";
import { AppShell } from "@/components/app-shell";
import type { Role } from "@/lib/constants";

/**
 * Every authenticated page lives under this layout, so authentication is enforced
 * in exactly one place. Nothing outside `(app)` reads carrier data.
 *
 * The sidebar and the header's two carrier affordances are all decided here with
 * `can()`, so the shell renders what it is handed and no role is named in a component.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { user, org } = await requireOrg();
  return (
    <AppShell
      user={{ name: user.name, email: user.email, role: user.role as Role }}
      counts={navCounts(org)}
      groups={visibleNav(user)}
      canSearchCarriers={can(user, "carrier:view")}
      canAddCarrier={can(user, "carrier:create")}
    >
      {children}
    </AppShell>
  );
}
