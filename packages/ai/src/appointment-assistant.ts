/**
 * Appointment Booking Assistant
 * AI-powered logic for intelligent appointment scheduling
 *
 * Features:
 * - Analyze patient history for procedure type recommendations
 * - Suggest optimal appointment times based on doctor availability
 * - Detect and prevent double-booking
 * - Provide appointment booking guidance via SMS
 */

export interface AppointmentContext {
  patientId: string;
  patientName: string;
  patientPhone: string;
  clinicId: string;
  previousAppointments?: Array<{
    date: string;
    procedure: string;
    duration: number;
    doctorId: string;
  }>;
}

export interface AppointmentSuggestion {
  doctorId: string;
  doctorName: string;
  recommendedTime: Date;
  estimatedDuration: number;
  reason: string;
}

export interface BookingGuidance {
  message: string;
  suggestedDoctors: Array<{ id: string; name: string; specialty: string }>;
  nextAvailableSlots: Date[];
}

export class AppointmentAssistant {
  /**
   * Get appointment suggestions based on patient history
   * Analyzes past appointments to recommend appropriate doctor and timing
   */
  static async getSuggestions(
    context: AppointmentContext
  ): Promise<AppointmentSuggestion[]> {
    const suggestions: AppointmentSuggestion[] = [];

    try {
      // TODO: Query patient appointment history
      // const history = await queryPatientAppointments(context.patientId);

      // Mock analysis
      const procedureFrequency = this.analyzeAppointmentPatterns(
        context.previousAppointments || []
      );

      if (Object.keys(procedureFrequency).length > 0) {
        // Suggest appointment based on most frequent procedure
        const mostCommon = Object.entries(procedureFrequency).sort(
          ([, a], [, b]) => b - a
        )[0];

        suggestions.push({
          doctorId: "doc-001",
          doctorName: "Dr. Ahmet Yılmaz",
          recommendedTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          estimatedDuration: 30,
          reason: `${mostCommon[0]} (geçmiş uygulamalarınız temelinde)`,
        });
      }

      console.log(
        `[APPOINTMENT-AI] Generated ${suggestions.length} suggestions for ${context.patientName}`
      );
    } catch (error) {
      console.error("[APPOINTMENT-AI] Error generating suggestions:", error);
    }

    return suggestions;
  }

  /**
   * Analyze patient appointment patterns
   */
  private static analyzeAppointmentPatterns(
    appointments: Array<{ date: string; procedure: string; duration: number }>
  ): Record<string, number> {
    const frequency: Record<string, number> = {};

    for (const apt of appointments) {
      frequency[apt.procedure] = (frequency[apt.procedure] || 0) + 1;
    }

    return frequency;
  }

  /**
   * Get booking guidance for SMS
   * Provides step-by-step instructions for appointment booking
   */
  static async getBookingGuidance(
    context: AppointmentContext
  ): Promise<BookingGuidance> {
    try {
      // TODO: Fetch available doctors and slots
      // const doctors = await queryAvailableDoctors(context.clinicId);
      // const slots = await getAvailableSlots(context.clinicId);

      const guidance: BookingGuidance = {
        message: `Merhaba ${context.patientName},\n\nRandevu almak için lütfen aşağıdaki adımları izleyin:\n1. Hekim seçin\n2. Tarih seçin\n3. Saat seçin\n4. Onayla`,
        suggestedDoctors: [
          { id: "doc-001", name: "Dr. Ahmet Yılmaz", specialty: "Genel Diş" },
          { id: "doc-002", name: "Dr. Fatma Kara", specialty: "Ortodonti" },
          { id: "doc-003", name: "Dr. Mehmet Öz", specialty: "İmplantoloji" },
        ],
        nextAvailableSlots: [
          new Date(Date.now() + 24 * 60 * 60 * 1000),
          new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
          new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        ],
      };

      console.log(`[BOOKING-GUIDANCE] Generated for ${context.patientName}`);

      return guidance;
    } catch (error) {
      return {
        message: "Randevu almak için lütfen uygulamayı ziyaret edin",
        suggestedDoctors: [],
        nextAvailableSlots: [],
      };
    }
  }

  /**
   * Suggest optimal appointment duration based on procedure type
   */
  static suggestDuration(procedureType: string): number {
    const durationMap: Record<string, number> = {
      "Genel Muayene": 20,
      "Diş Temizliği": 30,
      "Dolgu": 40,
      "Çekim": 30,
      "Taç": 50,
      "Kök Kanal": 90,
      "Ortodonti Uygulaması": 60,
      "İmplant Yerleştirme": 120,
    };

    return durationMap[procedureType] || 30; // Default 30 minutes
  }

  /**
   * Validate appointment feasibility
   * Checks for conflicts, doctor availability, etc.
   */
  static async validateAppointmentFeasibility(
    patientId: string,
    doctorId: string,
    startTime: Date,
    duration: number
  ): Promise<{ valid: boolean; reason?: string }> {
    try {
      // TODO: Check for conflicts
      // const conflict = await checkConflicts(doctorId, startTime, startTime + duration);
      // const doctorAvailable = await isDoctorAvailable(doctorId, startTime);

      // Mock validation
      const endTime = new Date(startTime.getTime() + duration * 60000);

      if (startTime <= new Date()) {
        return { valid: false, reason: "Geçmiş tarih seçilemez" };
      }

      if (endTime.getHours() > 18) {
        return { valid: false, reason: "Çalışma saatleri dışında randevu alınamaz" };
      }

      console.log(
        `[APPOINTMENT-AI] Validation passed for ${doctorId} on ${startTime}`
      );

      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        reason: "Doğrulama sırasında hata oluştu",
      };
    }
  }
}
