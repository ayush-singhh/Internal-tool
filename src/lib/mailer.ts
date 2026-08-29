import "server-only";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { connect } from "node:tls";

/**
 * Outbound mail.
 *
 * ponytail: ~100 lines of `node:tls` instead of nodemailer. The app sends two kinds of
 * message, both plain text, to one relay. SMTP's happy path is eight commands, and the
 * dependency it replaces pulls in a mail parser, DKIM signing and OAuth we would never
 * call. Ceiling: implicit TLS on 465 only, AUTH PLAIN only, one recipient, no attachments
 * — every provider we would use (SES, Postmark, Mailgun, SendGrid) offers 465. If one
 * ever needs STARTTLS on 587, that is the upgrade, not a package.
 *
 * There are two real implementations: the relay where one is configured, and the log
 * where it is not, so local development can read the link it would have sent. Production
 * refuses to start without a relay (see `src/instrumentation.ts`) — a SaaS that silently
 * drops its verification mail is a SaaS nobody can sign up to.
 */
export type Mail = { to: string; subject: string; text: string };
export type Mailer = (mail: Mail) => Promise<void>;

const TIMEOUT_MS = 15_000;

/** Anything reaching a header must not be able to add one. */
function headerSafe(value: string, what: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`Refusing to send: ${what} contains a line break.`);
  return value;
}

/** Base64 body, wrapped at 76 columns: no line-length limit to trip over, and no line
 *  can begin with a dot, so SMTP's dot-stuffing rule cannot bite. */
function base64Body(text: string): string {
  return (Buffer.from(text, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
}

export function buildMessage(from: string, mail: Mail, now = new Date()): string {
  const headers = [
    `From: ${headerSafe(from, "the sender")}`,
    `To: ${headerSafe(mail.to, "the recipient")}`,
    `Subject: ${headerSafe(mail.subject, "the subject")}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${randomUUID()}@${from.split("@").pop()?.replace(/>$/, "") ?? "localhost"}>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${base64Body(mail.text)}`;
}

/** The address inside a `Name <addr>` header, which is what SMTP's envelope wants. */
export function addressOf(from: string): string {
  return from.match(/<([^>]+)>/)?.[1] ?? from.trim();
}

function sendOverSmtp(url: URL, from: string, mail: Mail): Promise<void> {
  const socket = connect({
    host: url.hostname,
    port: Number(url.port || 465),
    servername: url.hostname,
  });
  return converse(socket, url, from, mail);
}

/**
 * The protocol half, over a socket someone else opened. Split out so a test can run the
 * whole conversation against a real server without a certificate — TLS is four lines and
 * boring; this is the part with the states in it.
 */
export async function converse(socket: Socket, url: URL, from: string, mail: Mail): Promise<void> {
  const message = buildMessage(from, mail);
  socket.setEncoding("utf8");
  socket.setTimeout(TIMEOUT_MS);

  // Replies arrive whole or split, and a multi-line reply ends at the first line whose
  // code is followed by a space. Queue them so one that lands early is not lost.
  const replies: string[] = [];
  let buffer = "";
  let waiting: ((reply: string) => void) | null = null;
  let failure: Error | null = null;

  const fail = (error: Error) => {
    failure = error;
    socket.destroy();
    if (waiting) {
      const w = waiting;
      waiting = null;
      w("");
    }
  };

  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const match = buffer.match(/^(?:\d{3}-[^\n]*\n)*\d{3} [^\n]*\n/);
      if (!match) break;
      replies.push(buffer.slice(0, match[0].length));
      buffer = buffer.slice(match[0].length);
      if (waiting) {
        const w = waiting;
        waiting = null;
        w(replies.shift()!);
      }
    }
  });
  socket.on("error", (e) => fail(e));
  socket.on("timeout", () => fail(new Error("The mail server did not answer in time.")));
  socket.on("close", () => {
    if (waiting) fail(new Error("The mail server closed the connection."));
  });

  const expect = async (code: string, step: string): Promise<void> => {
    const reply = replies.shift() ?? (await new Promise<string>((r) => (waiting = r)));
    if (failure) throw failure;
    if (!reply.startsWith(code)) {
      throw new Error(`Mail server refused ${step}: ${reply.trim().slice(0, 200)}`);
    }
  };
  const send = (line: string) => socket.write(`${line}\r\n`);

  try {
    await expect("220", "the connection");
    send(`EHLO ${url.hostname}`);
    await expect("250", "EHLO");

    if (url.username) {
      const secret = Buffer.from(
        `\0${decodeURIComponent(url.username)}\0${decodeURIComponent(url.password)}`,
        "utf8",
      ).toString("base64");
      send(`AUTH PLAIN ${secret}`);
      // Never include the reply here: a rejected AUTH echoes nothing useful and the
      // command itself carries the password.
      await expect("235", "the credentials in SMTP_URL");
    }

    send(`MAIL FROM:<${addressOf(from)}>`);
    await expect("250", "the sender address");
    send(`RCPT TO:<${headerSafe(mail.to, "the recipient")}>`);
    await expect("250", "the recipient address");
    send("DATA");
    await expect("354", "DATA");
    socket.write(`${message}\r\n.\r\n`);
    await expect("250", "the message");
    send("QUIT");
  } finally {
    socket.end();
  }
}

/** The configured relay, or the log in development. Throws in production when unset. */
export function mailer(): Mailer {
  const url = process.env.SMTP_URL;
  const from = process.env.MAIL_FROM;

  if (!url || !from) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SMTP_URL and MAIL_FROM must be set before this can send mail.");
    }
    return async (mail) => {
      console.log(`\n─── mail (no SMTP_URL; not sent) ───\nTo: ${mail.to}\n` +
        `Subject: ${mail.subject}\n\n${mail.text}\n────────────────────────────────────\n`);
    };
  }
  return (mail) => sendOverSmtp(new URL(url), from, mail);
}

/** The public origin, used to build links that are mailed out. Never taken from the
 *  request's Host header: a poisoned Host would send a real token to another domain. */
export function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}
