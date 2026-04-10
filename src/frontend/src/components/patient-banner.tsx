"use client";

import React from "react";

interface PatientBannerProps {
  summary: string;
}

export function PatientBanner({ summary }: PatientBannerProps) {
  return (
    <div className="mx-6 mt-3 px-4 py-2.5 rounded-xl bg-accent/5 border border-accent/20">
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
        <span className="text-xs font-medium text-accent/80">Patient Context Active</span>
      </div>
      <p className="text-xs text-gray-400 mt-1 leading-relaxed">{summary}</p>
    </div>
  );
}
