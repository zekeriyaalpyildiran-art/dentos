"use client";

// Closed to the roles listed for "/team" in SECTIONS_CLOSED_FOR (lib/nav.ts); they are sent to their start page.
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { rolesAllowedFor } from "@/lib/nav";

export default function Layout({ children }: { children: React.ReactNode }) {
  return <ProtectedRoute allowedRoles={rolesAllowedFor("/team")}>{children}</ProtectedRoute>;
}
