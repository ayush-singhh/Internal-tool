import { handleWebhookRequest } from "@/lib/subscription";

/**
 * Stripe's webhook.
 *
 * AI Rules §5 reserves `src/app/api/` for file downloads, and this is the one documented
 * exception: a webhook is an unauthenticated POST from somebody else's servers,
 * authenticated by an HMAC over its body — which is precisely what a Server Action is
 * not. The rule's intent is untouched: our own mutations still go through Server Actions.
 *
 * All of the logic is in `subscription.ts`, so this file has nothing to test.
 */
export const POST = (request: Request) => handleWebhookRequest(request);
