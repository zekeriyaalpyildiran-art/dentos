import { Sidebar } from "@/components/Sidebar";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { BackupStaleNotice } from "@/components/BackupStaleNotice";

export default function PanelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ProtectedRoute>
      {/* Phones: top bar + scrolling page (menu in a drawer). md and up: fixed sidebar + scrolling page. */}
      <div className="flex h-[100dvh] flex-col md:flex-row bg-background">
        <Sidebar />
        <main className="flex-1 min-h-0 min-w-0 overflow-y-auto">
          {/* Owner only, and only when the nightly backup is overdue or has never run. */}
          <BackupStaleNotice />
          {children}
        </main>
      </div>
    </ProtectedRoute>
  );
}
