"use client";

import React, { useState } from "react";

interface PatientBannerProps {
  summary: string;
}

export function PatientBanner({ summary }: PatientBannerProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mx-6 mt-3 rounded-xl bg-accent/5 border border-accent/20 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-accent/5 transition-colors cursor-pointer"
      >
        <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" />
        <span className="text-[11px] font-medium text-accent/80">Patient Context Active</span>
        <span className="text-[10px] text-accent/50 ml-auto">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div className="max-h-[200px] overflow-y-auto px-3 pb-2 scrollbar-thin scrollbar-thumb-accent/20">
          <p className="text-[11px] text-gray-400 leading-relaxed break-words whitespace-pre-wrap">{summary}</p>
        </div>
      )}
    </div>
  );
}
