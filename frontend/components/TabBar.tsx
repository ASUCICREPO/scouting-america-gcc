"use client";

import { ChevronLeft, MoreHorizontal } from "lucide-react";

export default function TabBar() {
  return (
    <nav className="tab-bar" aria-label="Navigation">
      <button className="tab-btn" aria-label="Back">
        <ChevronLeft size={20} />
      </button>
      <div className="tab-search-bar">
        Scouting.org
      </div>
      <button className="tab-btn" aria-label="More">
        <MoreHorizontal size={20} />
      </button>
    </nav>
  );
}
