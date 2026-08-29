import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { converse } from "../src/lib/mailer.ts";

/**
 * The SMTP client, run end to end against a server that answers with canned replies and
 * records what it was told. This is the part of the mailer with states in it — the TLS
 * wrapper around it is four lines and is not what breaks.
 */
type Fake = { received: string[]; port: number; close: () => void };

/** Answers each command with the next reply in the script. */
function fakeServer(script: string[]): Promise<Fake> {
  const received: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((socket: Socket) => {
      const queue = [...script];
      let inData = false;
      let body = "";
      socket.setEncoding("utf8");
      socket.write("220 fake.test ESMTP ready\r\n");
      socket.on("data", (chunk: string) => {
        if (inData) {
          body += chunk;
          if (!body.includes("\r\n.\r\n")) return;
          received.push(`DATA-BODY ${body.slice(0, body.indexOf("\r\n.\r\n"))}`);
          inData = false;
          socket.write(`${queue.shift() ?? "250 ok"}\r\n`);
          return;
        }
        for (const line of chunk.split("\r\n").filter(Boolean)) {
          received.push(line);
          if (line.startsWith("QUIT")) {
            socket.end("221 bye\r\n");
            return;
          }
          const reply = queue.shift() ?? "250 ok";
          socket.write(`${reply}\r\n`);
          if (reply.startsWith("354")) inData = true;
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ received, port, close: () => server.close() });
    });
  });
}

const HAPPY = [
  "250-fake.test\r\n250 AUTH PLAIN", // EHLO, multi-line as a real server answers
  "235 authenticated",
  "250 sender ok",
  "250 recipient ok",
  "354 go ahead",
  "250 queued as ABC123",
];

const MAIL = { to: "dana@x.test", subject: "Confirm your email address", text: "the link\n" };

/** Always closes the server, including when the conversation throws — a listening socket
 *  left behind keeps `node --test` alive forever. */
async function run(script: string[], url: string): Promise<Fake> {
  const fake = await fakeServer(script);
  const socket = connect(fake.port, "127.0.0.1");
  await new Promise((r) => socket.once("connect", r));
  try {
    await converse(socket, new URL(url.replace("PORT", String(fake.port))), "hub@x.test", MAIL);
    // converse ends the socket after QUIT; wait for the server to have read it, but never
    // longer than a moment, so a client bug shows up as a failure rather than a hang.
    await Promise.race([new Promise((r) => socket.once("close", r)), delay(1000)]);
  } finally {
    socket.destroy();
    fake.close();
  }
  return fake;
}

test("the whole conversation runs in order and the message is delivered", async () => {
  const fake = await run(HAPPY, "smtps://user:pa%3Ass@127.0.0.1:PORT");

  const [ehlo, auth, from, rcpt, data, body] = fake.received;
  assert.match(ehlo!, /^EHLO 127\.0\.0\.1$/);
  assert.match(auth!, /^AUTH PLAIN /);
  assert.equal(
    Buffer.from(auth!.slice("AUTH PLAIN ".length), "base64").toString("utf8"),
    "\0user\0pa:ss",
    "credentials are percent-decoded out of the URL before they are encoded",
  );
  assert.equal(from, "MAIL FROM:<hub@x.test>");
  assert.equal(rcpt, "RCPT TO:<dana@x.test>");
  assert.equal(data, "DATA");
  assert.match(body!, /Subject: Confirm your email address/);
  assert.match(body!, /Content-Transfer-Encoding: base64/);
  assert.equal(fake.received.at(-1), "QUIT");
});

test("a multi-line reply is read as one reply, not several", async () => {
  // The EHLO answer above is two lines; if they were read separately every later step
  // would be checking the wrong reply, and the failure would look like a random 250.
  const fake = await run(HAPPY, "smtps://user:pass@127.0.0.1:PORT");
  assert.equal(fake.received.filter((line) => line.startsWith("MAIL FROM")).length, 1);
});

test("a relay that refuses the credentials fails loudly, without echoing them", async () => {
  await assert.rejects(
    run(["250 fake.test", "535 authentication failed"], "smtps://user:hunter2@127.0.0.1:PORT"),
    (error: Error) => {
      assert.match(error.message, /credentials in SMTP_URL/);
      assert.ok(!error.message.includes("hunter2"), "the password is never in the error");
      return true;
    },
  );
});

test("a rejected recipient is reported with the server's reason", async () => {
  await assert.rejects(
    run(["250 fake.test", "235 ok", "250 ok", "550 no such mailbox"], "smtps://u:p@127.0.0.1:PORT"),
    /recipient address: 550 no such mailbox/,
  );
});

test("no credentials in the URL means no AUTH command", async () => {
  const fake = await run(
    ["250 fake.test", "250 sender ok", "250 recipient ok", "354 go ahead", "250 queued"],
    "smtps://127.0.0.1:PORT",
  );
  assert.ok(!fake.received.some((line) => line.startsWith("AUTH")));
  assert.equal(fake.received[1], "MAIL FROM:<hub@x.test>");
});
