// Controlled vocabularies. Everything the UI offers as a dropdown lives here and is
// seeded into the `lookups` table, so no screen ever accepts uncontrolled free text.

export type LookupKind =
  | "status"
  | "plan"
  | "lead_source"
  | "onboarding_type"
  | "trailer_type"
  | "pricing_type"
  | "billing_frequency"
  | "subscription"
  | "agreement_status"
  | "invoice_mode"
  | "offboard_category"
  | "offboard_reason"
  | "final_status";

export type Tone =
  | "green"
  | "blue"
  | "amber"
  | "slate"
  | "orange"
  | "red"
  | "purple";

export type SeedLookup = {
  kind: LookupKind;
  value: string;
  label: string;
  tone?: Tone;
};

export const STATUS = {
  ACTIVE: "active",
  ABOUT_TO_BE_ACTIVE: "about_to_be_active",
  PENDING_INVESTIGATION: "pending_investigation",
  INACTIVE: "inactive",
  SUSPENDED: "suspended",
  BLACKLISTED: "blacklisted",
  BACK_OFF: "carrier_back_off",
} as const;

/** Statuses that open the offboarding workflow. */
export const OFFBOARDING_STATUSES: string[] = [
  STATUS.INACTIVE,
  STATUS.SUSPENDED,
  STATUS.BLACKLISTED,
  STATUS.BACK_OFF,
];

export const LOOKUPS: SeedLookup[] = [
  { kind: "status", value: STATUS.ACTIVE, label: "Active", tone: "green" },
  { kind: "status", value: STATUS.ABOUT_TO_BE_ACTIVE, label: "About to Be Active", tone: "blue" },
  { kind: "status", value: STATUS.PENDING_INVESTIGATION, label: "Pending Investigation", tone: "amber" },
  { kind: "status", value: STATUS.INACTIVE, label: "Inactive", tone: "slate" },
  { kind: "status", value: STATUS.SUSPENDED, label: "Suspended", tone: "orange" },
  { kind: "status", value: STATUS.BLACKLISTED, label: "Blacklisted", tone: "red" },
  { kind: "status", value: STATUS.BACK_OFF, label: "Carrier Back-off", tone: "purple" },

  { kind: "plan", value: "custom", label: "Custom" },
  { kind: "plan", value: "royal", label: "Royal" },
  { kind: "plan", value: "imperial", label: "Imperial" },
  { kind: "plan", value: "fleetcore", label: "FleetCore" },
  { kind: "plan", value: "other", label: "Other" },

  { kind: "pricing_type", value: "percentage_per_load", label: "Percentage Per Load" },
  { kind: "pricing_type", value: "fixed_monthly", label: "Fixed Monthly" },
  { kind: "pricing_type", value: "fixed_weekly", label: "Fixed Weekly" },
  { kind: "pricing_type", value: "custom", label: "Custom" },
  { kind: "pricing_type", value: "not_yet_pitched", label: "Not Yet Pitched" },
  { kind: "pricing_type", value: "not_accepting", label: "Not Accepting" },

  { kind: "billing_frequency", value: "per_load", label: "Per Load" },
  { kind: "billing_frequency", value: "weekly", label: "Weekly" },
  { kind: "billing_frequency", value: "monthly", label: "Monthly" },
  { kind: "billing_frequency", value: "other", label: "Other" },

  { kind: "subscription", value: "active", label: "Active", tone: "green" },
  { kind: "subscription", value: "paused", label: "Paused", tone: "amber" },
  { kind: "subscription", value: "cancelled", label: "Cancelled", tone: "red" },
  { kind: "subscription", value: "none", label: "None", tone: "slate" },

  { kind: "agreement_status", value: "signed", label: "Signed", tone: "green" },
  { kind: "agreement_status", value: "sent", label: "Sent — Awaiting Signature", tone: "blue" },
  { kind: "agreement_status", value: "pending", label: "Pending", tone: "amber" },
  { kind: "agreement_status", value: "not_required", label: "Not Required", tone: "slate" },
  { kind: "agreement_status", value: "expired", label: "Expired", tone: "red" },

  { kind: "invoice_mode", value: "factoring", label: "Factoring Company" },
  { kind: "invoice_mode", value: "direct_ach", label: "Direct ACH" },
  { kind: "invoice_mode", value: "wire", label: "Wire Transfer" },
  { kind: "invoice_mode", value: "check", label: "Check" },
  { kind: "invoice_mode", value: "quickpay", label: "Quick Pay" },
  { kind: "invoice_mode", value: "not_set", label: "Not Set", tone: "slate" },

  { kind: "onboarding_type", value: "direct", label: "Direct" },
  { kind: "onboarding_type", value: "referral", label: "Referral" },
  { kind: "onboarding_type", value: "agency", label: "Agency" },
  { kind: "onboarding_type", value: "reactivation", label: "Reactivation" },
  { kind: "onboarding_type", value: "other", label: "Other" },

  { kind: "lead_source", value: "cold_call", label: "Cold Call" },
  { kind: "lead_source", value: "referral", label: "Referral" },
  { kind: "lead_source", value: "website", label: "Website" },
  { kind: "lead_source", value: "social_media", label: "Social Media" },
  { kind: "lead_source", value: "email_campaign", label: "Email Campaign" },
  { kind: "lead_source", value: "walk_in", label: "Walk-In" },
  { kind: "lead_source", value: "partner", label: "Partner" },
  { kind: "lead_source", value: "other", label: "Other" },

  { kind: "trailer_type", value: "dry_van", label: "Dry Van" },
  { kind: "trailer_type", value: "reefer", label: "Reefer" },
  { kind: "trailer_type", value: "flatbed", label: "Flatbed" },
  { kind: "trailer_type", value: "step_deck", label: "Step Deck" },
  { kind: "trailer_type", value: "power_only", label: "Power Only" },
  { kind: "trailer_type", value: "box_truck", label: "Box Truck" },
  { kind: "trailer_type", value: "hotshot", label: "Hotshot" },
  { kind: "trailer_type", value: "tanker", label: "Tanker" },
  { kind: "trailer_type", value: "car_hauler", label: "Car Hauler" },
  { kind: "trailer_type", value: "mixed", label: "Mixed Fleet" },

  { kind: "offboard_category", value: "voluntary", label: "Voluntary" },
  { kind: "offboard_category", value: "involuntary", label: "Involuntary" },
  { kind: "offboard_category", value: "compliance", label: "Compliance" },
  { kind: "offboard_category", value: "non_payment", label: "Non-Payment" },
  { kind: "offboard_category", value: "inactivity", label: "Inactivity" },
  { kind: "offboard_category", value: "other", label: "Other" },

  { kind: "offboard_reason", value: "rates_too_low", label: "Rates Too Low" },
  { kind: "offboard_reason", value: "went_to_competitor", label: "Went To Competitor" },
  { kind: "offboard_reason", value: "poor_service", label: "Poor Service Experience" },
  { kind: "offboard_reason", value: "ceased_operations", label: "Ceased Operations" },
  { kind: "offboard_reason", value: "insurance_lapse", label: "Insurance Lapse" },
  { kind: "offboard_reason", value: "authority_revoked", label: "Authority Revoked" },
  { kind: "offboard_reason", value: "fraud_suspected", label: "Fraud Suspected" },
  { kind: "offboard_reason", value: "no_longer_responsive", label: "No Longer Responsive" },
  { kind: "offboard_reason", value: "payment_dispute", label: "Payment Dispute" },
  { kind: "offboard_reason", value: "other", label: "Other" },

  { kind: "final_status", value: "closed_good_standing", label: "Closed — Good Standing" },
  { kind: "final_status", value: "closed_balance_due", label: "Closed — Balance Due" },
  { kind: "final_status", value: "terminated", label: "Terminated" },
  { kind: "final_status", value: "do_not_reengage", label: "Do Not Re-engage" },
];

