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

/**
 * A task is open or done. There is no "cancelled": marking something done clears it from
 * every view, and a third state only creates the question of which two mean "not my
 * problem any more".
 */
export const TASK_STATUS = { OPEN: "open", DONE: "done" } as const;
export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

/** Ordered most urgent first — the index is what sorts the list, so the order is the rule. */
export const TASK_PRIORITY = { HIGH: "high", NORMAL: "normal", LOW: "low" } as const;
export type TaskPriority = (typeof TASK_PRIORITY)[keyof typeof TASK_PRIORITY];
export const TASK_PRIORITY_ORDER: TaskPriority[] = [
  TASK_PRIORITY.HIGH,
  TASK_PRIORITY.NORMAL,
  TASK_PRIORITY.LOW,
];
export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  high: "High",
  normal: "Normal",
  low: "Low",
};
export const TASK_PRIORITY_TONE: Record<TaskPriority, Tone> = {
  high: "red",
  normal: "blue",
  low: "slate",
};

/**
 * A lead's position in the sales pipeline — the stage before a carrier record exists.
 *
 * Kept out of `lookups` for the same reason LOAD_STATUS is: these drive behaviour rather
 * than label it. `won` in particular is not a value a person may pick; it is what
 * `convertLead` writes, and the only thing that writes it.
 */
export const LEAD_STATUS = {
  NEW: "new",
  CONTACTED: "contacted",
  QUALIFIED: "qualified",
  WON: "won",
  LOST: "lost",
} as const;

export type LeadStatus = (typeof LEAD_STATUS)[keyof typeof LEAD_STATUS];

/** The stages a person may set by hand. `won` is absent on purpose — a lead becomes won
 *  by being converted into a carrier, never by someone choosing it from a dropdown. */
export const LEAD_STATUS_SETTABLE: LeadStatus[] = [
  LEAD_STATUS.NEW,
  LEAD_STATUS.CONTACTED,
  LEAD_STATUS.QUALIFIED,
  LEAD_STATUS.LOST,
];

/** Still worth working. Everything else has left the pipeline in one direction or the other. */
export const LEAD_STATUS_OPEN: LeadStatus[] = [
  LEAD_STATUS.NEW,
  LEAD_STATUS.CONTACTED,
  LEAD_STATUS.QUALIFIED,
];

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  won: "Won — Converted",
  lost: "Lost",
};

export const LEAD_STATUS_TONE: Record<LeadStatus, Tone> = {
  new: "blue",
  contacted: "amber",
  qualified: "purple",
  won: "green",
  lost: "slate",
};

/**
 * A load's position in the workflow. One value at a time, and it only moves forward.
 *
 * Kept out of `lookups` on purpose, unlike carrier status: these seven drive behaviour
 * (an invoice may only be raised against a Delivered load) rather than merely labelling
 * it, so they are not a vocabulary a customer may rename or retire.
 */
export const LOAD_STATUS = {
  CREATED: "created",
  ASSIGNED: "assigned",
  PICKED_UP: "picked_up",
  IN_TRANSIT: "in_transit",
  DELIVERED: "delivered",
  INVOICED: "invoiced",
  PAID: "paid",
  CLOSED: "closed",
} as const;

export type LoadStatus = (typeof LOAD_STATUS)[keyof typeof LOAD_STATUS];

/** The order they may be reached in. Index position is the whole rule. */
export const LOAD_STATUS_ORDER: LoadStatus[] = [
  LOAD_STATUS.CREATED,
  LOAD_STATUS.ASSIGNED,
  LOAD_STATUS.PICKED_UP,
  LOAD_STATUS.IN_TRANSIT,
  LOAD_STATUS.DELIVERED,
  LOAD_STATUS.INVOICED,
  LOAD_STATUS.PAID,
  LOAD_STATUS.CLOSED,
];

export const LOAD_STATUS_LABELS: Record<LoadStatus, string> = {
  created: "Created",
  assigned: "Assigned",
  picked_up: "Picked Up",
  in_transit: "In Transit",
  delivered: "Delivered",
  invoiced: "Invoiced",
  paid: "Paid",
  closed: "Closed",
};

export const LOAD_STATUS_TONE: Record<LoadStatus, Tone> = {
  created: "slate",
  assigned: "blue",
  picked_up: "amber",
  in_transit: "amber",
  delivered: "green",
  invoiced: "purple",
  paid: "green",
  closed: "slate",
};

