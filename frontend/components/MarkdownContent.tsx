"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownContentProps {
  content: string;
  className?: string;
}

// Renders assistant message text as structured markdown (headings, lists, bold,
// links, tables, code) instead of a raw text blob. Styling lives in globals.css
// under `.markdown-content` so it matches the rest of the design system.
export default function MarkdownContent({
  content,
  className = "",
}: MarkdownContentProps) {
  if (!content) return null;

  return (
    <div className={`markdown-content ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Open links in a new tab safely
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
