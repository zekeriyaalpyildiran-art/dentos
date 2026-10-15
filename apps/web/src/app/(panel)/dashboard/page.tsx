"use client";

// /dashboard is only a doorway: after login, from the installed app (start_url) and when a page refuses the user,
// everyone lands here and is sent on to the start page of their role (ROLE_HOME in lib/nav.ts).

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { homePathForUser } from "@/lib/nav";

export default function DashboardPage() {
  const router = useRouter();
  const user = useAuthStore((state) => state.user);
  const target = user?.role ? homePathForUser(user) : null;

  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

  return (
    <div className="flex items-center justify-center p-8 min-h-[50vh]">
      <div className="text-center" role="status">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary mx-auto" aria-hidden="true" />
        <p className="mt-4 text-foreground/60">Başlangıç sayfanız açılıyor...</p>
        {target && (
          <Link href={target} replace className="mt-2 inline-block text-sm text-blue-700 underline">
            Açılmazsa buraya tıklayın
          </Link>
        )}
      </div>
    </div>
  );
}
