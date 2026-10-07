/**
 * SMS Webhook Handler
 * Receives incoming SMS from Netgsm and processes them
 *
 * Scenarios:
 * - Appointment cancellation requests
 * - Rescheduling requests
 * - Information queries
 */

export interface SMSWebhookPayload {
  from: string; // Phone number
  message: string;
  timestamp: string;
  messageId: string;
  clinicId: string;
}

export interface SMSWebhookResponse {
  success: boolean;
  action: string;
  reply?: string;
  error?: string;
}

export class SMSWebhookHandler {
  /**
   * Handle incoming SMS webhook
   */
  static async handleIncomingSMS(
    payload: SMSWebhookPayload
  ): Promise<SMSWebhookResponse> {
    try {
      const { from, message, clinicId } = payload;

      // Parse message content
      const intent = this.parseIntent(message);

      console.log(
        `[SMS-WEBHOOK] Incoming from ${from}: "${message}" (intent: ${intent})`
      );

      switch (intent) {
        case "cancel":
          return await this.handleCancellation(from, clinicId);
        case "reschedule":
          return await this.handleReschedule(from, clinicId);
        case "info":
          return await this.handleInfoQuery(from, clinicId);
        default:
          return await this.handleDefault(from, clinicId);
      }
    } catch (error) {
      console.error("[SMS-WEBHOOK] Error:", error);
      return {
        success: false,
        action: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Parse SMS intent
   */
  private static parseIntent(message: string): string {
    const lower = message.toLowerCase().trim();

    if (lower.includes("iptal") || lower.includes("cancel")) {
      return "cancel";
    }
    if (lower.includes("ertele") || lower.includes("reschedule")) {
      return "reschedule";
    }
    if (lower.includes("bilgi") || lower.includes("info")) {
      return "info";
    }

    return "default";
  }

  /**
   * Handle cancellation request
   */
  private static async handleCancellation(
    phoneNumber: string,
    clinicId: string
  ): Promise<SMSWebhookResponse> {
    try {
      // TODO: Query patient's next appointment
      // const appointment = await queryNextAppointment(phoneNumber, clinicId);

      // if (!appointment) {
      //   return this.sendSMSReply(phoneNumber, "Iptal edilecek randevunuz bulunamadı");
      // }

      // TODO: Cancel appointment
      // await cancelAppointment(appointment.id);

      console.log(
        `[SMS-WEBHOOK] Cancellation processed for ${phoneNumber}`
      );

      return {
        success: true,
        action: "cancel",
        reply: "Randevunuz iptal edilmiştir. Yeni bir randevu almak için uygulamayı ziyaret edin.",
      };
    } catch (error) {
      return {
        success: false,
        action: "cancel",
        error: error instanceof Error ? error.message : "Cancellation failed",
      };
    }
  }

  /**
   * Handle reschedule request
   */
  private static async handleReschedule(
    phoneNumber: string,
    clinicId: string
  ): Promise<SMSWebhookResponse> {
    try {
      // TODO: Query patient's next appointment
      // TODO: Find available slots
      // TODO: Send reschedule options

      console.log(
        `[SMS-WEBHOOK] Reschedule requested for ${phoneNumber}`
      );

      return {
        success: true,
        action: "reschedule",
        reply: "Randevunuzu değiştirmek için lütfen uygulamayı ziyaret edin",
      };
    } catch (error) {
      return {
        success: false,
        action: "reschedule",
        error: error instanceof Error ? error.message : "Reschedule failed",
      };
    }
  }

  /**
   * Handle information query
   */
  private static async handleInfoQuery(
    phoneNumber: string,
    clinicId: string
  ): Promise<SMSWebhookResponse> {
    try {
      // TODO: Query clinic information
      // const clinic = await queryClinic(clinicId);

      const info = `Klinik Bilgisi:\nAdres: İstanbul\nTelefon: 0212 XXX XXXX\nWeb: dentos.example.com`;

      console.log(`[SMS-WEBHOOK] Info query from ${phoneNumber}`);

      return {
        success: true,
        action: "info",
        reply: info,
      };
    } catch (error) {
      return {
        success: false,
        action: "info",
        error: error instanceof Error ? error.message : "Info query failed",
      };
    }
  }

  /**
   * Handle default message
   */
  private static async handleDefault(
    phoneNumber: string,
    clinicId: string
  ): Promise<SMSWebhookResponse> {
    console.log(`[SMS-WEBHOOK] Unknown intent from ${phoneNumber}`);

    return {
      success: true,
      action: "default",
      reply: "Merhaba! Randevu almak için uygulamayı indirin veya 0212 XXX XXXX numarası arayınız.",
    };
  }

  /**
   * Send SMS reply (stub for production Netgsm integration)
   */
  private static async sendSMSReply(
    phoneNumber: string,
    message: string
  ): Promise<boolean> {
    try {
      // TODO: Call SMSGateway.send()
      console.log(`[SMS-REPLY] To ${phoneNumber}: ${message}`);
      return true;
    } catch (error) {
      console.error("[SMS-REPLY] Error:", error);
      return false;
    }
  }
}
