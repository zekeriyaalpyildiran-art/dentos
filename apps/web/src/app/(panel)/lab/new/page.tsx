"use client";

// Yeni lab işi (spec p9_clinical §7.7): one atomic clin_lab_order_save call.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { istanbulToday } from "@/lib/clinical/dates";
import { LabForm } from "@/components/clinical/LabForm";

export default function NewLabOrderPage() {
  const router = useRouter();
  return (
    <div className="p-4 md:p-8 max-w-4xl space-y-4">
      <Link href="/lab" className="text-blue-600 hover:underline text-sm">
        ← Laboratuvar işleri
      </Link>
      <h1 className="text-2xl md:text-3xl font-bold text-gray-900">Yeni lab işi</h1>
      <LabForm today={istanbulToday()} cancelHref="/lab" onSaved={(order) => router.push(`/lab/${order.id}`)} />
    </div>
  );
}
