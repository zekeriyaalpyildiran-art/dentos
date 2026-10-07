import type { APIRoute } from "astro";
import { SMSWebhookHandler, type SMSWebhookPayload } from "@dentos/api/webhooks/sms-webhook";

/**
 * POST /api/webhooks/sms
 * Receives incoming SMS messages from Netgsm
 *
 * Webhook from Netgsm service:
 * - Forwards user SMS to this endpoint
 * - Supports: cancellation, rescheduling, queries
 */
export const POST: APIRoute = async ({ request }) => {
  try {
    // Verify request is from Netgsm
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !isValidNetgsmSignature(authHeader)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const payload: SMSWebhookPayload = await request.json();

    // Validate payload
    if (!payload.from || !payload.message || !payload.clinicId) {
      return new Response("Invalid payload", { status: 400 });
    }

    // Process SMS
    const response = await SMSWebhookHandler.handleIncomingSMS(payload);

    console.log(`[SMS-API] Processed webhook: ${response.action}`);

    return new Response(
      JSON.stringify({
        success: response.success,
        action: response.action,
        reply: response.reply || null,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("[SMS-API] Error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
};

/**
 * Verify Netgsm webhook signature
 * In production, verify HMAC signature from Netgsm
 */
function isValidNetgsmSignature(authHeader: string): boolean {
  // TODO: Verify HMAC signature
  // const signature = authHeader.replace("Bearer ", "");
  // const expectedSignature = hmac("sha256", NETGSM_SECRET, payload);
  // return signature === expectedSignature;

  // Mock validation for development
  console.log("[SMS-API] Webhook signature validation (stub)");
  return authHeader.startsWith("Bearer ");
}
