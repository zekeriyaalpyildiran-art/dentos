"use client";

// The site root has no page of its own: signed-in staff go to the panel home, everyone else to the login page.
// The root is also the Supabase Site URL, where invite / recovery links land when their redirect is not allowed;
// such a link (tokens or an error in the hash) is passed on to /reset-password, which validates it and asks first.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";

export default function Home() {
  const router = useRouter();
  const user = useAuthStore((state) => state.user);
  const loading = useAuthStore((state) => state.loading);

  useEffect(() => {
    const hash = window.location.hash;
    if (/(^#|&)(access_token|error_code|error)=/.test(hash)) {
      router.replace("/reset-password" + window.location.search + hash);
      return;
    }
    if (loading) return;
    router.replace(user ? "/dashboard" : "/login");
  }, [user, loading, router]);

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
        <p className="mt-4 text-gray-600">Yükleniyor...</p>
      </div>
    </div>
  );
}