export const ROLES = {
  /** Platform staff, not a customer's employee: read-only access to any organisation,
   *  recorded in support_access_log. Never assignable from the Team page — an
   *  organisation's administrator must not be able to mint one. Created out of band by
   *  `scripts/support-user.ts`. */
  SUPPORT: "support",
  OWNER: "owner",
  ADMIN: "admin",
  DISPATCHER: "dispatcher",
  ACCOUNT_MANAGER: "account_manager",
  VIEWER: "viewer",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/**
 * An organisation's billing standing — "who is paid up," tracked by hand.
 *
 * Nothing in this application charges anybody: `organizations.status` is set only by
 * `scripts/set-billing-status.ts`, run by whoever sends the invoice, not by any code path
 * a customer or a support account can reach. `/support` stays read-only by construction;
 * this does not get a write path there. See HANDOFF.md's billing decision.
 */
export const ORG_STATUS = {
  TRIAL: "trial",
  ACTIVE: "active",
  PAST_DUE: "past_due",
  SUSPENDED: "suspended",
} as const;

export type OrgStatus = (typeof ORG_STATUS)[keyof typeof ORG_STATUS];

export const ROLE_LABELS: Record<Role, string> = {
  support: "Platform Support",
  owner: "Owner",
  admin: "Admin",
  dispatcher: "Dispatcher",
  account_manager: "Account Manager",
  viewer: "Management / Viewer",
};

/** Configurable thresholds for the Needs Attention system. */
export const DEFAULT_SETTINGS: Record<string, string> = {
  about_to_be_active_days: "14",
  missing_first_load_days: "21",
  investigation_stale_days: "7",
  insurance_expiry_days: "30",
  company_name: "Carrier Management Hub",
};
