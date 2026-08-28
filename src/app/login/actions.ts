"use server";

import { redirect } from "next/navigation";
import { completeSecondFactor, signIn } from "@/lib/auth";

export type LoginState = { error?: string };

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };

  const result = await signIn(email, password);
  if (!result.ok) return { error: result.error };
  // The same page renders the code prompt once a pending session exists.
  redirect(result.mfaRequired ? "/login" : "/");
}

export async function verifyCodeAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const code = String(formData.get("code") ?? "").trim();
  if (!code) return { error: "Enter the code from your authenticator app." };

  const result = await completeSecondFactor(code);
  if (!result.ok) return { error: result.error };
  redirect("/");
}
