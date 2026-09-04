/**
 * Communication — the internal channels.
 *
 * The rules worth pinning:
 *   1. A channel's audience narrows the *query*, so another team's room never reaches the
 *      page. The write path asks `can()` again, because a filtered list is presentation.
 *   2. Administrators read every channel without the audience column naming them.
 *   3. Unread is per channel. Opening one must not mark the others read — which is the
 *      whole reason `channel_reads` is a table and not a second watermark column.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedOrg, type TestOrg } from "./helpers.ts";

const DB = path.join(tmpdir(), `carrier-hub-comms-${process.pid}.db`);
for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let comms: typeof import("../src/lib/communication.ts");
let permissions: typeof import("../src/lib/permissions.ts");
let C: typeof import("../src/lib/constants.ts");
let alpha: TestOrg;
let beta: TestOrg;
let org: import("../src/lib/tenant-db.ts").Org;
let betaOrg: import("../src/lib/tenant-db.ts").Org;
let dee: number;
let sal: number;

const now = () => new Date().toISOString();
const laterIso = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

/** The seeded channel of that name, in alpha. */
const channelNamed = (name: string) =>
  db.get<{ id: number; audience: string }>(
    "SELECT id, audience FROM channels WHERE organization_id = ? AND name = ?",
    [alpha.id, name],
  )!;

const asUser = (id: number, role: string) => ({
  id,
  organization_id: alpha.id,
  name: "Test",
  email: "t@x.test",
  role: role as never,
  active: 1,
});

