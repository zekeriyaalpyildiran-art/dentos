import { Stack } from "expo-router";

export default function PatientLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
      }}
    >
      <Stack.Screen name="auth/phone-login" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="appointments/[id]" />
    </Stack>
  );
}
