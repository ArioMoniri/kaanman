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
 * Renders LaTeX content. Supports both display ($$ ... $$) and inline ($ ... $) modes.
 * If the content is wrapped in $$ it's display mode, if in $ it's inline.
 * Can also handle mixed content with LaTeX interspersed in text.
 */
export function LatexRenderer({ content }: { content: string }) {
  const rendered = useMemo(() => {
    if (!content) return null;

    // Determine if this is a single LaTeX expression already delimited
    const isDisplay = content.startsWith("$$") && content.endsWith("$$");
    const isInline = !isDisplay && content.startsWith("$") && content.endsWith("$") && !content.startsWith("$$");

    if (isDisplay || isInline) {
      // Strip delimiters
      const latex = isDisplay
        ? content.slice(2, -2).trim()
        : content.slice(1, -1).trim();

      if (!katex) {
        return isDisplay ? (
          <code className="block bg-surface/50 p-2 my-2 rounded text-sm text-accent font-mono overflow-x-auto">
            {latex}
          </code>
        ) : (
          <code className="bg-surface/50 text-accent px-1 py-0.5 rounded text-sm font-mono">
            {latex}
          </code>
        );
      }

      try {
        const html = katex.renderToString(latex, {
          displayMode: isDisplay,
          throwOnError: false,
          output: "html",
        });
        return isDisplay ? (
          <div className="my-2 overflow-x-auto" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <span className="inline" dangerouslySetInnerHTML={{ __html: html }} />
        );
      } catch {
        return (
          <code className={`${isDisplay ? "block p-2 my-2" : "px-1 py-0.5"} bg-surface/50 rounded text-sm text-red-400 font-mono`}>
            {latex}
          </code>
        );
      }
    }

    // Fallback: split on $$ delimiters for mixed content
    const parts = content.split(/\$\$([\s\S]*?)\$\$/g);
    if (parts.length <= 1) {
      return <span>{content}</span>;
    }

    return (
      <>
        {parts.map((part, i) => {
          if (i % 2 === 0) return <span key={i}>{part}</span>;
          if (!katex) {
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
            return <div key={i} className="my-2 overflow-x-auto" dangerouslySetInnerHTML={{ __html: html }} />;
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
  }, [content]);

  return <>{rendered}</>;
}
