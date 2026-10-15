"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { hasPermission, type Permission } from "@/lib/permissions";

interface Props {
  children: React.ReactNode;
  allowedRoles?: string[];
  /**
   * The signed-in user must hold this staff permission (or, for a list, at least one of them);
   * otherwise they are sent to the dashboard.
   */
  requiredPermission?: Permission | readonly Permission[];
}

export function ProtectedRoute({ children, allowedRoles, requiredPermission }: Props) {
  const router = useRouter();
  const user = useAuthStore((state) => state.user);
  const loading = useAuthStore((state) => state.loading);

  const required: readonly Permission[] = !requiredPermission
    ? []
    : typeof requiredPermission === "string"
      ? [requiredPermission]
      : requiredPermission;

  const allowed =
    !!user &&
    (!allowedRoles || allowedRoles.includes(user.role)) &&
    (required.length === 0 || required.some((p) => hasPermission(user, p)));

  useEffect(() => {
    if (loading) return;

    if (!user) {
      router.push("/login");
      return;
    }

    if (!allowed) {
      router.push("/dashboard");
    }
  }, [user, loading, router, allowed]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
          <p className="mt-4 text-gray-600">Yükleniyor...</p>
        </div>
      </div>
    );
  }

  if (!allowed) {
    return null;
  }

  return <>{children}</>;
}
