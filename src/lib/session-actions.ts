"use server";

import { redirect } from "next/navigation";
import { signOut } from "./auth.ts";

export async function signOutAction() {
  await signOut();
  redirect("/login");
}
