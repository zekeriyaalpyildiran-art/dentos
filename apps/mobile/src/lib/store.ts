import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";

export interface PatientUser {
  id: string;
  phone: string;
  full_name: string;
  email: string;
  clinic_id: string;
}

interface PatientStore {
  user: PatientUser | null;
  isLoading: boolean;
  setUser: (user: PatientUser | null) => void;
  setLoading: (loading: boolean) => void;
  logout: () => void;
}

export const usePatientStore = create<PatientStore>()(
  persist(
    (set) => ({
      user: null,
      isLoading: false,
      setUser: (user) => set({ user }),
      setLoading: (isLoading) => set({ isLoading }),
      logout: () => set({ user: null }),
    }),
    {
      name: "patient-store",
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
