import "server-only";
import { randomBytes } from "node:crypto";
import { all, get, run, systemQuery } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import { hashPassword } from "./password.ts";
import { ROLES, type Role } from "./constants.ts";

export type TeamMember = {
  id: number;
  name: string;
  email: string;
  role: Role;
  phone: string | null;
  active: number;
  created_at: string;
  /** NULL until they have followed a link sent to that address — which is exactly what an
   *  invitation that has not been accepted looks like. No separate table, no second state
   *  to keep in step with this one. */
  email_verified_at: string | null;
  dispatching: number;
  managing: number;
};

export function listTeam(org: Org): TeamMember[] {
  return all<TeamMember>(
    `SELECT u.id, u.name, u.email, u.role, u.phone, u.active, u.created_at, u.email_verified_at,
            (SELECT COUNT(*) FROM carriers c WHERE c.organization_id = u.organization_id AND c.dispatcher_id = u.id)      AS dispatching,
            (SELECT COUNT(*) FROM carriers c WHERE c.organization_id = u.organization_id AND c.account_manager_id = u.id) AS managing
       FROM users u
      WHERE u.organization_id = ?
      ORDER BY u.active DESC, u.name`,
    [org.id],
  );
}

export type TeamResult = { ok: true; id: number } | { ok: false; error: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD = 8;
const VALID_ROLES = new Set<string>(Object.values(ROLES));

/**
 * Adds somebody to an organisation.
 *
 * With no password this is an **invitation**: the account is created with one nobody
 * knows — 32 random bytes, never shown, never used — and left unconfirmed, so it cannot
 * be signed into. The caller then mails a link, and setting a password through it both
 * confirms the address and turns the row into a real account. That is why an invitation
 * needs no table of its own: an unconfirmed member *is* an outstanding invitation.
 *
 * With a password it is the old direct route, for an account that has no mailbox to send
 * anything to.
 */
export function createTeamMember(org: Org, input: {
  name: string;
  email: string;
  role: string;
  phone?: string | null;
  password?: string;
}): TeamResult {
  const name = input.name.trim().slice(0, 120);
  const email = input.email.trim().toLowerCase().slice(0, 254);

  if (!name) return { ok: false, error: "Name is required." };
  if (!EMAIL.test(email)) return { ok: false, error: "Enter a valid email address." };
  if (!VALID_ROLES.has(input.role)) return { ok: false, error: "Choose a valid role." };
  const invited = !input.password;
  if (!invited && input.password!.length < MIN_PASSWORD) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD} characters.` };
  }
  // Checked across every organisation, not just this one: signing in looks an account up
  // by email alone, so the same address in two tenants would leave one of them unable to
  // sign in at all. The schema allows it; the application must not create it.
  if (systemQuery(() => get("SELECT id FROM users WHERE email = ?", [email]))) {
    return { ok: false, error: "Someone already uses that email address." };
  }

  const now = new Date().toISOString();
  run(
    `INSERT INTO users (organization_id, name, email, password_hash, role, phone, active,
                        email_verified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    // An invited account is unconfirmed and its password is unguessable, so the link is
    // the only way in. One typed by an administrator has nothing left to confirm.
    [org.id, name, email,
     hashPassword(input.password ?? randomBytes(32).toString("base64url")),
     input.role, input.phone?.trim() || null,
     invited ? null : now, now, now],
  );
  return { ok: true, id: get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id };
}

