import { View, Text, StyleSheet } from "react-native";

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#fff",
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
  },
  subtitle: {
    fontSize: 18,
    color: "#666",
  },
});

export default function Home() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>DentOS</Text>
      <Text style={styles.subtitle}>Diş kliniği uygulaması</Text>
    </View>
  );
}
