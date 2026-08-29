import "server-only";
import { all, run, systemQuery } from "./db.ts";
import type { Org } from "./tenant-db.ts";

/**
 * The security audit log: who signed in, who changed who can sign in, and who took data
 * out. `carrier_activity` answers "what happened to this carrier"; this answers the
 * question a customer's security review asks instead.
 *
 * **Append-only.** Nothing in this application updates or deletes a row, for the same
 * reason nothing edits `carrier_activity`: a record anyone can quietly change answers
 * nothing. Rows are written even when the action they describe failed — a refused sign-in
 * is exactly the thing worth having a record of.
 *
 * Recording never throws. An audit write that took down a sign-in would be a worse
 * failure than the one it was trying to document.
 */
export const AUDIT = {
  SIGNIN_SUCCESS: "signin.success",
  SIGNIN_FAILED: "signin.failed",
  SIGNIN_BLOCKED: "signin.blocked",
  MFA_ENABLED: "mfa.enabled",
  MFA_DISABLED: "mfa.disabled",
  MFA_RECOVERY_USED: "mfa.recovery_used",
  MFA_RECOVERY_REGENERATED: "mfa.recovery_regenerated",
  PASSWORD_CHANGED: "password.changed",
  PASSWORD_RESET_USED: "password.reset_used",
  MEMBER_INVITED: "member.invited",
  MEMBER_UPDATED: "member.updated",
  MEMBER_DEACTIVATED: "member.deactivated",
  MEMBER_REACTIVATED: "member.reactivated",
  EXPORT_RUN: "export.run",
} as const;

export type AuditAction = (typeof AUDIT)[keyof typeof AUDIT];

/** Written in the plainest terms that still say what happened, because these are read by
 *  somebody trying to work out whether something bad occurred. */
export const AUDIT_LABELS: Record<AuditAction, string> = {
  "signin.success": "Signed in",
  "signin.failed": "Failed sign-in",
  "signin.blocked": "Sign-in blocked by the lockout",
  "mfa.enabled": "Turned two-factor on",
  "mfa.disabled": "Turned two-factor off",
  "mfa.recovery_used": "Used a recovery code",
  "mfa.recovery_regenerated": "Issued new recovery codes",
  "password.changed": "Changed a password",
  "password.reset_used": "Set a password from a reset link",
  "member.invited": "Invited someone",
  "member.updated": "Changed someone's details or role",
  "member.deactivated": "Deactivated an account",
  "member.reactivated": "Reactivated an account",
  "export.run": "Exported carrier data",
};

export type AuditEntry = {
  id: number;
  action: AuditAction;
  subject: string | null;
  detail: string | null;
  ip: string | null;
  created_at: string;
  user_name: string | null;
};

export function record(entry: {
  organizationId: number;
  userId: number | null;
  /** The actor's address, written down rather than joined to. See the migration. */
  actor?: string | null;
  action: AuditAction;
  /** Who or what it was done to — an address, a name. Never a secret. */
  subject?: string | null;
  detail?: string | null;
  ip?: string | null;
}): void {
  try {
    systemQuery(() =>
      run(
        `INSERT INTO audit_log (organization_id, user_id, actor, action, subject, detail, ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.organizationId, entry.userId, entry.actor ?? null, entry.action,
          entry.subject?.slice(0, 200) ?? null,
          entry.detail?.slice(0, 400) ?? null,
          entry.ip?.slice(0, 64) ?? null,
          new Date().toISOString(),
        ],
      ),
    );
  } catch {
    // Deliberately swallowed. Losing an audit row is bad; failing the sign-in it was
    // describing is worse, and the alternative is an application that stops working
    // because a log table is full.
  }
}

export function recentAudit(org: Org, limit = 200): AuditEntry[] {
  return all<AuditEntry>(
    `SELECT a.id, a.action, a.subject, a.detail, a.ip, a.created_at,
            COALESCE(u.name, a.actor) AS user_name
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id AND u.organization_id = a.organization_id
      WHERE a.organization_id = ?
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ?`,
    [org.id, limit],
  );
}
