"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { lookupUsdot, type CarrierRecord } from "@/lib/fmcsa";
import { sender } from "@/lib/sms";
import { issueCode, verifyCode } from "@/lib/applicant-otp";
import { openApplication } from "@/lib/applications";
import { openApplicantSession } from "@/lib/applicant-auth";
import { portalFor } from "@/lib/portal";
import { OTP_RULE, checkBurst, describeLockout, recordBurst } from "@/lib/throttle";
import { digitsOnly, email as emailField, phone as phoneField, required } from "@/lib/validate";
import type { FieldErrors } from "@/lib/validate";

/**
 * The public onboarding portal's server actions.
 *
 * Everything here runs for an unauthenticated stranger, so every one of them re-resolves
 * the portal from the slug and refuses if it is closed. None of them trusts an
 * organisation id from the form.
 */

/** What a carrier has told us before it has proved its phone number.
 *
 *  Held in an httpOnly cookie rather than a database row, because a row here would be an
 *  unverified application: spam-creatable, and occupying the one-open-application-per-USDOT
 *  slot that a real carrier needs.
 *
 *  Deliberately **not signed**, and that is safe for a specific reason: every field in it
 *  is something the applicant types anyway, so forging one gains nothing. The only claim
 *  that must not be forgeable is "this phone number was verified", and that is not stored
 *  here at all — `verifyCode` checks the submitted code against a row keyed on the phone
 *  number, so editing the phone in this cookie merely looks up an OTP that was never
 *  issued, and fails. */
const PENDING = "ch_apply_pending";
const PENDING_MINUTES = 30;

type Pending = {
  usdot: string;
  legalName: string;
  dbaName: string | null;
  state: string | null;
  allowedToOperate: boolean | null;
  nameSource: "fmcsa" | "manual";
  phone: string;
  phoneDigits: string;
  email: string;
};

async function readPending(): Promise<Pending | null> {
  const raw = (await cookies()).get(PENDING)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Pending;
  } catch {
    return null;
  }
}

async function writePending(pending: Pending): Promise<void> {
  (await cookies()).set(PENDING, JSON.stringify(pending), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(Date.now() + PENDING_MINUTES * 60_000),
  });
}

async function clientIp(): Promise<string | null> {
  const h = await headers();
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 64) ||
    h.get("x-real-ip")?.slice(0, 64) ||
    null
  );
}

/* ---------------------------------------------------------------- step 1: who are you */

export type LookupState = {
  errors?: FieldErrors;
  usdot?: string;
  carrier?: CarrierRecord;
  /** The lookup could not answer, so the carrier types its own name. */
  manual?: boolean;
  reason?: string;
};

export async function lookupAction(_prev: LookupState, formData: FormData): Promise<LookupState> {
  const slug = String(formData.get("slug") ?? "");
  if (!portalFor(slug)) return { errors: { form: "This onboarding portal is not available." } };

  const errors: FieldErrors = {};
  const usdot = digitsOnly(formData.get("usdot"), "usdot", "USDOT number", errors, 8);
  if (!usdot) {
    errors.usdot ??= "Enter your USDOT number.";
    return { errors };
  }

  const result = await lookupUsdot(usdot);
  if (result.ok) return { usdot, carrier: result.carrier };

  // Every failure lands the carrier on the same screen, typing its own name. Onboarding
  // must not stop because a government API is down.
  const reason =
    result.reason === "not_found"
      ? "We could not find that USDOT number in the FMCSA register. Check it, or carry on and tell us your company name."
      : "We could not reach the FMCSA register just now. Tell us your company name and we will confirm it later.";
  return { usdot, manual: true, reason };
}

/* ------------------------------------------------- step 2: contact, and send the code */

export type StartState = { errors?: FieldErrors };

