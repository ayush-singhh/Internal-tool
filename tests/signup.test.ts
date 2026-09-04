import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addressOf, buildMessage, type Mail } from "../src/lib/mailer.ts";

const DB = path.join(tmpdir(), `carrier-hub-signup-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;
process.env.SIGNUP_OPEN = "1";
process.env.APP_URL = "https://hub.example.com";

let db: typeof import("../src/lib/db.ts");
let signup: typeof import("../src/lib/signup.ts");
let login: typeof import("../src/lib/login.ts");
let lifecycle: typeof import("../src/lib/tenant-lifecycle.ts");

const sent: Mail[] = [];
const collect = async (mail: Mail) => {
  sent.push(mail);
};

const FIELDS = {
  orgName: "Blue Line Dispatch",
  ownerName: "Dana Reyes",
  email: "dana@bluelinedispatch.test",
  password: "a-real-password",
  confirm: "a-real-password",
};

before(async () => {
  db = await import("../src/lib/db.ts");
  signup = await import("../src/lib/signup.ts");
  login = await import("../src/lib/login.ts");
  lifecycle = await import("../src/lib/tenant-lifecycle.ts");
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

beforeEach(() => {
  sent.length = 0;
  process.env.SIGNUP_OPEN = "1";
  db.run("DELETE FROM login_attempts");
  db.systemQuery(() => {
    db.run("DELETE FROM email_verifications");
    // Every organisation a test made, removed the way the product removes one.
    //
    // This used to be a hand-written sequence of DELETEs in dependency order — the fourth
    // place a new tenant-owned table had to be registered, and the only one of the four
    // with neither the compiler nor a test behind it. Adding `channels` in Phase 19 and
    // `calendar_events` in Phase 21 each broke six unrelated tests here with a bare
    // `FOREIGN KEY constraint failed`, which names neither the table nor the reason.
    //
    // `deleteOrganization` already owns that order, and runs `PRAGMA foreign_key_check`
    // inside its own transaction. Calling it means this teardown cannot drift from the
    // product — and if a future table is missed *there*, it fails here loudly and in the
    // right place instead of silently leaving rows behind.
    //
    // `exported: true` is the one untruth: nothing is being archived, and the guard exists
    // so a real deletion cannot happen without a file to show for it.
    for (const org of db.all<{ id: number }>("SELECT id FROM organizations WHERE id > 1")) {
      lifecycle.deleteOrganization(org.id, { exported: true });
    }
    // Anything a test left on the baseline organisation, which no tenant deletion touches.
    db.run("DELETE FROM users WHERE email LIKE '%.test'");
  });
});

/** The link out of the most recent mail. */
function linkFrom(mail: Mail): string {
  return mail.text.match(/https?:\/\/\S+/)![0];
}

function userRow(email: string) {
  return db.systemQuery(() =>
    db.get<{ id: number; organization_id: number; email_verified_at: string | null }>(
      "SELECT id, organization_id, email_verified_at FROM users WHERE email = ?", [email],
    ),
  );
}

// ── the message ──────────────────────────────────────────────────────────────

test("a message is built with CRLF headers and a base64 body", () => {
  const message = buildMessage("Carrier Hub <no-reply@example.com>", {
    to: "dana@x.test",
    subject: "Confirm your email address",
    text: "Hello Dana,\nhttps://hub.example.com/verify/abc\n",
  }, new Date("2026-08-29T00:00:00Z"));

  const [headers, body] = message.split("\r\n\r\n");
  assert.match(headers!, /^From: Carrier Hub <no-reply@example\.com>\r\n/);
  assert.match(headers!, /\r\nTo: dana@x\.test\r\n/);
  assert.match(headers!, /\r\nContent-Transfer-Encoding: base64$/);
  assert.equal(
    Buffer.from(body!.replace(/\r\n/g, ""), "base64").toString("utf8"),
    "Hello Dana,\nhttps://hub.example.com/verify/abc\n",
  );
  assert.ok(!body!.split("\r\n").some((line) => line.startsWith(".")),
    "base64 cannot produce the line that would end the DATA block early");
});

test("a line break in an address or subject is refused, not smuggled into a header", () => {
  const mail = { to: "dana@x.test", subject: "Hi", text: "body" };
  assert.throws(() => buildMessage("a@b.test", { ...mail, to: "dana@x.test\r\nBcc: evil@x.test" }));
  assert.throws(() => buildMessage("a@b.test", { ...mail, subject: "Hi\nBcc: evil@x.test" }));
});

test("the envelope address is taken out of a display-name sender", () => {
  assert.equal(addressOf("Carrier Hub <no-reply@example.com>"), "no-reply@example.com");
  assert.equal(addressOf("no-reply@example.com"), "no-reply@example.com");
});

// ── signing up ───────────────────────────────────────────────────────────────

test("signup is closed unless the deployment opens it", async () => {
  process.env.SIGNUP_OPEN = "";
  const result = await signup.startSignup(FIELDS, "198.51.100.1", collect);
  assert.equal(result.ok, false);
  assert.equal(sent.length, 0, "and nothing is created or sent");
  assert.equal(userRow(FIELDS.email), undefined);
});

test("the form is validated before anything is created", async () => {
  const result = await signup.startSignup(
    { ...FIELDS, email: "not-an-email", password: "short", confirm: "different" },
    "198.51.100.2", collect,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.email, "the address");
  assert.ok(result.errors.password, "the length");
  assert.ok(result.errors.confirm, "the mismatch");
  assert.equal(sent.length, 0);
});

test("a new address gets an organisation, an owner who cannot yet sign in, and a link", async () => {
  assert.equal((await signup.startSignup(FIELDS, "198.51.100.3", collect)).ok, true);

  const user = userRow(FIELDS.email)!;
  assert.equal(user.email_verified_at, null, "unconfirmed until the link is clicked");

  const org = db.systemQuery(() =>
    db.get<{ name: string }>("SELECT name FROM organizations WHERE id = ?", [user.organization_id]),
  )!;
  assert.equal(org.name, FIELDS.orgName);
  const vocab = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM lookups WHERE organization_id = ?", [user.organization_id],
  )!.n;
  assert.ok(vocab > 0, "with its own vocabularies, like every other organisation");

  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, FIELDS.email);
  assert.match(linkFrom(sent[0]!), /^https:\/\/hub\.example\.com\/verify\//);

  const attempt = login.passwordStep(FIELDS.email, FIELDS.password, "198.51.100.3");
  assert.equal(attempt.ok, false, "the password is right but the address is not confirmed");
  if (!attempt.ok) assert.match(attempt.error, /Confirm your email/);
});

test("the link confirms the address, works once, and opens sign-in", async () => {
  await signup.startSignup(FIELDS, "198.51.100.4", collect);
  const token = linkFrom(sent[0]!).split("/").pop()!;

  const first = signup.verifyEmail(token);
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.email, FIELDS.email);
  assert.ok(userRow(FIELDS.email)!.email_verified_at, "recorded on the account");

  assert.equal(login.passwordStep(FIELDS.email, FIELDS.password, "198.51.100.4").ok, true);
  assert.equal(signup.verifyEmail(token).ok, true, "clicking the same link again is harmless");
  assert.equal(signup.verifyEmail("made-up-token").ok, false);
});

test("an expired link is refused", async () => {
  await signup.startSignup(FIELDS, "198.51.100.5", collect);
  const token = linkFrom(sent[0]!).split("/").pop()!;
  db.systemQuery(() =>
    db.run("UPDATE email_verifications SET expires_at = ?", [new Date(Date.now() - 1000).toISOString()]),
  );
  const result = signup.verifyEmail(token);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /expired/);
  assert.equal(userRow(FIELDS.email)!.email_verified_at, null);
});

test("signing up again with an unconfirmed address resends, and retires the old link", async () => {
  await signup.startSignup(FIELDS, "198.51.100.6", collect);
  const first = linkFrom(sent[0]!).split("/").pop()!;

  assert.equal((await signup.startSignup(FIELDS, "198.51.100.6", collect)).ok, true);
  const second = linkFrom(sent[1]!).split("/").pop()!;
  assert.notEqual(first, second);

  const orgs = db.systemQuery(() =>
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM organizations WHERE name = ?", [FIELDS.orgName]),
  )!.n;
  assert.equal(orgs, 1, "the second attempt does not create a second organisation");

  assert.equal(signup.verifyEmail(first).ok, false, "only the newest link works");
  assert.equal(signup.verifyEmail(second).ok, true);
});

test("an address that already belongs to somebody gets the same answer and no mail", async () => {
  await signup.startSignup(FIELDS, "198.51.100.7", collect);
  signup.verifyEmail(linkFrom(sent[0]!).split("/").pop()!);
  sent.length = 0;

  const result = await signup.startSignup(
    { ...FIELDS, orgName: "Someone Else Ltd" }, "198.51.100.7", collect,
  );
  assert.equal(result.ok, true, "indistinguishable from a fresh signup");
  assert.equal(sent.length, 0, "but nothing is sent");
  const orgs = db.systemQuery(() =>
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM organizations WHERE name = ?", ["Someone Else Ltd"]),
  )!.n;
  assert.equal(orgs, 0, "and no organisation is created in their name");
});

test("one address cannot end up in two organisations", async () => {
  await signup.startSignup(FIELDS, "198.51.100.8", collect);
  const rows = db.systemQuery(() =>
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE email = ?", [FIELDS.email]),
  )!.n;
  assert.equal(rows, 1, "sign-in finds an account by address alone — two would be ambiguous");
});

test("a host can only start so many organisations an hour", async () => {
  const ip = "198.51.100.9";
  for (let i = 0; i < 3; i++) {
    const result = await signup.startSignup(
      { ...FIELDS, orgName: `Co ${i}`, email: `owner${i}@throttle.test` }, ip, collect,
    );
    assert.equal(result.ok, true, `signup ${i + 1}`);
  }
  const blocked = await signup.startSignup(
    { ...FIELDS, orgName: "Co 4", email: "owner4@throttle.test" }, ip, collect,
  );
  assert.equal(blocked.ok, false);
  assert.equal(sent.length, 3, "the fourth never reaches the mailer");
});

test("signup counts stay out of the administrator's failed sign-in list", async () => {
  const { recentFailures } = await import("../src/lib/throttle.ts");
  await signup.startSignup(FIELDS, "198.51.100.10", collect);
  assert.ok(
    !recentFailures().some((row) => row.identifier.startsWith("signup:")),
    "they are not failed sign-ins and must not be shown as some",
  );
});
