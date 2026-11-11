"use client";

/**
 * Tedavi planı sunum programı (owner's standalone tool, 2026-11-11), served as static files from
 * public/sunum-programi and shown here in a frame. Its patients are kept in this browser's localStorage
 * ('kp_sunum_v1'), not in the database; 'Yedekle' / 'Yükle' inside the program move them between devices.
 */
export default function SunumPage() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
        <span>Sunum verileri bu cihazın tarayıcısında saklanır; başka cihaza geçmek için programdaki Yedekle / Yükle.</span>
        <a href="/sunum-programi/index.html" target="_blank" rel="noopener" className="shrink-0 underline">
          Yeni sekmede aç
        </a>
      </div>
      <iframe
        src="/sunum-programi/index.html"
        title="Tedavi planı sunumu"
        className="w-full flex-1 border-0"
        allow="fullscreen"
        allowFullScreen
      />
    </div>
  );
}