/**
 * Exceptions sit **beside** the main status, never replacing it: a load can be Delivered
 * and carry a deduction, or Assigned and then become a TONU. Modelling them as statuses
 * would have forced a choice between two facts that are both true.
 */
export const LOAD_EXCEPTION = {
  TONU: "tonu",
  CANCELLED: "cancelled",
  EXTRA_PAY: "extra_pay",
  DEDUCTION: "deduction",
} as const;

export type LoadException = (typeof LOAD_EXCEPTION)[keyof typeof LOAD_EXCEPTION];

export const LOAD_EXCEPTION_LABELS: Record<LoadException, string> = {
  tonu: "TONU (Truck Ordered Not Used)",
  cancelled: "Cancelled",
  extra_pay: "Extra Pay",
  deduction: "Deduction",
};

/** Itemized deductions/extra pay against one load — see load-adjustments.ts. What Final
 *  Load Amount (loads.ts) and, downstream, the dispatch fee are built from. */
export const ADJUSTMENT_KIND = { DEDUCTION: "deduction", EXTRA_PAY: "extra_pay" } as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KIND)[keyof typeof ADJUSTMENT_KIND];
export const ADJUSTMENT_KIND_LABELS: Record<AdjustmentKind, string> = {
  deduction: "Deduction",
  extra_pay: "Extra Pay",
};
export const ADJUSTMENT_KIND_TONE: Record<AdjustmentKind, Tone> = {
  deduction: "red",
  extra_pay: "green",
};

/** How a carrier's Asterism dispatch fee is calculated for one load — see
 *  invoices.ts's computeDispatchFee. */
export const FEE_BASIS = { PERCENTAGE: "percentage", FLAT: "flat" } as const;
export type FeeBasis = (typeof FEE_BASIS)[keyof typeof FEE_BASIS];

/** An invoice's own status. Free transitions, not forward-only like loads.status — a
 *  mistaken Paid has to be correctable. See invoice-write.ts's setInvoiceStatus. */
export const INVOICE_STATUS = { PENDING: "pending", PAID: "paid", DISPUTED: "disputed" } as const;
export type InvoiceStatus = (typeof INVOICE_STATUS)[keyof typeof INVOICE_STATUS];
export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  pending: "Pending",
  paid: "Paid",
  disputed: "Disputed",
};
export const INVOICE_STATUS_TONE: Record<InvoiceStatus, Tone> = {
  pending: "amber",
  paid: "green",
  disputed: "red",
};

/**
 * A document attached to a load — Rate Confirmation, Bill of Lading, Proof of Delivery, or
 * anything else dispatch needs on file (a lumper receipt, a scale ticket, damage photos).
 * Kept out of `lookups` for the same reason LOAD_STATUS and LOAD_EXCEPTION are: a fixed
 * industry taxonomy, not something a tenant customizes.
 */
export const DOCUMENT_KIND = {
  RATE_CONFIRMATION: "rate_confirmation",
  BOL: "bol",
  POD: "pod",
  OTHER: "other",
} as const;

export type DocumentKind = (typeof DOCUMENT_KIND)[keyof typeof DOCUMENT_KIND];

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  rate_confirmation: "Rate Confirmation",
  bol: "Bill of Lading",
  pod: "Proof of Delivery",
  other: "Other",
};

export const DOCUMENT_KIND_TONE: Record<DocumentKind, Tone> = {
  rate_confirmation: "blue",
  bol: "slate",
  pod: "green",
  other: "slate",
};

/** Reject anything else at upload — never trust a browser's declared type alone for what
 *  gets served back to a browser later. */
export const DOCUMENT_ALLOWED_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
// 10MB, not 15MB: next.config.ts already caps every Server Action body at 12mb (raised
// from the 1MB default for CSV import); this leaves headroom under that shared ceiling
// for the multipart envelope rather than raising it for one feature.
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

/** A stop is a pickup or a delivery. Doc 2 allows up to five of each on one load. */
export const STOP_KIND = { PICKUP: "pickup", DELIVERY: "delivery" } as const;
export type StopKind = (typeof STOP_KIND)[keyof typeof STOP_KIND];
export const MAX_STOPS_PER_KIND = 5;

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
  { kind: "pricing_type", value: "flat_per_load", label: "Flat Fee Per Load" },
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
  /** Submits leads and tracks onboarding. Sees no rate, no load and no invoice — the
   *  sales sidebar has no Carrier or Load Management on it at all. */
  SALES: "sales",
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
  sales: "Sales Representative",
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

