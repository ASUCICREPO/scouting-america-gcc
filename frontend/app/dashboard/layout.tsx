import type { Metadata } from "next";
import { SettingsProvider } from "@/lib/dashboard/settings-context";
import { Toaster } from "@/components/ui/sonner";
import DashboardShell from "./DashboardShell";
import "./dashboard.css";

export const metadata: Metadata = {
  title: "GCC Admin Dashboard",
  description: "Grand Canyon Council — Admin Dashboard",
};

// Admin dashboard segment layout: provides the settings context (theme/profile)
// and the scoped dashboard stylesheet, then renders the authenticated shell
// (sidebar + header). The public chat at "/" is unaffected.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <SettingsProvider>
      <DashboardShell>{children}</DashboardShell>
      <Toaster />
    </SettingsProvider>
  );
}
