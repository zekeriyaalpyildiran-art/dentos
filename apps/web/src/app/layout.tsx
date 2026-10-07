import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DentOS",
  description: "Diş kliniği işletim sistemi",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
