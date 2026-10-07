import { useState, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
} from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";

interface Doctor {
  id: string;
  full_name: string;
  specialty: string;
}

interface TimeSlot {
  time: Date;
  available: boolean;
}

export default function BookAppointmentScreen() {
  const [step, setStep] = useState<"doctor" | "date" | "time" | "confirm">(
    "doctor"
  );
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDoctor, setSelectedDoctor] = useState<Doctor | null>(null);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [timeSlots, setTimeSlots] = useState<TimeSlot[]>([]);
  const [selectedTime, setSelectedTime] = useState<Date | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchDoctors();
  }, []);

  useEffect(() => {
    if (step === "time" && selectedDoctor) {
      generateTimeSlots();
    }
  }, [step, selectedDate, selectedDoctor]);

  const fetchDoctors = async () => {
    try {
      // TODO: Fetch doctors from Supabase
      // const { data } = await supabase
      //   .from("doctors")
      //   .select("id,user_id,specialty")
      //   .eq("clinic_id", clinic_id)
      //   .eq("is_active", true);

      const mockDoctors: Doctor[] = [
        { id: "doc-001", full_name: "Dr. Ahmet Yılmaz", specialty: "Genel Diş" },
        { id: "doc-002", full_name: "Dr. Fatma Kara", specialty: "Ortodonti" },
        { id: "doc-003", full_name: "Dr. Mehmet Öz", specialty: "Implantoloji" },
      ];

      setDoctors(mockDoctors);
    } catch (error) {
      Alert.alert("Hata", "Doktorlar yüklenemedi");
    } finally {
      setLoading(false);
    }
  };

  const generateTimeSlots = () => {
    const slots: TimeSlot[] = [];
    const dayStart = new Date(selectedDate);
    dayStart.setHours(9, 0, 0, 0);

    let current = new Date(dayStart);
    const dayEnd = new Date(dayStart);
    dayEnd.setHours(18, 0, 0, 0);

    while (current < dayEnd) {
      slots.push({
        time: new Date(current),
        available: Math.random() > 0.3, // 70% available
      });
      current = new Date(current.getTime() + 30 * 60000);
    }

    setTimeSlots(slots);
  };

  const handleDateChange = (event: any, date: Date | undefined) => {
    setShowDatePicker(false);
    if (date) {
      setSelectedDate(date);
    }
  };

  const handleBookAppointment = async () => {
    if (!selectedDoctor || !selectedTime) {
      Alert.alert("Hata", "Tüm alanları doldurunuz");
      return;
    }

    setSubmitting(true);
    try {
      // TODO: Create appointment
      // const { error } = await supabase.from("appointments").insert([
      //   {
      //     clinic_id,
      //     patient_id,
      //     doctor_id: selectedDoctor.id,
      //     start_time: selectedTime.toISOString(),
      //     end_time: new Date(selectedTime.getTime() + 30 * 60000).toISOString(),
      //     status: "scheduled",
      //   },
      // ]);

      console.log(
        `[BOOK-STUB] Creating appointment: ${selectedDoctor.full_name} on ${selectedTime}`
      );
      Alert.alert("Başarılı", "Randevunuz başarıyla alındı");
      setStep("doctor");
      setSelectedDoctor(null);
      setSelectedTime(null);
    } catch (error) {
      Alert.alert("Hata", "Randevu oluşturulurken hata oluştu");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#0066cc" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      {/* Progress indicator */}
      <View style={styles.progressBar}>
        {(["doctor", "date", "time", "confirm"] as const).map((s, idx) => (
          <View
            key={s}
            style={[
              styles.progressStep,
              {
                backgroundColor:
                  (["doctor", "date", "time", "confirm"] as const).indexOf(
                    step
                  ) >= idx
                    ? "#0066cc"
                    : "#ddd",
              },
            ]}
          />
        ))}
      </View>

      {/* Step 1: Select Doctor */}
      {step === "doctor" && (
        <View style={styles.stepContainer}>
          <Text style={styles.stepTitle}>Hekim Seçin</Text>
          <View style={styles.doctorList}>
            {doctors.map((doctor) => (
              <TouchableOpacity
                key={doctor.id}
                style={[
                  styles.doctorCard,
                  selectedDoctor?.id === doctor.id && styles.doctorCardSelected,
                ]}
                onPress={() => {
                  setSelectedDoctor(doctor);
                  setStep("date");
                }}
              >
                <MaterialCommunityIcons
                  name="doctor"
                  size={40}
                  color="#0066cc"
                  style={styles.doctorIcon}
                />
                <View style={styles.doctorInfo}>
                  <Text style={styles.doctorName}>{doctor.full_name}</Text>
                  <Text style={styles.specialty}>{doctor.specialty}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      {/* Step 2: Select Date */}
      {step === "date" && selectedDoctor && (
        <View style={styles.stepContainer}>
          <Text style={styles.stepTitle}>Tarih Seçin</Text>
          <TouchableOpacity
            style={styles.dateButton}
            onPress={() => setShowDatePicker(true)}
          >
            <MaterialCommunityIcons name="calendar" size={24} color="#0066cc" />
            <Text style={styles.dateButtonText}>
              {selectedDate.toLocaleDateString("tr-TR")}
            </Text>
          </TouchableOpacity>

          {showDatePicker && (
            <DateTimePicker
              value={selectedDate}
              mode="date"
              display="spinner"
              onChange={handleDateChange}
            />
          )}

          <View style={styles.stepActions}>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => setStep("doctor")}
            >
              <Text style={styles.secondaryButtonText}>Geri</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => setStep("time")}
            >
              <Text style={styles.primaryButtonText}>İleri</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Step 3: Select Time */}
      {step === "time" && (
        <View style={styles.stepContainer}>
          <Text style={styles.stepTitle}>Saat Seçin</Text>
          <View style={styles.timeSlotGrid}>
            {timeSlots.map((slot, idx) => (
              <TouchableOpacity
                key={idx}
                style={[
                  styles.timeSlot,
                  !slot.available && styles.timeSlotDisabled,
                  selectedTime?.getTime() === slot.time.getTime() &&
                    styles.timeSlotSelected,
                ]}
                onPress={() => slot.available && setSelectedTime(slot.time)}
                disabled={!slot.available}
              >
                <Text
                  style={[
                    styles.timeSlotText,
                    !slot.available && styles.timeSlotTextDisabled,
                  ]}
                >
                  {slot.time.toLocaleTimeString("tr-TR", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.stepActions}>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => setStep("date")}
            >
              <Text style={styles.secondaryButtonText}>Geri</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.primaryButton,
                !selectedTime && styles.primaryButtonDisabled,
              ]}
              onPress={() => setStep("confirm")}
              disabled={!selectedTime}
            >
              <Text style={styles.primaryButtonText}>İleri</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Step 4: Confirm */}
      {step === "confirm" && selectedDoctor && selectedTime && (
        <View style={styles.stepContainer}>
          <Text style={styles.stepTitle}>Randevunuzu Onaylayın</Text>
          <View style={styles.confirmBox}>
            <View style={styles.confirmRow}>
              <Text style={styles.confirmLabel}>Hekim:</Text>
              <Text style={styles.confirmValue}>{selectedDoctor.full_name}</Text>
            </View>
            <View style={styles.confirmRow}>
              <Text style={styles.confirmLabel}>Tarih:</Text>
              <Text style={styles.confirmValue}>
                {selectedTime.toLocaleDateString("tr-TR")}
              </Text>
            </View>
            <View style={styles.confirmRow}>
              <Text style={styles.confirmLabel}>Saat:</Text>
              <Text style={styles.confirmValue}>
                {selectedTime.toLocaleTimeString("tr-TR", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </Text>
            </View>
          </View>

          <View style={styles.stepActions}>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => setStep("time")}
              disabled={submitting}
            >
              <Text style={styles.secondaryButtonText}>Geri</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.primaryButton,
                submitting && styles.primaryButtonDisabled,
              ]}
              onPress={handleBookAppointment}
              disabled={submitting}
            >
              <Text style={styles.primaryButtonText}>
                {submitting ? "Kaydediliyor..." : "Randevuyu Onayla"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
  },
  progressBar: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 16,
    marginBottom: 24,
  },
  progressStep: {
    flex: 1,
    height: 4,
    borderRadius: 2,
  },
  stepContainer: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  stepTitle: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#333",
    marginBottom: 20,
  },
  doctorList: {
    gap: 12,
  },
  doctorCard: {
    flexDirection: "row",
    backgroundColor: "white",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    borderWidth: 2,
    borderColor: "#ddd",
  },
  doctorCardSelected: {
    borderColor: "#0066cc",
    backgroundColor: "#f0f5ff",
  },
  doctorIcon: {
    marginRight: 16,
  },
  doctorInfo: {
    flex: 1,
  },
  doctorName: {
    fontSize: 16,
    fontWeight: "600",
    color: "#333",
    marginBottom: 4,
  },
  specialty: {
    fontSize: 13,
    color: "#666",
  },
  dateButton: {
    flexDirection: "row",
    backgroundColor: "white",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    gap: 12,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: "#ddd",
  },
  dateButtonText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#333",
  },
  timeSlotGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginBottom: 24,
  },
  timeSlot: {
    width: "30%",
    paddingVertical: 12,
    backgroundColor: "white",
    borderRadius: 8,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#ddd",
  },
  timeSlotSelected: {
    backgroundColor: "#0066cc",
    borderColor: "#0066cc",
  },
  timeSlotDisabled: {
    opacity: 0.5,
  },
  timeSlotText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#333",
  },
  timeSlotTextDisabled: {
    color: "#999",
  },
  confirmBox: {
    backgroundColor: "white",
    borderRadius: 12,
    padding: 20,
    marginBottom: 24,
    gap: 16,
    borderLeftWidth: 4,
    borderLeftColor: "#0066cc",
  },
  confirmRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  confirmLabel: {
    fontSize: 14,
    color: "#666",
    fontWeight: "600",
  },
  confirmValue: {
    fontSize: 16,
    fontWeight: "600",
    color: "#333",
  },
  stepActions: {
    flexDirection: "row",
    gap: 12,
  },
  primaryButton: {
    flex: 1,
    backgroundColor: "#0066cc",
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: "center",
  },
  primaryButtonDisabled: {
    backgroundColor: "#ccc",
  },
  primaryButtonText: {
    color: "white",
    fontSize: 16,
    fontWeight: "600",
  },
  secondaryButton: {
    flex: 1,
    backgroundColor: "white",
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#ddd",
  },
  secondaryButtonText: {
    color: "#333",
    fontSize: 16,
    fontWeight: "600",
  },
});
