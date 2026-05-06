"use client";

import React from "react";

/**
 * Lightweight markdown renderer for LLM output.
 * Handles **bold**, numbered lists, bullet lists, and line breaks.
 */
export default function SimpleMarkdown({ text, className }: { text: string; className?: string }) {
  if (!text) return null;

  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Numbered list: "1. ", "2. " etc
    const olMatch = line.match(/^(\d+)\.\s+(.*)/);
    // Bullet list: "- " or "* "
    const ulMatch = !olMatch && line.match(/^[-*]\s+(.*)/);

    if (olMatch) {
      elements.push(
        <div key={i} className="flex gap-1.5 ml-1">
          <span className="text-gray-400 select-none shrink-0">{olMatch[1]}.</span>
          <span>{renderInline(olMatch[2])}</span>
        </div>
      );
    } else if (ulMatch) {
      elements.push(
        <div key={i} className="flex gap-1.5 ml-1">
          <span className="text-gray-400 select-none shrink-0">&#x2022;</span>
          <span>{renderInline(ulMatch[1])}</span>
        </div>
      );
    } else if (line.trim() === "") {
      elements.push(<div key={i} className="h-2" />);
    } else {
      elements.push(
        <div key={i}>{renderInline(line)}</div>
      );
    }
  }

  return <div className={className}>{elements}</div>;
}

/** Replace **bold** with <strong> tags */
function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  if (parts.length === 1) return text;

  return parts.map((part, i) => {
    const boldMatch = part.match(/^\*\*(.+)\*\*$/);
    if (boldMatch) {
      return <strong key={i} className="font-semibold text-gray-800">{boldMatch[1]}</strong>;
    }
    return <span key={i}>{part}</span>;
  });
}
