import { useState, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
} from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";

interface PatientProfile {
  id: string;
  full_name: string;
  phone: string;
  email: string;
  gender: string;
  birth_date: string;
  address: string;
  kvkk_consent: boolean;
}

export default function ProfileScreen() {
  const [profile, setProfile] = useState<PatientProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    fetchProfile();
  }, []);

  const fetchProfile = async () => {
    try {
      // TODO: Fetch from Supabase
      // const { data } = await supabase
      //   .from("patients")
      //   .select("*")
      //   .eq("id", patient_id)
      //   .single();

      const mockProfile: PatientProfile = {
        id: "patient-001",
        full_name: "Mehmet Yağmur",
        phone: "5551234567",
        email: "mehmet@example.com",
        gender: "M",
        birth_date: "1990-01-15",
        address: "İstanbul, Türkiye",
        kvkk_consent: true,
      };

      setProfile(mockProfile);
    } catch (error) {
      Alert.alert("Hata", "Profil yüklenemedi");
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    Alert.alert("Çıkış Yap", "Uygulamadan çıkmak istediğinize emin misiniz?", [
      { text: "İptal", style: "cancel" },
      {
        text: "Çıkış Yap",
        style: "destructive",
        onPress: async () => {
          // TODO: Logout
          // await supabase.auth.signOut();
          console.log("[LOGOUT-STUB] User logged out");
          router.replace("/(patient)/auth/phone-login");
        },
      },
    ]);
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#0066cc" />
      </View>
    );
  }

  if (!profile) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>Profil yüklenemedi</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      {/* Profile Header */}
      <View style={styles.headerBox}>
        <View style={styles.avatarContainer}>
          <MaterialCommunityIcons name="account-circle" size={80} color="#0066cc" />
        </View>
        <Text style={styles.fullName}>{profile.full_name}</Text>
        <Text style={styles.phone}>{profile.phone}</Text>
      </View>

      {/* Profile Information */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Kişisel Bilgiler</Text>

        <View style={styles.infoCard}>
          <View style={styles.infoRow}>
            <View style={styles.infoIcon}>
              <MaterialCommunityIcons name="email" size={20} color="#0066cc" />
            </View>
            <View style={styles.infoContent}>
              <Text style={styles.infoLabel}>E-Mail</Text>
              <Text style={styles.infoValue}>{profile.email}</Text>
            </View>
          </View>

          <View style={styles.divider} />

          <View style={styles.infoRow}>
            <View style={styles.infoIcon}>
              <MaterialCommunityIcons
                name={profile.gender === "M" ? "gender-male" : "gender-female"}
                size={20}
                color="#0066cc"
              />
            </View>
            <View style={styles.infoContent}>
              <Text style={styles.infoLabel}>Cinsiyet</Text>
              <Text style={styles.infoValue}>
                {profile.gender === "M" ? "Erkek" : "Kadın"}
              </Text>
            </View>
          </View>

          <View style={styles.divider} />

          <View style={styles.infoRow}>
            <View style={styles.infoIcon}>
              <MaterialCommunityIcons name="cake" size={20} color="#0066cc" />
            </View>
            <View style={styles.infoContent}>
              <Text style={styles.infoLabel}>Doğum Tarihi</Text>
              <Text style={styles.infoValue}>
                {new Date(profile.birth_date).toLocaleDateString("tr-TR")}
              </Text>
            </View>
          </View>

          <View style={styles.divider} />

          <View style={styles.infoRow}>
            <View style={styles.infoIcon}>
              <MaterialCommunityIcons name="map-marker" size={20} color="#0066cc" />
            </View>
            <View style={styles.infoContent}>
              <Text style={styles.infoLabel}>Adres</Text>
              <Text style={styles.infoValue}>{profile.address}</Text>
            </View>
          </View>
        </View>
      </View>

      {/* Consent */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>KVKK Onayı</Text>
        <View style={styles.consentCard}>
          <View style={styles.consentRow}>
            <View style={styles.consentCheckbox}>
              {profile.kvkk_consent && (
                <MaterialCommunityIcons name="check" size={20} color="white" />
              )}
            </View>
            <View style={styles.consentContent}>
              <Text style={styles.consentText}>
                Kişisel verilerim KVKK kapsamında işlenebilir
              </Text>
            </View>
          </View>
        </View>
      </View>

      {/* Actions */}
      <View style={styles.section}>
        <TouchableOpacity style={styles.editButton}>
          <MaterialCommunityIcons name="pencil" size={20} color="#0066cc" />
          <Text style={styles.editButtonText}>Profili Düzenle</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
          <MaterialCommunityIcons name="logout" size={20} color="#dc3545" />
          <Text style={styles.logoutButtonText}>Çıkış Yap</Text>
        </TouchableOpacity>
      </View>

      {/* App Version */}
      <View style={styles.footerSection}>
        <Text style={styles.versionText}>DentOS v1.0.0</Text>
        <Text style={styles.copyrightText}>© 2026 Tüm Hakları Saklıdır</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
  },
  headerBox: {
    backgroundColor: "white",
    padding: 24,
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  avatarContainer: {
    marginBottom: 16,
  },
  fullName: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#333",
    marginBottom: 4,
  },
  phone: {
    fontSize: 14,
    color: "#666",
  },
  section: {
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#333",
    marginBottom: 12,
  },
  infoCard: {
    backgroundColor: "white",
    borderRadius: 12,
    overflow: "hidden",
  },
  infoRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    padding: 16,
  },
  infoIcon: {
    width: 40,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  infoContent: {
    flex: 1,
  },
  infoLabel: {
    fontSize: 12,
    color: "#999",
    marginBottom: 4,
  },
  infoValue: {
    fontSize: 14,
    fontWeight: "600",
    color: "#333",
  },
  divider: {
    height: 1,
    backgroundColor: "#f0f0f0",
  },
  consentCard: {
    backgroundColor: "white",
    borderRadius: 12,
    padding: 16,
  },
  consentRow: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  consentCheckbox: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: "#28a745",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  consentContent: {
    flex: 1,
  },
  consentText: {
    fontSize: 14,
    color: "#333",
  },
  editButton: {
    flexDirection: "row",
    backgroundColor: "white",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#0066cc",
  },
  editButtonText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#0066cc",
    marginLeft: 12,
  },
  logoutButton: {
    flexDirection: "row",
    backgroundColor: "white",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#dc3545",
  },
  logoutButtonText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#dc3545",
    marginLeft: 12,
  },
  footerSection: {
    alignItems: "center",
    paddingVertical: 32,
  },
  versionText: {
    fontSize: 12,
    color: "#999",
    marginBottom: 4,
  },
  copyrightText: {
    fontSize: 11,
    color: "#bbb",
  },
  errorText: {
    fontSize: 16,
    color: "#dc3545",
    textAlign: "center",
  },
});
