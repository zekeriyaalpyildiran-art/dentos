// The patient search moved to components/patients/PatientPicker (shared by stock, clinical, appointments and
// treatment plans). Kept as a re-export so existing stock / clinical imports stay unchanged.
export { PatientPicker, type PatientRef } from "@/components/patients/PatientPicker";
