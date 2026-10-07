import { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert } from "react-native";
import { router } from "expo-router";

export default function PhoneLoginScreen() {
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState("");

  const handleSendOTP = async () => {
    if (!phone || phone.length < 10) {
      Alert.alert("Hata", "Geçerli bir telefon numarası girin");
      return;
    }

    setLoading(true);
    try {
      // TODO: Call Supabase phone auth API
      // const { data, error } = await supabase.auth.signInWithOtp({
      //   phone: formatPhoneNumber(phone),
      // });

      // Mock for development
      console.log(`[OTP-STUB] Sending OTP to ${phone}`);
      setOtpSent(true);
    } catch (error) {
      Alert.alert("Hata", "OTP gönderilemedi");
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOTP = async () => {
    if (!otp || otp.length !== 6) {
      Alert.alert("Hata", "6 haneli OTP kodu girin");
      return;
    }

    setLoading(true);
    try {
      // TODO: Verify OTP
      // const { data, error } = await supabase.auth.verifyOtp({
      //   phone: formatPhoneNumber(phone),
      //   token: otp,
      //   type: "sms",
      // });

      // Mock for development
      console.log(`[OTP-VERIFY] Verifying OTP: ${otp}`);
      router.replace("/(patient)/(tabs)/appointments");
    } catch (error) {
      Alert.alert("Hata", "OTP doğrulanamadı");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Hastane Randevu Sistemi</Text>
        <Text style={styles.subtitle}>Hastalar İçin Mobil Uygulama</Text>

        <View style={styles.form}>
          {!otpSent ? (
            <>
              <Text style={styles.label}>Telefon Numarası</Text>
              <TextInput
                style={styles.input}
                placeholder="5XXXXXXXXX veya +905XXXXXXXXX"
                placeholderTextColor="#999"
                keyboardType="phone-pad"
                value={phone}
                onChangeText={setPhone}
                editable={!loading}
              />
              <TouchableOpacity
                style={[styles.button, loading && styles.buttonDisabled]}
                onPress={handleSendOTP}
                disabled={loading}
              >
                <Text style={styles.buttonText}>
                  {loading ? "Gönderiliyor..." : "OTP Gönder"}
                </Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.label}>OTP Kodunu Girin</Text>
              <Text style={styles.hint}>
                {phone} numarasına SMS ile gönderilen 6 haneli kodu giriniz
              </Text>
              <TextInput
                style={styles.input}
                placeholder="000000"
                placeholderTextColor="#999"
                keyboardType="number-pad"
                maxLength={6}
                value={otp}
                onChangeText={setOtp}
                editable={!loading}
              />
              <TouchableOpacity
                style={[styles.button, loading && styles.buttonDisabled]}
                onPress={handleVerifyOTP}
                disabled={loading}
              >
                <Text style={styles.buttonText}>
                  {loading ? "Doğrulanıyor..." : "Giriş Yap"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setOtpSent(false)}>
                <Text style={styles.link}>Farklı numara ile giriş yap</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        <Text style={styles.footer}>
          Telefonunuz aracılığıyla güvenli giriş yapın
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  content: {
    alignItems: "center",
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 8,
    color: "#333",
  },
  subtitle: {
    fontSize: 14,
    color: "#666",
    marginBottom: 40,
  },
  form: {
    width: "100%",
    backgroundColor: "white",
    borderRadius: 12,
    padding: 20,
    marginBottom: 20,
  },
  label: {
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 8,
    color: "#333",
  },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 16,
    fontSize: 16,
    color: "#333",
  },
  button: {
    backgroundColor: "#0066cc",
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
    marginBottom: 12,
  },
  buttonDisabled: {
    backgroundColor: "#ccc",
  },
  buttonText: {
    color: "white",
    fontSize: 16,
    fontWeight: "600",
  },
  link: {
    color: "#0066cc",
    fontSize: 14,
    textAlign: "center",
  },
  hint: {
    fontSize: 12,
    color: "#666",
    marginBottom: 12,
  },
  footer: {
    fontSize: 12,
    color: "#999",
    textAlign: "center",
  },
});
