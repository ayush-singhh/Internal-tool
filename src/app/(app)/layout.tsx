import { requireOrg } from "@/lib/auth";
import { navCounts } from "@/lib/nav";
import { can } from "@/lib/permissions";
import { AppShell } from "@/components/app-shell";
import type { Role } from "@/lib/constants";

/**
 * Every authenticated page lives under this layout, so authentication is enforced
 * in exactly one place. Nothing outside `(app)` reads carrier data.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { user, org } = await requireOrg();
  return (
    <AppShell
      user={{ name: user.name, email: user.email, role: user.role as Role }}
      counts={navCounts(org)}
      canAdmin={can(user, "settings:manage")}
    >
      {children}
    </AppShell>
  );
}
