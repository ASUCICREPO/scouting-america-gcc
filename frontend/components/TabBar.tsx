"use client";

// Safari-style bottom bar. The center acts as a real link to the official
// Scouting America site rather than decorative, non-functional chrome.
export default function TabBar() {
  return (
    <nav className="tab-bar" aria-label="Scouting.org">
      <a
        className="tab-search-bar"
        href="https://www.scouting.org"
        target="_blank"
        rel="noopener noreferrer"
      >
        Scouting.org
      </a>
    </nav>
  );
}
