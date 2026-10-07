/**
 * Appointment Service
 * Handles appointment CRUD and status management
 */

export type AppointmentStatus = "scheduled" | "completed" | "cancelled" | "no_show";

export interface AppointmentUpdate {
  status?: AppointmentStatus;
  notes?: string;
  updated_at?: string;
}

export class AppointmentService {
  /**
   * Check for overlapping appointments
   * Prevention for double-booking on same doctor/chair
   */
  static checkConflict(
    newStart: Date,
    newEnd: Date,
    existingAppointments: Array<{
      start_time: string;
      end_time: string;
      status: string;
      doctor_id?: string;
      chair_id?: string;
    }>,
    doctorId: string,
    chairId: string
  ): boolean {
    const newStartTime = newStart.getTime();
    const newEndTime = newEnd.getTime();

    return existingAppointments.some((apt) => {
      // Skip cancelled appointments
      if (apt.status === "cancelled") return false;

      // Check if same doctor or chair
      if (apt.doctor_id !== doctorId && apt.chair_id !== chairId) {
        return false;
      }

      const existingStart = new Date(apt.start_time).getTime();
      const existingEnd = new Date(apt.end_time).getTime();

      // Check for overlap
      return !(newEndTime <= existingStart || newStartTime >= existingEnd);
    });
  }

  /**
   * Calculate slot availability for a given date/doctor/chair
   */
  static getAvailableSlots(
    date: Date,
    slotDuration: number = 30, // minutes
    workStart: number = 9, // 9 AM
    workEnd: number = 18, // 6 PM
    existingAppointments: Array<{
      start_time: string;
      end_time: string;
      status: string;
      doctor_id?: string;
      chair_id?: string;
    }>,
    doctorId: string,
    chairId: string
  ): Array<{ start: Date; end: Date }> {
    const slots: Array<{ start: Date; end: Date }> = [];
    const dayStart = new Date(date);
    dayStart.setHours(workStart, 0, 0, 0);

    let currentSlot = new Date(dayStart);
    const dayEnd = new Date(dayStart);
    dayEnd.setHours(workEnd, 0, 0, 0);

    while (currentSlot.getTime() < dayEnd.getTime()) {
      const slotEnd = new Date(currentSlot.getTime() + slotDuration * 60000);

      // Check if slot conflicts
      const hasConflict = this.checkConflict(currentSlot, slotEnd, existingAppointments, doctorId, chairId);

      if (!hasConflict) {
        slots.push({
          start: new Date(currentSlot),
          end: new Date(slotEnd),
        });
      }

      currentSlot = slotEnd;
    }

    return slots;
  }

  /**
   * Format appointment status for display
   */
  static formatStatus(status: AppointmentStatus): string {
    const statusMap: Record<AppointmentStatus, string> = {
      scheduled: "Planlı",
      completed: "Tamamlandı",
      cancelled: "İptal",
      no_show: "Gelmedi",
    };
    return statusMap[status];
  }

  /**
   * Get status badge color
   */
  static getStatusColor(status: AppointmentStatus): string {
    const colorMap: Record<AppointmentStatus, string> = {
      scheduled: "bg-blue-100 text-blue-800",
      completed: "bg-green-100 text-green-800",
      cancelled: "bg-red-100 text-red-800",
      no_show: "bg-yellow-100 text-yellow-800",
    };
    return colorMap[status];
  }

  /**
   * Calculate duration in minutes
   */
  static getDuration(startTime: string, endTime: string): number {
    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();
    return Math.round((end - start) / 60000);
  }

  /**
   * Check if appointment can be cancelled
   * (cannot cancel if within 24 hours of appointment)
   */
  static canCancel(startTime: string): boolean {
    const appointmentTime = new Date(startTime).getTime();
    const now = Date.now();
    const hoursUntilAppointment = (appointmentTime - now) / (1000 * 60 * 60);

    return hoursUntilAppointment > 24;
  }

  /**
   * Check if appointment can be rescheduled
   */
  static canReschedule(startTime: string, status: AppointmentStatus): boolean {
    if (status !== "scheduled") return false;
    return this.canCancel(startTime);
  }
}
