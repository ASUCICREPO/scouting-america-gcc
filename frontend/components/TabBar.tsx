"use client";

import { Home, Search, Bell, User } from "lucide-react";

const TABS = [
  { icon: Home, label: "Home", active: true },
  { icon: Search, label: "Search", active: false },
  { icon: Bell, label: "Alerts", active: false },
  { icon: User, label: "Profile", active: false },
];

export default function TabBar() {
  return (
    <nav className="tab-bar" aria-label="Main navigation">
      {TABS.map((tab) => {
        const Icon = tab.icon;
        return (
          <button
            key={tab.label}
            className={`tab-item ${tab.active ? "active" : ""}`}
            aria-label={tab.label}
            aria-current={tab.active ? "page" : undefined}
          >
            <Icon size={20} />
            <span className="tab-label">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
