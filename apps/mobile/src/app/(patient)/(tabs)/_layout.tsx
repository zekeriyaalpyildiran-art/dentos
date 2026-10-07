import { Tabs } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: true,
        tabBarActiveTintColor: "#0066cc",
        tabBarInactiveTintColor: "#999",
        headerStyle: {
          backgroundColor: "#f5f5f5",
          borderBottomWidth: 1,
          borderBottomColor: "#ddd",
        },
        headerTitleStyle: {
          fontSize: 18,
          fontWeight: "600",
        },
      }}
    >
      <Tabs.Screen
        name="appointments"
        options={{
          title: "Randevularım",
          tabBarLabel: "Randevular",
          tabBarIcon: ({ color }) => (
            <MaterialCommunityIcons name="calendar-check" size={24} color={color} />
          ),
          headerTitle: "Randevularım",
        }}
      />
      <Tabs.Screen
        name="book"
        options={{
          title: "Randevu Al",
          tabBarLabel: "Yeni Randevu",
          tabBarIcon: ({ color }) => (
            <MaterialCommunityIcons name="calendar-plus" size={24} color={color} />
          ),
          headerTitle: "Yeni Randevu",
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profilim",
          tabBarLabel: "Profil",
          tabBarIcon: ({ color }) => (
            <MaterialCommunityIcons name="account-circle" size={24} color={color} />
          ),
          headerTitle: "Profilim",
        }}
      />
    </Tabs>
  );
}
