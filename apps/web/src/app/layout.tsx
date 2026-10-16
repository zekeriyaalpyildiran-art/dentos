import type { Metadata, Viewport } from "next";
import { AuthProvider } from "@/components/AuthProvider";
import { ThemeSync } from "@/components/ThemeSwitch";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "DentOS",
  description: "Diş kliniği işletim sistemi",
  // Kept out of search engines (also robots.txt and the X-Robots-Tag header in next.config.js).
  robots: { index: false, follow: false },
  applicationName: "DentOS",
  // Home-screen install on iPhone (Safari ignores most of the web manifest).
  appleWebApp: { capable: true, title: "DentOS", statusBarStyle: "default" },
  icons: {
    icon: [
      { url: "/icons/icon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The mobile top bar and the sidebar are the clinic navy in both themes, so the browser bar matches it in both.
  themeColor: "#102e3b",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // The init script adds the 'dark' class before hydration, hence suppressHydrationWarning on <html> (only).
    <html lang="tr" suppressHydrationWarning>
      <head>
        {/* Light / dark before the first paint (lib/theme.ts). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <ThemeSync />
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
