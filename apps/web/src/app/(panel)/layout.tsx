import { Sidebar } from "@/components/Sidebar";
import { ProtectedRoute } from "@/components/ProtectedRoute";

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
        <main className="flex-1 min-h-0 min-w-0 overflow-y-auto">{children}</main>
      </div>
    </ProtectedRoute>
  );
}
