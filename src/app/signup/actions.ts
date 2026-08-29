"use server";

import { headers } from "next/headers";
import { mailer } from "@/lib/mailer";
import { startSignup } from "@/lib/signup";
import type { FieldErrors } from "@/lib/validate";

export type SignupState = { errors?: FieldErrors; sent?: boolean };

export async function signupAction(
  _prev: SignupState,
  formData: FormData,
): Promise<SignupState> {
  const h = await headers();
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 64) ||
    h.get("x-real-ip")?.slice(0, 64) ||
    null;

  const result = await startSignup(
    {
      orgName: formData.get("orgName"),
      ownerName: formData.get("ownerName"),
      email: formData.get("email"),
      password: formData.get("password"),
      confirm: formData.get("confirm"),
    },
    ip,
    mailer(),
  );

  if (!result.ok) return { errors: result.errors };
  // The same screen whether an organisation was created, a link was sent again, or
  // nothing happened at all — the form must not answer "is this company a customer?".
  return { sent: true };
}
