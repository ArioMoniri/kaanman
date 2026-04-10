"use client";

import React, { useState, useRef, useEffect } from "react";
import { Badge } from "./ui/badge";

const LEGEND_ITEMS = [
  { variant: "green" as const, label: "High impact", desc: "Primary source, directly shaped the answer" },
  { variant: "blue" as const, label: "Moderate impact", desc: "Supporting evidence, corroborates key points" },
  { variant: "purple-subtle" as const, label: "Contextual", desc: "Background information, adds context" },
  { variant: "gray-subtle" as const, label: "Low impact", desc: "Minor reference, tangential relevance" },
  { variant: "amber" as const, label: "Priority country", desc: "From the detected language/country guidelines" },
  { variant: "teal-subtle" as const, label: "WHO / International", desc: "World Health Organization guidelines" },
];

export function ReferenceLegend() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors px-2.5 py-1.5 rounded-lg border border-border/40 hover:border-border/70 bg-surface flex items-center gap-1.5"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 2.5a1 1 0 110 2 1 1 0 010-2zM6.5 7h2v5h-2V7h1z" />
        </svg>
        Legend
        <span className="text-[9px]">{open ? "\u25B2" : "\u25BC"}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-72 rounded-xl bg-[#1F2023] border border-[#444]/40 shadow-2xl p-3">
          <p className="text-[11px] text-gray-400 font-semibold mb-2 uppercase tracking-wider">
            Reference Effect Size
          </p>
          <div className="space-y-2">
            {LEGEND_ITEMS.map((item) => (
              <div key={item.label} className="flex items-start gap-2">
                <Badge variant={item.variant} size="sm" className="mt-0.5 shrink-0">
                  {item.label}
                </Badge>
                <span className="text-[10px] text-gray-500 leading-relaxed">
                  {item.desc}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
