"use client";

import { useActionState, useRef, useState } from "react";
import {
  createTeamMemberAction, updateTeamMemberAction, toggleTeamMemberAction,
  setPasswordAction, type AdminState,
} from "@/lib/admin-actions";
import { issueResetAction, type IssueState } from "@/lib/reset-actions";
import { ROLE_LABELS, ROLES, type Role } from "@/lib/constants";
import { Badge } from "./ui";
import { Icon } from "./icons";
import { Text } from "./form-fields";

export type TeamRow = {
  id: number;
  name: string;
  email: string;
  role: Role;
  phone: string | null;
  active: number;
  /** Null while an invitation is still outstanding — see `TeamMember` in team.ts. */
  email_verified_at: string | null;
  dispatching: number;
  managing: number;
};

// Platform support is left out on purpose: it crosses organisations, so an organisation's
// administrator must not be able to grant it. `team.ts` refuses it too — this only keeps
// the UI honest about what it offers.
const ROLE_OPTIONS = (Object.keys(ROLE_LABELS) as Role[])
  .filter((r) => r !== ROLES.SUPPORT)
  .map((r, i) => ({ id: i, label: ROLE_LABELS[r], value: r }));

const ROLE_TONE: Record<Role, "purple" | "blue" | "green" | "slate" | "amber"> = {
  support: "purple",
  owner: "amber",
  admin: "purple",
  dispatcher: "blue",
  account_manager: "green",
  viewer: "slate",
};

