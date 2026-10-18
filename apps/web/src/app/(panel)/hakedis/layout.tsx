"use client";

// 'Hakediş ve maaş' (0031): 'hakedis_prepare' holders (the reception prepares the doctors' hakediş and the staff
// payroll without the finance permission) and finance holders. Others are sent to their start page. The fin_hk_* RPCs
// check the same permissions; prep-only callers never get ledger data.
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { HAKEDIS_READ_PERMISSIONS } from "@/lib/permissions";

export default function Layout({ children }: { children: React.ReactNode }) {
  return <ProtectedRoute requiredPermission={HAKEDIS_READ_PERMISSIONS}>{children}</ProtectedRoute>;
}
