import { ROLES, type Role } from "./constants.ts";

export type SessionUser = {
  id: number;
  organization_id: number;
  name: string;
  email: string;
  role: Role;
  active: number;
};

/** The subset of a carrier needed to decide ownership. */
export type CarrierScope = {
  dispatcher_id: number | null;
  account_manager_id: number | null;
};

export type Action =
  | "carrier:view"
  | "carrier:create"
  | "carrier:edit"
  | "carrier:delete"
  | "carrier:offboard"
  | "note:create"
  | "import:run"
  | "export:run"
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
  carrier?: CarrierScope | null,
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
    !!carrier &&
    (carrier.dispatcher_id === user.id || carrier.account_manager_id === user.id);

  switch (action) {
    case "carrier:view":
    case "export:run":
      return true;

    case "carrier:create":
    case "note:create":
      return user.role === ROLES.DISPATCHER || user.role === ROLES.ACCOUNT_MANAGER;

    case "carrier:edit":
    case "carrier:offboard":
      // Without a specific carrier this answers "could this role ever edit?" —
      // used to decide whether to render an action at all.
      if (user.role !== ROLES.DISPATCHER && user.role !== ROLES.ACCOUNT_MANAGER) return false;
      return carrier === undefined ? true : assigned;

    case "carrier:delete":
    case "import:run":
    case "team:manage":
    case "settings:manage":
      return false;
  }
}

export function assertCan(
  user: SessionUser | null | undefined,
  action: Action,
  carrier?: CarrierScope | null,
): asserts user is SessionUser {
  if (!can(user, action, carrier)) {
    throw new Error("Not authorized to perform this action.");
  }
}