export async function startAction(_prev: StartState, formData: FormData): Promise<StartState> {
  const slug = String(formData.get("slug") ?? "");
  const portal = portalFor(slug);
  if (!portal) return { errors: { form: "This onboarding portal is not available." } };

  const errors: FieldErrors = {};
  const usdot = digitsOnly(formData.get("usdot"), "usdot", "USDOT number", errors, 8);
  const legalName = required(formData.get("legalName"), "legalName", "Company name", errors);
  const { value: phone, digits } = phoneField(formData.get("phone"), "phone", errors);
  const email = emailField(formData.get("email"), "email", errors);
  if (!phone || !digits) errors.phone ??= "Enter the mobile number we should text.";
  if (!email) errors.email ??= "Enter an email address.";

  if (!usdot || !legalName || !phone || !digits || !email || Object.keys(errors).length > 0) {
    return { errors };
  }

  // Per number and per host: a text costs money and arrives in somebody's pocket.
  const perPhone = checkBurst(`otp:${digits}`, OTP_RULE.phone, "email");
  if (!perPhone.allowed) return { errors: { form: describeLockout(perPhone) } };
  const ip = await clientIp();
  if (ip) {
    const perIp = checkBurst(`otp-ip:${ip}`, OTP_RULE.ip);
    if (!perIp.allowed) return { errors: { form: describeLockout(perIp) } };
  }
  recordBurst(`otp:${digits}`);
  if (ip) recordBurst(`otp-ip:${ip}`);

  const nameSource = formData.get("nameSource") === "fmcsa" ? "fmcsa" : "manual";
  const rawAllowed = formData.get("allowedToOperate");

  await writePending({
    usdot,
    legalName,
    dbaName: (formData.get("dbaName") as string)?.trim() || null,
    state: (formData.get("state") as string)?.trim() || null,
    allowedToOperate: rawAllowed === null ? null : rawAllowed === "1",
    nameSource,
    phone,
    phoneDigits: digits,
    email,
  });

  const code = issueCode(portal.org.id, digits);
  try {
    await sender()({
      to: phone,
      body: `${code} is your verification code for ${portal.orgName}. It expires in 10 minutes.`,
    });
  } catch {
    // The code is already issued and the pending details are saved; the carrier can ask
    // for a new one on the next screen. Saying more would expose our carrier's problems.
    return { errors: { form: "We could not send the code. Check the number and try again." } };
  }

  redirect(`/apply/${slug}/verify`);
}

/* --------------------------------------------------------- step 3: prove the number */

export type VerifyState = { errors?: FieldErrors; resent?: boolean };

export async function verifyAction(_prev: VerifyState, formData: FormData): Promise<VerifyState> {
  const slug = String(formData.get("slug") ?? "");
  const portal = portalFor(slug);
  if (!portal) return { errors: { form: "This onboarding portal is not available." } };

  const pending = await readPending();
  if (!pending) return { errors: { form: "That took too long. Start again from the beginning." } };

  const code = String(formData.get("code") ?? "").replace(/\D/g, "");
  if (code.length !== 6) return { errors: { code: "Enter the six-digit code." } };

  const verdict = verifyCode(portal.org.id, pending.phoneDigits, code);
  if (!verdict.ok) {
    return {
      errors: {
        code:
          verdict.reason === "incorrect"
            ? "That code is not right."
            : "That code has expired or has already been used. Ask for a new one.",
      },
    };
  }

  const opened = openApplication(portal.org, {
    usdot: pending.usdot,
    legal_name: pending.legalName,
    dba_name: pending.dbaName,
    operating_state: pending.state,
    allowed_to_operate: pending.allowedToOperate,
    name_source: pending.nameSource,
    phone: pending.phone,
    phone_digits: pending.phoneDigits,
    email: pending.email,
  });
  if (!opened.ok) return { errors: { form: opened.error } };

  await openApplicantSession(portal.org.id, opened.id);
  (await cookies()).delete(PENDING);

  redirect(`/apply/${slug}/application`);
}

export async function resendAction(_prev: VerifyState, formData: FormData): Promise<VerifyState> {
  const slug = String(formData.get("slug") ?? "");
  const portal = portalFor(slug);
  if (!portal) return { errors: { form: "This onboarding portal is not available." } };

  const pending = await readPending();
  if (!pending) return { errors: { form: "That took too long. Start again from the beginning." } };

  const perPhone = checkBurst(`otp:${pending.phoneDigits}`, OTP_RULE.phone, "email");
  if (!perPhone.allowed) return { errors: { form: describeLockout(perPhone) } };
  recordBurst(`otp:${pending.phoneDigits}`);

  const code = issueCode(portal.org.id, pending.phoneDigits);
  try {
    await sender()({
      to: pending.phone,
      body: `${code} is your verification code for ${portal.orgName}. It expires in 10 minutes.`,
    });
  } catch {
    return { errors: { form: "We could not send the code. Check the number and try again." } };
  }
  return { resent: true };
}
