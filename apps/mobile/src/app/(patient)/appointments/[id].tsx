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
import { useLocalSearchParams, router } from "expo-router";

interface AppointmentDetail {
  id: string;
  doctor_name: string;
  doctor_specialty: string;
  start_time: string;
  end_time: string;
  chair_name: string;
  status: "scheduled" | "completed" | "cancelled";
  notes?: string;
}

export default function AppointmentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [appointment, setAppointment] = useState<AppointmentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    fetchAppointment();
  }, [id]);

  const fetchAppointment = async () => {
    try {
      // TODO: Fetch appointment details
      // const { data } = await supabase
      //   .from("appointments")
      //   .select("*, doctors(full_name,specialty), chairs(name)")
      //   .eq("id", id)
      //   .single();

      const mockAppointment: AppointmentDetail = {
        id: id || "apt-001",
        doctor_name: "Dr. Ahmet Yılmaz",
        doctor_specialty: "Genel Diş",
        start_time: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        end_time: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 30 * 60000).toISOString(),
        chair_name: "Koltuk 1",
        status: "scheduled",
        notes: "Rutin kontrol ve temizlik",
      };

      setAppointment(mockAppointment);
    } catch (error) {
      Alert.alert("Hata", "Randevu detayları yüklenemedi");
    } finally {
      setLoading(false);
    }
  };

  const handleCancelAppointment = () => {
    Alert.alert(
      "Randevuyu İptal Et",
      "Bu randevuyu iptal etmek istediğinize emin misiniz?",
      [
        { text: "Hayır", style: "cancel" },
        {
          text: "Evet, İptal Et",
          style: "destructive",
          onPress: async () => {
            setCancelling(true);
            try {
              // TODO: Cancel appointment
              // const { error } = await supabase
              //   .from("appointments")
              //   .update({ status: "cancelled" })
              //   .eq("id", id);

              console.log("[CANCEL-STUB] Appointment cancelled");
              Alert.alert("Başarılı", "Randevunuz iptal edildi");
              router.back();
            } catch (error) {
              Alert.alert("Hata", "Randevu iptal edilemedi");
            } finally {
              setCancelling(false);
            }
          },
        },
      ]
    );
  };

  const handleReschedule = () => {
    Alert.alert(
      "Bilgi",
      "Randevunuzu değiştirmek için yeni bir randevu alınız ve eski randevuyu iptal ediniz"
    );
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#0066cc" />
      </View>
    );
  }

  if (!appointment) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>Randevu bulunamadı</Text>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
        >
          <Text style={styles.backButtonText}>Geri Dön</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const formatDateTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString("tr-TR", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const canCancel = appointment.status === "scheduled";

  return (
    <ScrollView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <MaterialCommunityIcons name="arrow-left" size={24} color="#0066cc" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Randevu Detayları</Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* Status Badge */}
      <View style={styles.statusSection}>
        <View
          style={[
            styles.statusBadge,
            {
              backgroundColor:
                appointment.status === "scheduled"
                  ? "#0066cc"
                  : appointment.status === "completed"
                  ? "#28a745"
                  : "#dc3545",
            },
          ]}
        >
          <MaterialCommunityIcons
            name={
              appointment.status === "scheduled"
                ? "calendar-clock"
                : appointment.status === "completed"
                ? "calendar-check"
                : "calendar-remove"
            }
            size={24}
            color="white"
          />
          <Text style={styles.statusText}>
            {appointment.status === "scheduled"
              ? "Planlı"
              : appointment.status === "completed"
              ? "Tamamlandı"
              : "İptal"}
          </Text>
        </View>
      </View>

      {/* Doctor Information */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Hekim Bilgisi</Text>
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <MaterialCommunityIcons name="doctor" size={40} color="#0066cc" />
            <View style={styles.cardContent}>
              <Text style={styles.doctorName}>{appointment.doctor_name}</Text>
              <Text style={styles.specialty}>{appointment.doctor_specialty}</Text>
            </View>
          </View>
        </View>
      </View>

      {/* Appointment Details */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Randevu Bilgisi</Text>
        <View style={styles.card}>
          <View style={styles.detailRow}>
            <MaterialCommunityIcons
              name="calendar-range"
              size={20}
              color="#0066cc"
              style={styles.detailIcon}
            />
            <View style={styles.detailContent}>
              <Text style={styles.detailLabel}>Tarih & Saat</Text>
              <Text style={styles.detailValue}>
                {formatDateTime(appointment.start_time)}
              </Text>
            </View>
          </View>

          <View style={styles.divider} />

          <View style={styles.detailRow}>
            <MaterialCommunityIcons
              name="chair-rolling"
              size={20}
              color="#0066cc"
              style={styles.detailIcon}
            />
            <View style={styles.detailContent}>
              <Text style={styles.detailLabel}>Tedavi Ünitesi</Text>
              <Text style={styles.detailValue}>{appointment.chair_name}</Text>
            </View>
          </View>

          {appointment.notes && (
            <>
              <View style={styles.divider} />
              <View style={styles.detailRow}>
                <MaterialCommunityIcons
                  name="note-text"
                  size={20}
                  color="#0066cc"
                  style={styles.detailIcon}
                />
                <View style={styles.detailContent}>
                  <Text style={styles.detailLabel}>Notlar</Text>
                  <Text style={styles.detailValue}>{appointment.notes}</Text>
                </View>
              </View>
            </>
          )}
        </View>
      </View>

      {/* Duration Information */}
      <View style={styles.section}>
        <View style={styles.infoBox}>
          <MaterialCommunityIcons name="information" size={20} color="#0066cc" />
          <Text style={styles.infoText}>
            Randevu saatine 10 dakika erken gelmenizi rica ederiz
          </Text>
        </View>
      </View>

      {/* Actions */}
      {canCancel && (
        <View style={styles.section}>
          <TouchableOpacity
            style={styles.rescheduleButton}
            onPress={handleReschedule}
          >
            <MaterialCommunityIcons
              name="calendar-edit"
              size={20}
              color="#666"
            />
            <Text style={styles.rescheduleButtonText}>Randevuyu Değiştir</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.cancelButton, cancelling && styles.cancelButtonDisabled]}
            onPress={handleCancelAppointment}
            disabled={cancelling}
          >
            <MaterialCommunityIcons
              name="calendar-remove"
              size={20}
              color="#dc3545"
            />
            <Text style={styles.cancelButtonText}>
              {cancelling ? "İptal Ediliyor..." : "Randevuyu İptal Et"}
            </Text>
          </TouchableOpacity>
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
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 16,
    backgroundColor: "white",
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: "#333",
  },
  headerSpacer: {
    width: 24,
  },
  statusSection: {
    alignItems: "center",
    paddingVertical: 24,
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 30,
    gap: 8,
  },
  statusText: {
    color: "white",
    fontSize: 16,
    fontWeight: "600",
  },
  section: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#333",
    marginBottom: 12,
  },
  card: {
    backgroundColor: "white",
    borderRadius: 12,
    padding: 16,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  cardContent: {
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
  detailRow: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  detailIcon: {
    marginRight: 12,
    marginTop: 2,
  },
  detailContent: {
    flex: 1,
  },
  detailLabel: {
    fontSize: 12,
    color: "#999",
    marginBottom: 4,
  },
  detailValue: {
    fontSize: 15,
    fontWeight: "600",
    color: "#333",
  },
  divider: {
    height: 1,
    backgroundColor: "#f0f0f0",
    marginVertical: 12,
  },
  infoBox: {
    backgroundColor: "white",
    borderRadius: 12,
    padding: 16,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  infoText: {
    flex: 1,
    fontSize: 14,
    color: "#666",
    lineHeight: 20,
  },
  rescheduleButton: {
    flexDirection: "row",
    backgroundColor: "white",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#ddd",
  },
  rescheduleButtonText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#666",
    marginLeft: 12,
  },
  cancelButton: {
    flexDirection: "row",
    backgroundColor: "white",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#dc3545",
  },
  cancelButtonDisabled: {
    opacity: 0.6,
  },
  cancelButtonText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#dc3545",
    marginLeft: 12,
  },
  backButton: {
    backgroundColor: "#0066cc",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
    marginTop: 24,
  },
  backButtonText: {
    color: "white",
    fontSize: 16,
    fontWeight: "600",
  },
  errorText: {
    fontSize: 16,
    color: "#dc3545",
    textAlign: "center",
    marginTop: 24,
  },
});