export function updateTeamMember(
  org: Org,
  id: number,
  input: { name?: string; email?: string; role?: string; phone?: string | null },
): TeamResult {
  const existing = get<{ id: number }>(
    "SELECT id FROM users WHERE organization_id = ? AND id = ?", [org.id, id],
  );
  if (!existing) return { ok: false, error: "Unknown team member." };

  const sets: string[] = [];
  const params: unknown[] = [];

  if (input.name !== undefined) {
    const name = input.name.trim().slice(0, 120);
    if (!name) return { ok: false, error: "Name is required." };
    sets.push("name = ?"); params.push(name);
  }
  if (input.email !== undefined) {
    const email = input.email.trim().toLowerCase().slice(0, 254);
    if (!EMAIL.test(email)) return { ok: false, error: "Enter a valid email address." };
    const clash = get<{ id: number }>(
      "SELECT id FROM users WHERE organization_id = ? AND email = ? AND id != ?", [org.id, email, id],
    );
    if (clash) return { ok: false, error: "Someone already uses that email address." };
    sets.push("email = ?"); params.push(email);
  }
  if (input.role !== undefined) {
    if (!VALID_ROLES.has(input.role)) return { ok: false, error: "Choose a valid role." };
    sets.push("role = ?"); params.push(input.role);
  }
  if (input.phone !== undefined) {
    sets.push("phone = ?"); params.push(input.phone?.trim() || null);
  }

  if (sets.length === 0) return { ok: true, id };
  sets.push("updated_at = ?"); params.push(new Date().toISOString(), org.id, id);
  run(`UPDATE users SET ${sets.join(", ")} WHERE organization_id = ? AND id = ?`, params);
  return { ok: true, id };
}

/**
 * Deactivating keeps every historical reference intact — a departed employee still
 * shows as the author of their notes and status changes. Their sessions are revoked
 * immediately.
 */
export function setTeamMemberActive(org: Org, id: number, active: boolean): TeamResult {
  const user = get<{ role: string; active: number }>(
    "SELECT role, active FROM users WHERE organization_id = ? AND id = ?", [org.id, id],
  );
  if (!user) return { ok: false, error: "Unknown team member." };

  // "Last admin" is scoped to THIS organisation — each tenant must keep one owner/admin.
  if (!active && (user.role === ROLES.ADMIN || user.role === ROLES.OWNER)) {
    const admins = get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM users WHERE organization_id = ? AND role IN (?, ?) AND active = 1",
      [org.id, ROLES.ADMIN, ROLES.OWNER],
    )!.n;
    if (admins <= 1) {
      return { ok: false, error: "You cannot deactivate the last active administrator." };
    }
  }

  run("UPDATE users SET active = ?, updated_at = ? WHERE organization_id = ? AND id = ?", [
    active ? 1 : 0, new Date().toISOString(), org.id, id,
  ]);
  if (!active) run("DELETE FROM sessions WHERE user_id = ?", [id]);
  return { ok: true, id };
}

/** Changing a password signs the account out everywhere except, optionally, one session. */
export function setPassword(org: Org, id: number, password: string, keepSession?: string): TeamResult {
  if (password.length < MIN_PASSWORD) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD} characters.` };
  }
  if (!get("SELECT id FROM users WHERE organization_id = ? AND id = ?", [org.id, id])) {
    return { ok: false, error: "Unknown team member." };
  }

  run("UPDATE users SET password_hash = ?, updated_at = ? WHERE organization_id = ? AND id = ?", [
    hashPassword(password), new Date().toISOString(), org.id, id,
  ]);
  if (keepSession) {
    run("DELETE FROM sessions WHERE user_id = ? AND id != ?", [id, keepSession]);
  } else {
    run("DELETE FROM sessions WHERE user_id = ?", [id]);
  }
  return { ok: true, id };
}

/** Demoting the last admin would lock everyone out of Settings and Team. */
export function wouldRemoveLastAdmin(org: Org, id: number, newRole: string): boolean {
  if (newRole === ROLES.ADMIN || newRole === ROLES.OWNER) return false;
  const user = get<{ role: string }>(
    "SELECT role FROM users WHERE organization_id = ? AND id = ?", [org.id, id],
  );
  if (user?.role !== ROLES.ADMIN && user?.role !== ROLES.OWNER) return false;
  const admins = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM users WHERE organization_id = ? AND role IN (?, ?) AND active = 1",
    [org.id, ROLES.ADMIN, ROLES.OWNER],
  )!.n;
  return admins <= 1;
}
