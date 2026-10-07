import { useState, useEffect } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";

interface Appointment {
  id: string;
  doctor_name: string;
  start_time: string;
  chair_name: string;
  status: "scheduled" | "completed" | "cancelled";
}

export default function AppointmentsScreen() {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    fetchAppointments();
  }, []);

  const fetchAppointments = async () => {
    try {
      // TODO: Fetch from Supabase
      // const { data, error } = await supabase
      //   .from("appointments")
      //   .select("id,doctor_id,start_time,chair_id,status,doctors(full_name),chairs(name)")
      //   .eq("patient_id", patient_id)
      //   .order("start_time", { ascending: false });

      // Mock data for development
      console.log("[APPOINTMENTS-STUB] Fetching patient appointments");
      const mockAppointments: Appointment[] = [
        {
          id: "apt-001",
          doctor_name: "Dr. Ahmet Yılmaz",
          start_time: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
          chair_name: "Koltuk 1",
          status: "scheduled",
        },
        {
          id: "apt-002",
          doctor_name: "Dr. Fatma Kara",
          start_time: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          chair_name: "Koltuk 2",
          status: "scheduled",
        },
        {
          id: "apt-003",
          doctor_name: "Dr. Mehmet Öz",
          start_time: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
          chair_name: "Koltuk 1",
          status: "completed",
        },
      ];

      setAppointments(mockAppointments);
    } catch (error) {
      console.error("Error fetching appointments:", error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    fetchAppointments();
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "scheduled":
        return "#0066cc";
      case "completed":
        return "#28a745";
      case "cancelled":
        return "#dc3545";
      default:
        return "#666";
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case "scheduled":
        return "Planlı";
      case "completed":
        return "Tamamlandı";
      case "cancelled":
        return "İptal";
      default:
        return status;
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString("tr-TR", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const renderAppointment = ({ item }: { item: Appointment }) => (
    <TouchableOpacity
      style={styles.appointmentCard}
      onPress={() => router.push(`/(patient)/appointments/${item.id}`)}
    >
      <View style={styles.cardHeader}>
        <View>
          <Text style={styles.doctorName}>{item.doctor_name}</Text>
          <Text style={styles.dateTime}>{formatDate(item.start_time)}</Text>
        </View>
        <View
          style={[
            styles.statusBadge,
            { backgroundColor: getStatusColor(item.status) },
          ]}
        >
          <Text style={styles.statusText}>{getStatusLabel(item.status)}</Text>
        </View>
      </View>
      <View style={styles.cardFooter}>
        <MaterialCommunityIcons name="chair-rolling" size={16} color="#666" />
        <Text style={styles.chairName}>{item.chair_name}</Text>
      </View>
    </TouchableOpacity>
  );

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#0066cc" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {appointments.length === 0 ? (
        <View style={styles.emptyState}>
          <MaterialCommunityIcons name="calendar-blank" size={64} color="#ccc" />
          <Text style={styles.emptyText}>Henüz randevunuz yok</Text>
          <TouchableOpacity
            style={styles.bookButton}
            onPress={() => router.push("/(patient)/(tabs)/book")}
          >
            <Text style={styles.bookButtonText}>Randevu Al</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={appointments}
          renderItem={renderAppointment}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
  },
  listContent: {
    padding: 12,
  },
  appointmentCard: {
    backgroundColor: "white",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderLeftWidth: 4,
    borderLeftColor: "#0066cc",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 12,
  },
  doctorName: {
    fontSize: 16,
    fontWeight: "600",
    color: "#333",
    marginBottom: 4,
  },
  dateTime: {
    fontSize: 13,
    color: "#666",
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
  },
  statusText: {
    color: "white",
    fontSize: 12,
    fontWeight: "600",
  },
  cardFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  chairName: {
    fontSize: 13,
    color: "#666",
  },
  emptyState: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  emptyText: {
    fontSize: 16,
    color: "#999",
    marginTop: 16,
    marginBottom: 24,
  },
  bookButton: {
    backgroundColor: "#0066cc",
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 8,
  },
  bookButtonText: {
    color: "white",
    fontSize: 16,
    fontWeight: "600",
  },
});
