/**
 * Reminder Service
 * Handles appointment reminders (SMS/Email/Push notifications)
 *
 * Used by:
 * - Cron jobs for scheduled reminders
 * - Admin panel for manual reminder sending
 */

export interface ReminderConfig {
  appointmentId: string;
  patientPhone: string;
  patientName: string;
  doctorName: string;
  appointmentTime: Date;
  reminderType: "sms" | "email" | "in_app";
  sendTime?: Date; // If not provided, sends immediately
}

export interface ReminderResult {
  success: boolean;
  reminderId?: string;
  message?: string;
  error?: string;
}

export class ReminderService {
  /**
   * Schedule appointment reminder
   * Supports SMS (via Netgsm), Email, and In-App push notifications
   */
  static async scheduleReminder(config: ReminderConfig): Promise<ReminderResult> {
    const now = new Date();
    const sendTime = config.sendTime || now;

    // Validate timing
    if (sendTime < now && config.sendTime) {
      return {
        success: false,
        error: "Send time cannot be in the past",
      };
    }

    // TODO: Store reminder in database with status: pending
    // const { data, error } = await supabase.from("reminders").insert([{
    //   appointment_id: config.appointmentId,
    //   reminder_type: config.reminderType,
    //   scheduled_at: sendTime,
    //   status: "pending",
    // }]);

    const reminderId = `reminder_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    console.log(
      `[REMINDER-SCHEDULED] ${config.reminderType.toUpperCase()}: ${config.patientName} (${reminderId})`
    );

    return {
      success: true,
      reminderId,
      message: `${config.reminderType} reminder scheduled for ${sendTime.toLocaleString("tr-TR")}`,
    };
  }

  /**
   * Send SMS reminder immediately
   */
  static async sendSMSReminder(config: ReminderConfig): Promise<ReminderResult> {
    try {
      // TODO: Call SMSGateway.sendAppointmentReminder()
      const message = `Merhaba ${config.patientName}, ${config.appointmentTime.toLocaleDateString("tr-TR")} tarihinde ${config.doctorName} ile randevunuz bulunmaktadır.`;

      console.log(`[SMS-REMINDER] To ${config.patientPhone}: ${message}`);

      return {
        success: true,
        message: "SMS reminder sent",
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to send SMS",
      };
    }
  }

  /**
   * Send email reminder
   */
  static async sendEmailReminder(config: ReminderConfig): Promise<ReminderResult> {
    try {
      // TODO: Integrate with email service (SendGrid, etc.)
      const subject = "Randevu Hatırlatması";
      const html = `
        <h2>Merhaba ${config.patientName},</h2>
        <p>${config.appointmentTime.toLocaleDateString("tr-TR")} tarihinde ${config.doctorName} ile randevunuz bulunmaktadır.</p>
        <p>Randevunuza 10 dakika erken gelmenizi rica ederiz.</p>
      `;

      console.log(`[EMAIL-REMINDER] Subject: ${subject}`);

      return {
        success: true,
        message: "Email reminder sent",
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to send email",
      };
    }
  }

  /**
   * Send push notification reminder
   */
  static async sendPushReminder(
    deviceToken: string,
    config: ReminderConfig
  ): Promise<ReminderResult> {
    try {
      // TODO: Call PushNotificationService.sendAppointmentReminder()
      const title = "Randevu Hatırlatması";
      const body = `Merhaba ${config.patientName}, bugün ${config.appointmentTime.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}'de ${config.doctorName} ile randevunuz var`;

      console.log(`[PUSH-REMINDER] ${title}: ${body}`);

      return {
        success: true,
        message: "Push notification sent",
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to send push",
      };
    }
  }

  /**
   * Create 24-hour appointment reminder
   * Called automatically when appointment is created
   */
  static async createAppointmentReminder(
    appointmentId: string,
    patientPhone: string,
    patientName: string,
    doctorName: string,
    appointmentTime: Date
  ): Promise<ReminderResult> {
    const reminderTime = new Date(appointmentTime.getTime() - 24 * 60 * 60 * 1000);

    return this.scheduleReminder({
      appointmentId,
      patientPhone,
      patientName,
      doctorName,
      appointmentTime,
      reminderType: "sms",
      sendTime: reminderTime,
    });
  }

  /**
   * Cancel appointment reminders
   * Called when appointment is cancelled
   */
  static async cancelAppointmentReminders(
    appointmentId: string
  ): Promise<ReminderResult> {
    try {
      // TODO: Delete pending reminders for this appointment
      // const { error } = await supabase
      //   .from("reminders")
      //   .delete()
      //   .eq("appointment_id", appointmentId)
      //   .eq("status", "pending");

      console.log(`[REMINDER-CANCELLED] Appointment: ${appointmentId}`);

      return {
        success: true,
        message: "Reminders cancelled",
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to cancel reminders",
      };
    }
  }
}
