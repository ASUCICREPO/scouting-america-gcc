import type { Metadata } from "next";
import { SettingsProvider } from "../lib/settings-context";
import "./globals.css";

export const metadata: Metadata = {
  title: "GCC Admin Dashboard",
  description: "Grand Canyon Council - Admin Dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SettingsProvider>
          {children}
        </SettingsProvider>
      </body>
    </html>
  );
}
