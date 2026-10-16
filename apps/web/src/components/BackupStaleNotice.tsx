"use client";

// Small amber notice above every panel page, for the clinic owner only, when the nightly backup is overdue (> 36 h)
// or has never run (describeBackupNotice). GitHub e-mails only when a run fails, not when no run happens at all
// (schedule disabled, Actions blocked, account trouble), and the owner rarely opens Ayarlar → Veri yedeği, so this is
// the only place such a silent stop would show. One backup_status call per owner per page load: the panel layout
// stays mounted while moving between pages. Hidden on the export page itself, which shows the full box.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import { useAuthStore } from "@/lib/store";
import {
  BACKUP_STATUS_HREF,
  describeBackupNotice,
  fetchBackupStatus,
  type BackupNotice,
  type BackupStatusResult,
} from "@/lib/backup";

/** Per owner: the status request of this page load (fetchBackupStatus never rejects). */
const statusRequests = new Map<string, Promise<BackupStatusResult>>();
/** Per owner: closed with × in this page load. */
const dismissedFor = new Set<string>();

export function BackupStaleNotice() {
  const user = useAuthStore((state) => state.user);
  const pathname = usePathname();
  const ownerId = user?.role === "owner" ? user.user_id : null;
  const [notice, setNotice] = useState<BackupNotice | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setNotice(null);
    if (!ownerId) return;
    setDismissed(dismissedFor.has(ownerId));
    let request = statusRequests.get(ownerId);
    if (!request) {
      request = fetchBackupStatus(createClient());
      statusRequests.set(ownerId, request);
    }
    let alive = true;
    request.then((result) => {
      if (alive) setNotice(describeBackupNotice(result));
    });
    return () => {
      alive = false;
    };
  }, [ownerId]);

  if (!ownerId || !notice || dismissed || pathname === BACKUP_STATUS_HREF) return null;

  return (
    <div
      role="status"
      className="flex items-start gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900"
    >
      <p className="min-w-0 flex-1 py-1">
        <span aria-hidden="true">⚠️ </span>
        <span className="font-semibold">{notice.text}</span>{" "}
        <Link href={notice.href} className="underline underline-offset-2 hover:no-underline">
          {notice.linkText}
        </Link>
      </p>
      <button
        type="button"
        onClick={() => {
          dismissedFor.add(ownerId);
          setDismissed(true);
        }}
        aria-label="Yedek uyarısını kapat"
        title="Kapat (sayfa yenilenince yeniden görünür)"
        className="-my-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg hover:bg-amber-100"
      >
        <span aria-hidden="true" className="text-lg leading-none">
          ×
        </span>
      </button>
    </div>
  );
}