before(async () => {
  db = await import("../src/lib/db.ts");
  comms = await import("../src/lib/communication.ts");
  permissions = await import("../src/lib/permissions.ts");
  C = await import("../src/lib/constants.ts");
  const { Org } = await import("../src/lib/tenant-db.ts");

  alpha = seedOrg(db, "Alpha Comms");
  beta = seedOrg(db, "Beta Comms");
  org = new Org(alpha.id);
  betaOrg = new Org(beta.id);

  const addUser = (orgId: number, name: string, email: string, role: string) => {
    db.run(
      `INSERT INTO users (organization_id, name, email, password_hash, role, active, created_at, updated_at)
       VALUES (?, ?, ?, 'x', ?, 1, ?, ?)`,
      [orgId, name, email, role, now(), now()],
    );
    return db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  };
  dee = addUser(alpha.id, "Dee Dispatcher", "dee@comms.test", C.ROLES.DISPATCHER);
  sal = addUser(alpha.id, "Sal Sales", "sal@comms.test", C.ROLES.SALES);
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

beforeEach(() => {
  for (const o of [alpha, beta]) {
    db.run("DELETE FROM messages WHERE organization_id = ?", [o.id]);
    db.run("DELETE FROM channel_reads WHERE organization_id = ?", [o.id]);
    db.run("DELETE FROM channels WHERE organization_id = ? AND seeded = 0", [o.id]);
    db.run("UPDATE channels SET archived = 0 WHERE organization_id = ?", [o.id]);
  }
});

// ── seeding and audience ─────────────────────────────────────────────────────

test("every organisation starts with the three channels the spec names", () => {
  const names = comms
    .listChannels(org, asUser(alpha.ownerId, C.ROLES.OWNER))
    .map((c) => c.name)
    .sort();
  assert.deepEqual(names, ["Dispatch Team", "General", "Sales Team"]);
});

test("a team channel is not in another team's list at all", () => {
  const forDee = comms.listChannels(org, asUser(dee, C.ROLES.DISPATCHER)).map((c) => c.name).sort();
  assert.deepEqual(forDee, ["Dispatch Team", "General"]);

  const forSal = comms.listChannels(org, asUser(sal, C.ROLES.SALES)).map((c) => c.name).sort();
  assert.deepEqual(forSal, ["General", "Sales Team"]);
});

test("a role in neither team still gets the general channel", () => {
  const forViewer = comms.listChannels(org, asUser(1, C.ROLES.VIEWER)).map((c) => c.name);
  assert.deepEqual(forViewer, ["General"]);
});

test("administrators read every channel without the audience naming them", () => {
  for (const role of [C.ROLES.ADMIN, C.ROLES.OWNER]) {
    assert.equal(comms.listChannels(org, asUser(alpha.ownerId, role)).length, 3, role);
  }
});

test("the audience decides access, and it is the same answer the list gives", () => {
  const { can } = permissions;
  const dispatch = channelNamed("Dispatch Team");
  const general = channelNamed("General");

  assert.equal(can(asUser(dee, C.ROLES.DISPATCHER), "message:view", dispatch), true);
  assert.equal(can(asUser(sal, C.ROLES.SALES), "message:view", dispatch), false);
  assert.equal(can(asUser(sal, C.ROLES.SALES), "message:view", general), true);
  assert.equal(can(asUser(alpha.ownerId, C.ROLES.OWNER), "message:view", dispatch), true);
  assert.equal(can(asUser(1, C.ROLES.SUPPORT), "message:view", general), false);
});

test("reading a channel and posting to it are the same permission", () => {
  const { can } = permissions;
  const dispatch = channelNamed("Dispatch Team");
  // A read-only member is a concept nobody asked for, so the two must not drift apart.
  for (const user of [asUser(dee, C.ROLES.DISPATCHER), asUser(sal, C.ROLES.SALES)]) {
    assert.equal(can(user, "message:view", dispatch), can(user, "message:post", dispatch));
  }
});

// ── messages ─────────────────────────────────────────────────────────────────

test("an empty message is not a message", () => {
  const general = channelNamed("General");
  assert.equal(comms.postMessage(org, general.id, "   \n ", dee).ok, false);
});

test("messages come back oldest-first, with their author", () => {
  const general = channelNamed("General");
  comms.postMessage(org, general.id, "First", dee);
  comms.postMessage(org, general.id, "Second", sal);

  const messages = comms.listMessages(org, general.id);
  assert.deepEqual(messages.map((m) => m.body), ["First", "Second"]);
  assert.equal(messages[0]!.author_name, "Dee Dispatcher");
  assert.equal(messages[1]!.author_role, C.ROLES.SALES);
});

test("the message window keeps the newest, not the oldest", () => {
  const general = channelNamed("General");
  for (let i = 1; i <= 5; i++) comms.postMessage(org, general.id, `Message ${i}`, dee);

  const window = comms.listMessages(org, general.id, 3);
  assert.deepEqual(window.map((m) => m.body), ["Message 3", "Message 4", "Message 5"]);
});

test("an archived channel keeps everything and accepts nothing new", () => {
  const general = channelNamed("General");
  comms.postMessage(org, general.id, "Said before archiving", dee);
  comms.setChannelArchived(org, general.id, true);

  const result = comms.postMessage(org, general.id, "Too late", dee);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /archived/i);
  assert.equal(comms.listMessages(org, general.id).length, 1, "nothing was lost");
});

test("messages are append-only — the module offers no way to change or remove one", () => {
  // The guard is the absence of a write path, so this asserts the absence rather than a
  // behaviour. `carrier_notes` and `load_documents` follow the same rule.
  const surface = Object.keys(comms);
  for (const forbidden of ["editMessage", "updateMessage", "deleteMessage", "removeMessage"]) {
    assert.ok(!surface.includes(forbidden), `communication.ts must not export ${forbidden}`);
  }
});

// ── unread, per channel ──────────────────────────────────────────────────────

test("your own messages are never unread to you", () => {
  const general = channelNamed("General");
  comms.postMessage(org, general.id, "Mine", dee);
  assert.equal(comms.unreadMessages(org, asUser(dee, C.ROLES.DISPATCHER)), 0);
  assert.equal(comms.unreadMessages(org, asUser(sal, C.ROLES.SALES)), 1);
});

test("opening a channel clears its unread and nothing else's", () => {
  const general = channelNamed("General");
  const sales = channelNamed("Sales Team");
  comms.postMessage(org, general.id, "In general", dee);
  comms.postMessage(org, sales.id, "In sales", alpha.ownerId);

  const salUser = asUser(sal, C.ROLES.SALES);
  assert.equal(comms.unreadMessages(org, salUser), 2);

  comms.markChannelRead(org, general.id, sal);

  // The whole reason channel_reads is a table: a single watermark per person would have
  // marked the sales channel read here too, and nobody would know it had happened.
  assert.equal(comms.unreadMessages(org, salUser), 1);
  const byName = Object.fromEntries(
    comms.listChannels(org, salUser).map((c) => [c.name, c.unread]),
  );
  assert.equal(byName["General"], 0);
  assert.equal(byName["Sales Team"], 1);
});

test("a message posted after you looked is unread again", () => {
  const general = channelNamed("General");
  comms.postMessage(org, general.id, "Old", dee);
  comms.markChannelRead(org, general.id, sal);
  assert.equal(comms.unreadMessages(org, asUser(sal, C.ROLES.SALES)), 0);

  // Explicitly later: marking read and posting in the same millisecond is otherwise
  // ambiguous, and a real second message is not.
  db.run(
    "INSERT INTO messages (organization_id, channel_id, body, author_id, created_at) VALUES (?, ?, 'New', ?, ?)",
    [alpha.id, general.id, dee, laterIso(5)],
  );
  assert.equal(comms.unreadMessages(org, asUser(sal, C.ROLES.SALES)), 1);
});

test("unread never counts a channel you cannot read", () => {
  const dispatch = channelNamed("Dispatch Team");
  comms.postMessage(org, dispatch.id, "Dispatch only", dee);

  assert.equal(comms.unreadMessages(org, asUser(sal, C.ROLES.SALES)), 0);
  assert.equal(comms.unreadMessages(org, asUser(alpha.ownerId, C.ROLES.OWNER)), 1);
});

test("an archived channel stops contributing unread", () => {
  const general = channelNamed("General");
  comms.postMessage(org, general.id, "Before", dee);
  assert.equal(comms.unreadMessages(org, asUser(sal, C.ROLES.SALES)), 1);

  comms.setChannelArchived(org, general.id, true);
  assert.equal(comms.unreadMessages(org, asUser(sal, C.ROLES.SALES)), 0);
});

// ── opening channels ─────────────────────────────────────────────────────────

test("a channel needs a name, and cannot duplicate one that exists", () => {
  assert.equal(comms.createChannel(org, { name: "  " }, alpha.ownerId).ok, false);

  const clash = comms.createChannel(org, { name: "general" }, alpha.ownerId);
  assert.equal(clash.ok, false, "matched case-insensitively, like brokers are");
  assert.match((clash as { error: string }).error, /already exists/i);
});

test("a channel cannot be addressed to platform support", () => {
  const result = comms.createChannel(
    org,
    { name: "Backchannel", audience: C.ROLES.SUPPORT },
    alpha.ownerId,
  );
  assert.equal(result.ok, false, "that would be a room nobody in the company could enter");
});

test("a new channel is not marked as one of ours", () => {
  assert.equal(comms.createChannel(org, { name: "Night Shift" }, alpha.ownerId).ok, true);
  const made = db.get<{ seeded: number; audience: string }>(
    "SELECT seeded, audience FROM channels WHERE organization_id = ? AND name = 'Night Shift'",
    [alpha.id],
  )!;
  assert.equal(made.seeded, 0, "seeded = 1 means we shipped it");
  assert.equal(made.audience, C.CHANNEL_AUDIENCE_ALL, "an audience nobody chose is everyone");
});

test("opening a channel for one team puts it in that team's list and no other", () => {
  comms.createChannel(org, { name: "Account Managers", audience: C.ROLES.ACCOUNT_MANAGER }, alpha.ownerId);

  const forAm = comms.listChannels(org, asUser(1, C.ROLES.ACCOUNT_MANAGER)).map((c) => c.name).sort();
  assert.deepEqual(forAm, ["Account Managers", "General"]);
  assert.ok(!comms.listChannels(org, asUser(dee, C.ROLES.DISPATCHER)).some((c) => c.name === "Account Managers"));
});

test("only an administrator may open or archive a channel", () => {
  const { can } = permissions;
  assert.equal(can(asUser(alpha.ownerId, C.ROLES.OWNER), "channel:manage"), true);
  assert.equal(can(asUser(1, C.ROLES.ADMIN), "channel:manage"), true);
  for (const role of [C.ROLES.DISPATCHER, C.ROLES.ACCOUNT_MANAGER, C.ROLES.SALES,
                      C.ROLES.VIEWER, C.ROLES.SUPPORT]) {
    assert.equal(can(asUser(1, role), "channel:manage"), false, role);
  }
});

// ── tenancy ──────────────────────────────────────────────────────────────────

test("one organisation's channels and messages are invisible to another", () => {
  const general = channelNamed("General");
  comms.postMessage(org, general.id, "ALPHA ONLY", dee);

  const betaOwner = {
    id: beta.ownerId,
    organization_id: beta.id,
    name: "Beta",
    email: "b@x.test",
    role: C.ROLES.OWNER as never,
    active: 1,
  };
  assert.ok(
    !comms.listChannels(betaOrg, betaOwner).some((c) => c.id === general.id),
    "beta's own General is a different row entirely",
  );
  assert.equal(comms.listMessages(betaOrg, general.id).length, 0);
  assert.equal(comms.getChannel(betaOrg, general.id), undefined);
  assert.equal(comms.unreadMessages(betaOrg, betaOwner), 0);
});

test("a deactivated user reaches no channel", () => {
  const dead = { ...asUser(dee, C.ROLES.DISPATCHER), active: 0 };
  assert.equal(permissions.can(dead, "message:view"), false);
  assert.equal(permissions.can(dead, "message:view", channelNamed("General")), false);
  assert.equal(permissions.can(dead, "message:post", channelNamed("General")), false);
});