/** Role is a string slug, not a lookup id, so it needs a plain select. */
function RoleSelect({ name, defaultValue }: { name: string; defaultValue?: Role }) {
  return (
    <select name={name} defaultValue={defaultValue ?? "dispatcher"} required className="field">
      {ROLE_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

function Banner({ state }: { state: AdminState }) {
  if (state.error) {
    return (
      <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {state.error}
      </p>
    );
  }
  if (state.ok) {
    return (
      <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
        {state.ok}
      </p>
    );
  }
  return null;
}

export function TeamManager({ team, currentUserId }: { team: TeamRow[]; currentUserId: number }) {
  const [addState, addAction, adding] = useActionState<AdminState, FormData>(createTeamMemberAction, {});
  const [editing, setEditing] = useState<TeamRow | null>(null);
  const [passwordFor, setPasswordFor] = useState<TeamRow | null>(null);
  const addRef = useRef<HTMLDialogElement>(null);
  const editRef = useRef<HTMLDialogElement>(null);
  const pwRef = useRef<HTMLDialogElement>(null);

  // Mirrors setTeamMemberActive: an organisation must keep one active owner or admin.
  const activeAdmins = team.filter(
    (t) => (t.role === ROLES.ADMIN || t.role === ROLES.OWNER) && t.active,
  ).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-500">
          {team.filter((t) => t.active).length} active ·{" "}
          {team.filter((t) => !t.active).length} deactivated
        </p>
        <button
          type="button"
          onClick={() => addRef.current?.showModal()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
        >
          <Icon name="plus" className="h-4 w-4" />
          Add team member
        </button>
      </div>

      <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line bg-ink-50/70">
              {["Name", "Email", "Role", "Dispatching", "Managing", "Status", ""].map((h, i) => (
                <th
                  key={h || i}
                  scope="col"
                  className={`px-4 py-2.5 text-xs font-semibold text-ink-600 ${
                    i >= 3 && i <= 4 ? "text-right" : "text-left"
                  }`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {team.map((m) => (
              <tr key={m.id} className={`border-b border-line/70 last:border-0 ${m.active ? "" : "opacity-60"}`}>
                <td className="px-4 py-2.5 font-medium text-ink-900">
                  {m.name}
                  {m.id === currentUserId && (
                    <span className="ml-1.5 text-xs font-normal text-ink-400">(you)</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-ink-600">{m.email}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={ROLE_TONE[m.role]}>{ROLE_LABELS[m.role]}</Badge>
                </td>
                <td className="tnum px-4 py-2.5 text-right text-ink-700">{m.dispatching}</td>
                <td className="tnum px-4 py-2.5 text-right text-ink-700">{m.managing}</td>
                <td className="px-4 py-2.5">
                  {!m.active ? (
                    <Badge tone="slate">Deactivated</Badge>
                  ) : m.email_verified_at ? (
                    <Badge tone="green">Active</Badge>
                  ) : (
                    <Badge tone="amber">Invited</Badge>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={() => { setEditing(m); editRef.current?.showModal(); }}
                      className="rounded p-1.5 text-ink-500 transition hover:bg-ink-100 hover:text-ink-900"
                      title={`Edit ${m.name}`}
                    >
                      <Icon name="edit" className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => { setPasswordFor(m); pwRef.current?.showModal(); }}
                      className="rounded px-2 py-1 text-xs font-medium text-ink-500 transition hover:bg-ink-100 hover:text-ink-900"
                    >
                      Password
                    </button>
                    <form action={toggleTeamMemberAction}>
                      <input type="hidden" name="id" value={m.id} />
                      <input type="hidden" name="active" value={m.active ? "0" : "1"} />
                      <button
                        type="submit"
                        disabled={m.active === 1 && (m.role === ROLES.ADMIN || m.role === ROLES.OWNER) && activeAdmins <= 1}
                        title={
                          m.active === 1 && (m.role === ROLES.ADMIN || m.role === ROLES.OWNER) && activeAdmins <= 1
                            ? "The last active administrator cannot be deactivated"
                            : undefined
                        }
                        className="rounded px-2 py-1 text-xs font-medium text-ink-500 transition hover:bg-ink-100 hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {m.active ? "Deactivate" : "Reactivate"}
                      </button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-ink-500">
        Deactivating keeps every historical reference intact — a departed colleague still
        shows as the author of their notes and status changes. Their sessions end immediately
        and their carriers stay assigned until reassigned.
      </p>

      <Dialog ref={addRef} title="Invite a team member">
        <form action={addAction} className="space-y-4">
          <Banner state={addState} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Text name="name" label="Full name" required defaultValue={addState.values?.name} />
            <Text name="email" label="Work email" type="email" required defaultValue={addState.values?.email} />
            <div>
              <label className="label" htmlFor="role">Role</label>
              <RoleSelect name="role" />
            </div>
            <Text name="phone" label="Phone" type="tel" defaultValue={addState.values?.phone} />
          </div>
          <p className="text-xs leading-relaxed text-ink-500">
            They get an email with a link and choose their own password, so nobody has to
            invent one and send it over chat. The link lasts seven days, and until it is
            used the account cannot be signed into.
          </p>
          <DialogActions dialogRef={addRef} pending={adding} label="Send invitation" />
        </form>
      </Dialog>

      <Dialog ref={editRef} title={editing ? `Edit ${editing.name}` : "Edit"}>
        {editing && <EditForm member={editing} dialogRef={editRef} />}
      </Dialog>

      <Dialog ref={pwRef} title={passwordFor ? `Set password for ${passwordFor.name}` : "Set password"}>
        {passwordFor && <PasswordForm member={passwordFor} dialogRef={pwRef} />}
      </Dialog>
    </div>
  );
}

function EditForm({
  member,
  dialogRef,
}: {
  member: TeamRow;
  dialogRef: React.RefObject<HTMLDialogElement | null>;
}) {
  const [state, action, pending] = useActionState<AdminState, FormData>(updateTeamMemberAction, {});
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="id" value={member.id} />
      <Banner state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Text name="name" label="Full name" required defaultValue={member.name} />
        <Text name="email" label="Work email" type="email" required defaultValue={member.email} />
        <div>
          <label className="label" htmlFor="role">Role</label>
          <RoleSelect name="role" defaultValue={member.role} />
        </div>
        <Text name="phone" label="Phone" type="tel" defaultValue={member.phone ?? ""} />
      </div>
      <DialogActions dialogRef={dialogRef} pending={pending} label="Save changes" />
    </form>
  );
}

function PasswordForm({
  member,
  dialogRef,
}: {
  member: TeamRow;
  dialogRef: React.RefObject<HTMLDialogElement | null>;
}) {
  const [state, action, pending] = useActionState<AdminState, FormData>(setPasswordAction, {});
  const [link, issueAction, issuing] = useActionState<IssueState, FormData>(issueResetAction, {});
  const [copied, setCopied] = useState(false);

  const fullLink = link.link ? `${window.location.origin}${link.link}` : "";

  return (
    <div className="space-y-5">
      {/* Preferred route: the administrator never learns the password. */}
      <form action={issueAction} className="space-y-3">
        <input type="hidden" name="userId" value={member.id} />
        <div>
          <h3 className="text-sm font-semibold text-ink-900">
            {member.email_verified_at ? "Send a reset link" : "Resend the invitation"}
          </h3>
          <p className="mt-0.5 text-xs text-ink-500">
            {member.email_verified_at
              ? `${member.name} chooses their own password. You never see it.`
              : `${member.name} has not used their invitation yet. This replaces it with a new link.`}{" "}
            The link works once and expires in 24 hours — emailed where mail is configured,
            and handed to you to pass on where it is not.
          </p>
        </div>
        {link.error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {link.error}
          </p>
        )}
        {link.sentTo ? (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
            Sent to {link.sentTo}. Nothing to copy — the link went straight to {link.forName}.
          </p>
        ) : link.link ? (
          <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
            <p className="text-xs font-medium text-emerald-900">
              One-time link for {link.forName} — copy it now, it is not shown again.
            </p>
            <div className="flex gap-2">
              <input readOnly value={fullLink} className="field field-sm font-mono text-[0.72rem]" />
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(fullLink);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="shrink-0 rounded-lg border border-line-strong bg-surface px-3 text-xs font-semibold text-ink-700 hover:bg-ink-50"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="submit"
            disabled={issuing}
            className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
          >
            {issuing ? "Generating…" : "Generate reset link"}
          </button>
        )}
      </form>

      <details className="border-t border-line pt-4">
        <summary className="cursor-pointer text-sm font-semibold text-ink-700">
          Or set a password directly
        </summary>
        <form action={action} className="mt-3 space-y-4">
          <input type="hidden" name="id" value={member.id} />
          <Banner state={state} />
          <Text name="password" label="New password" type="password" required hint="At least 8 characters." />
          <Text name="confirm" label="Confirm password" type="password" required />
          <p className="text-xs text-ink-500">
            You would then have to tell {member.name} what it is. A reset link avoids that.
            Every other session for this account is signed out either way.
          </p>
          <DialogActions dialogRef={dialogRef} pending={pending} label="Set password" />
        </form>
      </details>
    </div>
  );
}

function DialogActions({
  dialogRef,
  pending,
  label,
}: {
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  pending: boolean;
  label: string;
}) {
  return (
    <div className="flex justify-end gap-2 border-t border-line pt-3">
      <button
        type="button"
        onClick={() => dialogRef.current?.close()}
        className="rounded-lg border border-line-strong bg-surface px-4 py-2 text-sm font-semibold text-ink-700 transition hover:bg-ink-50"
      >
        Close
      </button>
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
      >
        {pending ? "Saving…" : label}
      </button>
    </div>
  );
}

function Dialog({
  ref,
  title,
  children,
}: {
  ref: React.RefObject<HTMLDialogElement | null>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <dialog
      ref={ref}
      onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}
      className="m-auto w-[min(34rem,92vw)] rounded-card border border-line bg-surface p-0 shadow-pop backdrop:bg-ink-950/50"
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <h2 className="text-base font-semibold tracking-tight text-ink-900">{title}</h2>
        <button
          type="button"
          onClick={() => ref.current?.close()}
          aria-label="Close"
          className="rounded p-1 text-ink-400 hover:text-ink-800"
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="p-5">{children}</div>
    </dialog>
  );
}
