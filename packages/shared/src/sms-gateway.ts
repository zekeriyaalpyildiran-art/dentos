/**
 * SMS Gateway Integration
 * Stub for Netgsm SMS service
 *
 * Production: Replace with actual Netgsm API calls
 * Test: Mock responses for development
 */

export interface SMSConfig {
  apiKey: string;
  sender: string;
  username?: string;
  password?: string;
}

export interface SMSPayload {
  phone: string;
  message: string;
  appointmentId?: string;
}

export interface SMSResponse {
  success: boolean;
  messageId?: string;
  error?: string;
  retryable?: boolean;
}

export class SMSGateway {
  private apiKey: string;
  private sender: string;
  private baseUrl = "https://api.netgsm.com.tr"; // Production endpoint

  constructor(config: SMSConfig) {
    this.apiKey = config.apiKey;
    this.sender = config.sender;
  }

  /**
   * Send SMS via Netgsm
   * Stub implementation - ready for production API
   */
  async send(payload: SMSPayload): Promise<SMSResponse> {
    try {
      // Validate phone number (Turkish format)
      if (!this.isValidPhone(payload.phone)) {
        return { success: false, error: "Invalid phone number" };
      }

      // TODO: Implement actual Netgsm API call
      // const response = await fetch(`${this.baseUrl}/sms/send`, {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify({
      //     usercode: this.apiKey,
      //     msgheader: this.sender,
      //     message: payload.message,
      //     gsm: payload.phone,
      //   }),
      // });

      // Mock response for development
      const mockMessageId = `sms_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      console.log(`[SMS-STUB] Sent to ${payload.phone}: ${payload.message}`);

      return {
        success: true,
        messageId: mockMessageId,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        retryable: true,
      };
    }
  }

  /**
   * Send appointment reminder SMS
   */
  async sendAppointmentReminder(
    phone: string,
    patientName: string,
    appointmentTime: Date,
    doctorName: string
  ): Promise<SMSResponse> {
    const formattedTime = appointmentTime.toLocaleString("tr-TR");
    const message = `Merhaba ${patientName}, ${appointmentTime.toLocaleDateString("tr-TR")} tarihinde ${doctorName} ile randevunuz bulunmaktadır. Yanınızda kimlik ve gerekli belgelerinizi getirmeyi unutmayınız.`;

    return this.send({
      phone,
      message,
    });
  }

  /**
   * Send cancellation SMS
   */
  async sendCancellationNotice(phone: string, patientName: string): Promise<SMSResponse> {
    const message = `Merhaba ${patientName}, randevunuz iptal edilmiştir. Lütfen yeni bir randevu almak için klinigi arayınız.`;

    return this.send({
      phone,
      message,
    });
  }

  /**
   * Validate Turkish phone number
   */
  private isValidPhone(phone: string): boolean {
    // Accept formats: 90XXXXXXXXXX, +90XXXXXXXXXX, 5XXXXXXXXXX
    const cleaned = phone.replace(/\D/g, "");
    return cleaned.length === 12 && (cleaned.startsWith("90") || cleaned.startsWith("5"));
  }
}

// Factory for DI
export function createSMSGateway(config: SMSConfig): SMSGateway {
  return new SMSGateway(config);
}
