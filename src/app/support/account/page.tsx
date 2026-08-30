import type { Metadata } from "next";
import QRCode from "qrcode";
import { requireSupport } from "@/lib/auth";
import { mfaState } from "@/lib/mfa";
import { Card, CardHeader } from "@/components/ui";
import { MfaCard } from "@/components/mfa-card";

export const metadata: Metadata = { title: "Support account", robots: { index: false } };

export default async function SupportAccountPage() {
  // The one page that opens without a second factor — it is where one is enrolled.
  const user = await requireSupport(false);
  const mfa = mfaState(user.id);
  const qrUri = mfa.otpauth ? await QRCode.toDataURL(mfa.otpauth, { margin: 1, width: 336 }) : null;

  return (
    <div className="max-w-2xl space-y-5">
      {!mfa.active && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-900">
          Support access needs a second factor. Nothing else here opens until this is on —
          a password alone is not enough to look inside somebody else&rsquo;s company.
        </p>
      )}
      <Card>
        <CardHeader
          title="Two-factor authentication"
          subtitle="Required for platform support accounts."
        />
        <MfaCard state={mfa} qrUri={qrUri} />
      </Card>
    </div>
  );
}
