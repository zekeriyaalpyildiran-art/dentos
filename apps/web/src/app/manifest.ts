import type { MetadataRoute } from "next";

// Web app manifest so staff can use "Ana ekrana ekle" on their phones. No service worker: the app needs the network
// for every screen anyway, and nothing is cached on the device.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "DentOS",
    short_name: "DentOS",
    description: "Diş kliniği işletim sistemi",
    lang: "tr",
    dir: "ltr",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
