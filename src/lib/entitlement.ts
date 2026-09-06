import { ORG_STATUS } from "./constants.ts";

/**
 * What an organisation is entitled to, from its billing columns and the clock.
 *
 * Pure on purpose: no database, no request context, no network. It is the single answer
 * the gate, the banner and the subscription page all read, which is what stops the three
 * of them from disagreeing about whether somebody has paid — and it means the whole
 * truth table is a unit test rather than a browser session.
 *
 * Nothing consults this yet. Enforcement is Phase B; see the design doc, section 9.
 */
export type OrgBilling = {
  status: string;
  billing_mode: string;
  plan: string | null;
  stripe_subscription_id: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
};

export type Access = "full" | "read_only" | "none";

export type Entitlement = {
  access: Access;
  /** Banner text, or null when there is nothing to say. */
  notice: string | null;
  /** What the `access` runs until, for display. Null when nothing is counting down. */
  until: string | null;
};

/** How long a lapsed organisation keeps read access before the account goes dormant. */
export const DORMANT_AFTER_DAYS = 30;
const DAY = 86_400_000;

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function entitlement(org: OrgBilling, now = new Date()): Entitlement {
  // Grandfathered and internal organisations. Never billed, never nagged, never locked.
  if (org.billing_mode === "comped") return { access: "full", notice: null, until: null };

  // Never subscribed. Checked before status because a brand-new organisation's default
  // status is 'active', which would otherwise read as a paid-up account.
  if (!org.stripe_subscription_id) {
    return { access: "read_only", notice: "Start your free trial to begin.", until: null };
  }

  if (org.status === ORG_STATUS.ACTIVE) {
    // No date check, deliberately. Requiring current_period_end to be in the future would
    // lock out a customer whose renewal webhook we missed — failing closed against
    // somebody who has just paid us. The mirrored status is trusted here; the date is
    // display only.
    return { access: "full", notice: null, until: org.current_period_end };
  }

  if (org.status === ORG_STATUS.PAST_DUE) {
    // Stripe's Smart Retries chase a failed card for up to three weeks. Cutting service
    // on the first decline loses customers over an expired card. When Stripe gives up it
    // moves the subscription to canceled or unpaid, we mirror that as suspended, and
    // access degrades below. The grace period is therefore configured once, in Stripe's
    // dunning settings, rather than duplicated as a constant here.
    return {
      access: "full",
      notice: "Your last payment failed. Update your card to avoid losing access.",
      until: org.current_period_end,
    };
  }

  if (org.status === ORG_STATUS.TRIAL) {
    const ends = parseDate(org.trial_ends_at);
    if (ends && ends > now) {
      const days = Math.max(1, Math.ceil((ends.getTime() - now.getTime()) / DAY));
      return {
        access: "full",
        notice: `Your trial ends in ${days} day${days === 1 ? "" : "s"}.`,
        until: org.trial_ends_at,
      };
    }
    // The one place the mirrored status is not trusted: this is the only transition where
    // trusting it fails *open*, into free service, if the webhook never arrives.
    return lapsed(ends, "Your trial has ended.", now);
  }

  // Suspended, and any status Stripe invents that we have not mapped: fail closed.
  return lapsed(parseDate(org.current_period_end), "Your subscription has ended.", now);
}

/** Read-only for thirty days from `since`, then dormant. An unknown `since` counts from
 *  now, so a missing date buys the full thirty days rather than costing them. */
function lapsed(since: Date | null, ended: string, now: Date): Entitlement {
  const dormantAt = new Date((since ?? now).getTime() + DORMANT_AFTER_DAYS * DAY);
  if (now >= dormantAt) {
    return {
      access: "none",
      notice: "This account is inactive. Subscribe to restore access to your data.",
      until: null,
    };
  }
  return {
    access: "read_only",
    notice: `${ended} Subscribe to start writing again.`,
    until: dormantAt.toISOString(),
  };
}
