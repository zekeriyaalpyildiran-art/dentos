"use client";

// Closed to the roles listed for "/clinical" in SECTIONS_CLOSED_FOR (lib/nav.ts); they are sent to their start page.
// A patient's implants stay on the patient card (/patients/<id>?tab=implants), outside this section.
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { rolesAllowedFor } from "@/lib/nav";

export default function Layout({ children }: { children: React.ReactNode }) {
  return <ProtectedRoute allowedRoles={rolesAllowedFor("/clinical")}>{children}</ProtectedRoute>;
}
