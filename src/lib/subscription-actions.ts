"use server";
import { redirect } from "next/navigation";
import { requireOrg } from "./auth.ts";
import { can } from "./permissions.ts";
import { openPortal, startCheckout } from "./subscription.ts";

/**
 * The thin auth wrapper over `subscription.ts`, in the shape of `note-actions.ts`.
 *
 * Both actions re-check the permission here rather than relying on the page having
 * hidden the button — AI Rules §4, and BUGS.md records what happened the two times a
 * check was left to the UI. `settings:manage` resolves to owner and admin, which is who
 * holds the company card.
 */
export async function startCheckoutAction(formData: FormData): Promise<void> {
  const { user, org } = await requireOrg();
  if (!can(user, "settings:manage")) throw new Error("Not authorized to manage the subscription.");

  const plan = formData.get("plan") === "yearly" ? "yearly" : "monthly";
  // Outside any try/catch: `redirect` works by throwing, so catching here would swallow it.
  redirect(await startCheckout(org.id, plan, user.email));
}

export async function openPortalAction(): Promise<void> {
  const { user, org } = await requireOrg();
  if (!can(user, "settings:manage")) throw new Error("Not authorized to manage the subscription.");
  redirect(await openPortal(org.id));
}
