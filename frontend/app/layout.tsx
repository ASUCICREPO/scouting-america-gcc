import type { Metadata, Viewport } from "next";
import { LanguageProvider } from "@/context/LanguageContext";
import "./globals.css";

export const metadata: Metadata = {
  title: "Scouting America AI Assistant",
  description: "AI-powered assistant for Scouting America - Get help with joining, volunteering, events, and more.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Scout AI",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#003B75",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="apple-touch-icon" href="/icons/icon-192x192.png" />
      </head>
      <body>
        <LanguageProvider>{children}</LanguageProvider>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                var isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
                if (isLocal) {
                  // Dev: never cache — unregister any existing SW and clear caches
                  // so code/env changes always take effect (no stale bundles).
                  navigator.serviceWorker.getRegistrations().then(function (rs) {
                    rs.forEach(function (r) { r.unregister(); });
                  });
                  if (window.caches) {
                    caches.keys().then(function (ks) { ks.forEach(function (k) { caches.delete(k); }); });
                  }
                } else {
                  window.addEventListener('load', function () {
                    navigator.serviceWorker.register('/sw.js');
                  });
                }
              }
            `,
          }}
        />
      </body>
    </html>
  );
}
