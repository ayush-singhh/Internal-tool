import { createHash, createHmac } from "node:crypto";

/**
 * Just enough AWS Signature Version 4 to put one object somewhere.
 *
 * ponytail: ~60 lines of `node:crypto` rather than the AWS SDK, which is tens of
 * megabytes to make one PUT. SigV4 is a chain of HMACs over a canonical string, frozen
 * since 2012, and AWS publishes test vectors — which the tests assert against, so this is
 * checked rather than hoped at.
 *
 * Signing against the S3 API rather than any one provider's own means the same code puts
 * backups in Cloudflare R2, Backblaze B2, Wasabi, MinIO or AWS. Which one is a decision
 * for whoever holds the account, not a rewrite.
 */
const ALGORITHM = "AWS4-HMAC-SHA256";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) =>
  createHmac("sha256", key).update(data, "utf8").digest();

/** `20150830T123600Z` and `20150830`, the two forms every part of the signature wants. */
function stamps(now: Date): { amzDate: string; date: string } {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate, date: amzDate.slice(0, 8) };
}

/** Each path segment is encoded, but the separators are not. */
function canonicalPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) =>
      `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

export type Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
};

/**
 * The headers a signed request needs, including Authorization. Deterministic given
 * `now`, which is what makes it testable.
 */
export function signRequest(
  method: string,
  url: URL,
  payload: Buffer,
  credentials: Credentials,
  now: Date,
  /** Everything else to sign. `host` and `x-amz-date` are always added; anything a
   *  particular API requires — S3 wants `x-amz-content-sha256` — is the caller's to pass,
   *  so this stays the generic algorithm and can be checked against AWS's own vectors. */
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  const service = credentials.service ?? "s3";
  const { amzDate, date } = stamps(now);
  const payloadHash = sha256(payload);

  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-date": amzDate,
    ...extraHeaders,
  };

  // Signed headers are sorted by lowercased name; values have their whitespace collapsed.
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${String(headers[name] ?? "").trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = names.join(";");

  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = [
    method,
    canonicalPath(url.pathname),
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${date}/${credentials.region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256(canonicalRequest)].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, date), credentials.region), service),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return {
    ...headers,
    Authorization:
      `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * Where backups go, as one URL so there is a single thing to set:
 *   https://KEY:SECRET@<account>.r2.cloudflarestorage.com/<bucket>
 * Credentials are percent-decoded, exactly as `SMTP_URL` handles them.
 */
export type Destination = { base: URL; credentials: Credentials };

export function destination(raw: string, region = process.env.BACKUP_S3_REGION ?? "auto"): Destination {
  const url = new URL(raw);
  if (!url.username || !url.password) {
    throw new Error("BACKUP_S3_URL needs credentials: https://KEY:SECRET@endpoint/bucket");
  }
  const credentials: Credentials = {
    accessKeyId: decodeURIComponent(url.username),
    secretAccessKey: decodeURIComponent(url.password),
    region,
  };
  // The credentials must not travel in the URL itself.
  const base = new URL(url.toString());
  base.username = "";
  base.password = "";
  return { base, credentials };
}

/** Uploads one object. Throws with the provider's own words when it refuses. */
export async function putObject(
  dest: Destination,
  key: string,
  body: Buffer,
  now = new Date(),
): Promise<string> {
  const url = new URL(`${dest.base.pathname.replace(/\/+$/, "")}/${key}`, dest.base);
  const headers = signRequest("PUT", url, body, dest.credentials, now, {
    // S3 requires the payload hash as a header as well as in the signature.
    "x-amz-content-sha256": sha256(body),
    "content-type": "application/octet-stream",
    "content-length": String(body.byteLength),
  });

  const response = await fetch(url, { method: "PUT", headers, body: new Uint8Array(body) });
  if (!response.ok) {
    throw new Error(
      `Upload of ${key} was refused (${response.status}): ${(await response.text()).slice(0, 300)}`,
    );
  }
  return url.toString();
}
