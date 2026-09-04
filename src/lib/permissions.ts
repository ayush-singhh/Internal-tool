import { ROLES, type Role } from "./constants.ts";

export type SessionUser = {
  id: number;
  organization_id: number;
  name: string;
  email: string;
  role: Role;
  active: number;
};

/**
 * The subset of a record needed to decide ownership — a carrier's assignments, or a
 * lead's owner. Every field is optional so a caller passes whichever its row has; a
 * missing one simply never matches, which keeps the check fail-closed by default.
 */
export type Scope = {
  dispatcher_id?: number | null;
  account_manager_id?: number | null;
  /** Leads: the person who submitted it and works it. */
  owner_id?: number | null;
};

/** The carrier call sites' name for it. Same shape. */
export type CarrierScope = Scope;

export type Action =
  // Leads — the stage before a carrier record exists
  /** See the pipeline. Sales see only their own; the scope argument is what decides. */
  | "lead:view"
  | "lead:create"
  | "lead:edit"
  /** Turn a qualified lead into a carrier record. It writes a carrier, so it belongs to
   *  the people who may create one — which is never sales. */
  | "lead:convert"
  // Carriers — the CRM half
  | "carrier:view"
  | "carrier:create"
  | "carrier:edit"
  | "carrier:delete"
  | "carrier:offboard"
  | "note:create"
  | "import:run"
  | "export:run"
  // Dispatch — the loads half
  | "load:view"
  /** Create, edit, assign a driver, and move status as far as Delivered. */
  | "load:manage"
  /** See the rate and both rates per mile. The single most guarded fact in the product. */
  | "load:rate"
  /** Move a load to Invoiced or Closed. Administrators only — those two statuses are
   *  the invoicing side of the flow, and dispatchers have no business there. */
  | "load:close"
  | "driver:manage"
  /** Add a broker the shipped list is missing. */
  | "broker:create"
  /** Correct or retire a broker. Administrators only, so one dispatcher's typo does not
   *  quietly become a second broker forever. */
  | "broker:edit"
  // Invoicing — Asterism's dispatch fee
  /** See invoices and what they total. Same scope as load:rate. */
  | "invoice:view"
  /** Generate a dispatch invoice and change its status (paid / disputed). No dispatcher
   *  tier exists here — the whole lifecycle is administrators only, same rationale as
   *  load:close. */
  | "invoice:manage"
  // Administration
  | "team:manage"
  | "settings:manage";

/**
 * Single source of truth for authorization. Server Actions call this directly —
 * hiding a button in the UI is presentation, never the security boundary.
 *
 * `carrier` scopes edit rights: dispatchers and account managers may edit the
 * carriers assigned to them, and no others.
 */
export function can(
  user: SessionUser | null | undefined,
  action: Action,
  scope?: Scope | null,
): boolean {
  if (!user || !user.active) return false;
  // Platform support is not a role *inside* an organisation. Their access is read-only,
  // recorded, and lives entirely under /support — they get nothing here, including view,
  // so a support session that somehow reached a tenant page still sees nothing.
  if (user.role === ROLES.SUPPORT) return false;
  // An owner is the person who created the tenant, so they hold everything an admin
  // does. Tenancy added the role; this is the only place that decides what it means.
  if (user.role === ROLES.ADMIN || user.role === ROLES.OWNER) return true;

  const assigned =
    !!scope &&
    (scope.dispatcher_id === user.id ||
      scope.account_manager_id === user.id ||
      scope.owner_id === user.id);

  // Sales submits leads and works them. They see no rate, no invoice and no load, and
  // their sidebar carries neither Carrier nor Load Management — so rather than listing
  // what they are refused, they are refused everything not explicitly theirs. Commission
  // becomes its own action when that feature exists.
  if (user.role === ROLES.SALES) {
    switch (action) {
      case "lead:view":
      case "lead:create":
        return true;
      // Their own leads, and no one else's. Without a scope this answers "could this role
      // ever edit a lead?" — which is what decides whether the button renders at all.
      case "lead:edit":
        return scope === undefined ? true : assigned;
      // Not lead:convert. Converting writes a carrier record, and sales cannot create one.
      default:
        return false;
    }
  }

  switch (action) {
    case "carrier:view":
    case "export:run":
    case "load:view":
    case "invoice:view":
      return true;

    // Everyone left who can see a load can see what it pays. The people who must never
    // see a rate — drivers and customers — have no login at all, which is why this is a
    // permission rather than a per-screen decision.
    case "load:rate":
      return true;

    case "carrier:create":
    case "note:create":
      return user.role === ROLES.DISPATCHER || user.role === ROLES.ACCOUNT_MANAGER;

    case "carrier:edit":
    case "carrier:offboard":
      // Without a specific carrier this answers "could this role ever edit?" —
      // used to decide whether to render an action at all.
      if (user.role !== ROLES.DISPATCHER && user.role !== ROLES.ACCOUNT_MANAGER) return false;
      return scope === undefined ? true : assigned;

    // Dispatch is the dispatcher's job, and nobody else's below administrator.
    case "load:manage":
    case "driver:manage":
    case "broker:create":
      return user.role === ROLES.DISPATCHER;

    // The supplied panel spec puts Lead Management on the Admin and Sales menus and on no
    // other. Dispatchers, account managers and viewers are therefore refused rather than
    // quietly included — the last thing this sidebar needs is a second deny-list.
    case "lead:view":
    case "lead:create":
    case "lead:edit":
    case "lead:convert":
    case "carrier:delete":
    case "import:run":
    case "load:close":
    case "broker:edit":
    case "invoice:manage":
    case "team:manage":
    case "settings:manage":
      return false;
  }
}

export function assertCan(
  user: SessionUser | null | undefined,
  action: Action,
  scope?: Scope | null,
): asserts user is SessionUser {
  if (!can(user, action, scope)) {
    throw new Error("Not authorized to perform this action.");
  }
}
