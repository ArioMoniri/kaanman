"use client";

import React, { useMemo } from "react";

let katex: typeof import("katex") | null = null;
if (typeof window !== "undefined") {
  try {
    katex = require("katex");
  } catch {
    // katex not loaded
  }
}

/**
 * Renders text that may contain LaTeX blocks delimited by $$ ... $$.
 * Non-LaTeX text is rendered as-is. LaTeX blocks are rendered via KaTeX.
 */
export function LatexRenderer({ content }: { content: string }) {
  const parts = useMemo(() => {
    if (!content) return [];
    // Split on $$ delimiters — odd indices are LaTeX
    return content.split(/\$\$([\s\S]*?)\$\$/g);
  }, [content]);

  if (parts.length <= 1) {
    // No LaTeX found
    return <span>{content}</span>;
  }

  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) {
          // Plain text
          return <span key={i}>{part}</span>;
        }
        // LaTeX block
        if (!katex) {
          // Fallback if katex not available
          return (
            <code key={i} className="block bg-surface/50 p-2 my-2 rounded text-sm text-accent font-mono overflow-x-auto">
              {part.trim()}
            </code>
          );
        }
        try {
          const html = katex.renderToString(part.trim(), {
            displayMode: true,
            throwOnError: false,
            output: "html",
          });
          return (
            <div
              key={i}
              className="my-2 overflow-x-auto"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          );
        } catch {
          return (
            <code key={i} className="block bg-surface/50 p-2 my-2 rounded text-sm text-red-400 font-mono">
              {part.trim()}
            </code>
          );
        }
      })}
    </>
  );
}
