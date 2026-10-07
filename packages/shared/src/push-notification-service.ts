/**
 * Push Notification Service
 * Handles Expo push notifications and SMS reminders
 *
 * Integrates with:
 * - Expo Push Notifications API
 * - SMS Gateway for SMS reminders
 */

export interface PushNotificationPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface ExpoPushToken {
  token: string;
  deviceType: "ios" | "android" | "web";
  deviceName?: string;
}

export interface PushNotificationResponse {
  success: boolean;
  ticketId?: string;
  error?: string;
}

export class PushNotificationService {
  private expoApiUrl = "https://exp.host/--/api/v2/push/send";

  /**
   * Send push notification via Expo
   */
  async sendPushNotification(
    deviceToken: string,
    payload: PushNotificationPayload
  ): Promise<PushNotificationResponse> {
    try {
      if (!this.isValidExpoToken(deviceToken)) {
        return { success: false, error: "Invalid Expo token" };
      }

      // TODO: Implement actual Expo API call
      // const response = await fetch(this.expoApiUrl, {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify({
      //     to: deviceToken,
      //     sound: 'default',
      //     title: payload.title,
      //     body: payload.body,
      //     data: payload.data,
      //   }),
      // });

      // Mock response for development
      const ticketId = `ticket_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      console.log(`[PUSH-STUB] Sent to ${deviceToken}: ${payload.title}`);

      return {
        success: true,
        ticketId,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Send batch push notifications
   */
  async sendBatchPushNotifications(
    deviceTokens: string[],
    payload: PushNotificationPayload
  ): Promise<PushNotificationResponse[]> {
    return Promise.all(
      deviceTokens.map((token) => this.sendPushNotification(token, payload))
    );
  }

  /**
   * Send appointment reminder notification
   */
  async sendAppointmentReminder(
    deviceToken: string,
    patientName: string,
    doctorName: string,
    appointmentTime: Date
  ): Promise<PushNotificationResponse> {
    const formattedTime = appointmentTime.toLocaleString("tr-TR", {
      hour: "2-digit",
      minute: "2-digit",
    });

    return this.sendPushNotification(deviceToken, {
      title: "Randevu Hatırlatması",
      body: `Merhaba ${patientName}, bugün ${formattedTime}'de ${doctorName} ile randevunuz var`,
      data: {
        appointmentTime: appointmentTime.toISOString(),
        doctor: doctorName,
      },
    });
  }

  /**
   * Send appointment cancellation notification
   */
  async sendCancellationNotification(
    deviceToken: string,
    patientName: string,
    doctorName: string
  ): Promise<PushNotificationResponse> {
    return this.sendPushNotification(deviceToken, {
      title: "Randevu İptal Bildirimi",
      body: `Merhaba ${patientName}, ${doctorName} ile olan randevunuz iptal edilmiştir`,
      data: {
        type: "cancellation",
      },
    });
  }

  /**
   * Validate Expo push token format
   */
  private isValidExpoToken(token: string): boolean {
    return (
      token.startsWith("ExponentPushToken[") &&
      token.endsWith("]")
    );
  }
}

export function createPushNotificationService(): PushNotificationService {
  return new PushNotificationService();
}
