import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GCC Admin Dashboard",
  description: "Grand Canyon Council - Admin Dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