/**
 * A channel is open to everyone, or to one team. `audience` holds either this value or a
 * role name — administrators hold every action, so they read every channel without the
 * audience needing to say so.
 */
export const CHANNEL_AUDIENCE_ALL = "all";

export type SeedChannel = { name: string; description: string; audience: string };

/**
 * The channels every organisation starts with — the client's spec names two of them
 * outright ("Internal use Dispatch Team, Sales Team"). Seeded per tenant like `lookups`
 * and `SEED_BROKERS`, for the same reason: one company renaming or retiring a channel
 * must not touch another's.
 */
export const SEED_CHANNELS: SeedChannel[] = [
  {
    name: "General",
    description: "Everyone in the company.",
    audience: CHANNEL_AUDIENCE_ALL,
  },
  {
    name: "Dispatch Team",
    description: "Loads, drivers, brokers — dispatch and administrators.",
    audience: ROLES.DISPATCHER,
  },
  {
    name: "Sales Team",
    description: "Leads and onboarding — sales and administrators.",
    audience: ROLES.SALES,
  },
];

/**
 * The brokers a dispatcher picks from, seeded into every organisation.
 *
 * Per-tenant rather than global, for the same reason `lookups` is: one company correcting
 * a spelling or retiring a broker must not edit another company's dropdown. A dispatcher
 * may add one that is missing; only an administrator may edit the list afterwards, which
 * is what keeps a typo from quietly becoming a second broker forever.
 */
export const SEED_BROKERS: string[] = [
  "7L Freight",
  "A. Duie Pyle Logistics",
  "AAA Cooper Logistics",
  "AIT Worldwide Logistics",
  "Allen Lund Company",
  "American Logistics Inc",
  "Armstrong Transport Group",
  "Arrive Logistics",
  "Ascent Global Logistics",
  "Avenue Logistics",
  "Axle Logistics",
  "BNSF Logistics",
  "Beemac Logistics",
  "C.H. Robinson",
  "Cardinal Logistics",
  "Circle Logistics",
  "Convoy (Legacy)",
  "Coyote Logistics",
  "Crowley Logistics",
  "DB Schenker",
  "Echo Global Logistics",
  "England Logistics",
  "Estes Logistics",
  "Expeditors",
  "FedEx Logistics",
  "FitzMark",
  "FLS Transportation Services",
  "Flexport",
  "Forward Air Solutions",
  "GEODIS",
  "Giltner Logistics",
  "GlobalTranz Enterprises",
  "GXO Logistics",
  "Hub Group",
  "Integrity Express Logistics",
  "ITS Logistics",
  "J.B. Hunt Integrated Capacity Solutions",
  "Johanson Transportation Service",
  "KAG Logistics",
  "KNX / Swift Logistics",
  "Landstar Ranger",
  "Legacy Supply Chain Services",
  "Logistics Plus",
  "Matson Logistics",
  "Max Trans Logistics",
  "MegaCorp Logistics",
  "Mercer Transportation",
  "Mode Global",
  "MOLO Solutions",
  "Navajo Express / DSCO",
  "NFI Logistics",
  "Nolan Transportation Group",
  "North American Logistics Services",
  "Odyssey Logistics",
  "Old Dominion Logistics",
  "Penske Logistics",
  "PLS Logistics Services",
  "Polaris Logistics Group",
  "Priority Freight",
  "Priority1",
  "R+L Global Logistics",
  "Radiant Logistics",
  "Redwood Logistics",
  "ROAR Logistics",
  "RXO Capacity Solutions",
  "Ryan Transportation Service",
  "Saia Logistics",
  "Saddle Creek Logistics",
  "Schneider Brokerage",
  "Scotlynn Transport",
  "SEKO Logistics",
  "Spot Freight",
  "Steam Logistics",
  "StoneArch Logistics",
  "Sunset Transportation",
  "Sunteck Transport",
  "Syfan Logistics",
  "TForce Logistics",
  "TMS North America",
  "Titan Logistics",
  "Total Quality Logistics (TQL)",
  "Transgroup Logistics",
  "TransLoop",
  "Transplace (Uber Freight)",
  "Trinity Logistics",
  "Trinity Transport",
  "US Logistics",
  "USA Truck Brokerage",
  "Uber Freight",
  "Universal Logistics",
  "V Logistics Corp",
  "Vanguard Logistics",
  "WWEX Group",
  "Werner Logistics",
  "Worldwide Express",
  "XPO / RXO",
  "Yellow Logistics (Legacy)",
  "Yusen Logistics",
  "Zenith Logistics",
  "Zuum Transportation",
];
