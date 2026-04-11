"use client";

import React, { useState } from "react";

interface TrustScores {
  evidence_quality: number;
  guideline_alignment: number;
  clinical_relevance: number;
  safety_check: number;
  completeness: number;
  source_recency: number;
}

interface TrustReasons {
  evidence_quality: string;
  guideline_alignment: string;
  clinical_relevance: string;
  safety_check: string;
  completeness: string;
  source_recency: string;
}

interface TrustGaugesProps {
  scores: TrustScores;
  reasons: TrustReasons;
  scorerConfidence: number;
}

const DIMENSIONS: { key: keyof TrustScores; label: string }[] = [
  { key: "evidence_quality", label: "Evidence" },
  { key: "guideline_alignment", label: "Guidelines" },
  { key: "clinical_relevance", label: "Relevance" },
  { key: "safety_check", label: "Safety" },
  { key: "completeness", label: "Complete" },
  { key: "source_recency", label: "Recency" },
];

function getColor(score: number): string {
  if (score >= 80) return "#22C55E";
  if (score >= 60) return "#EAB308";
  if (score >= 40) return "#F97316";
  return "#EF4444";
}

function getGradient(score: number): [string, string] {
  if (score >= 80) return ["#22C55E", "#16A34A"];
  if (score >= 60) return ["#EAB308", "#CA8A04"];
  if (score >= 40) return ["#F97316", "#EA580C"];
  return ["#EF4444", "#DC2626"];
}

function RingGauge({
  score,
  label,
  reason,
  colIndex,
}: {
  score: number;
  label: string;
  reason: string;
  colIndex: number;
}) {
  const [hovered, setHovered] = useState(false);
  const color = getColor(score);
  const [gradStart, gradEnd] = getGradient(score);

  const radius = 24;
  const strokeWidth = 4;
  const circumference = 2 * Math.PI * radius;
  const filled = (score / 100) * circumference;
  const cx = 30;
  const cy = 30;
  const gradId = `ring-${label.replace(/\s/g, "")}`;

  // Position tooltip based on column to prevent overflow
  const tooltipAlign =
    colIndex === 0
      ? "left-0"
      : colIndex === 2
        ? "right-0"
        : "left-1/2 -translate-x-1/2";

  return (
    <div
      className="relative flex flex-col items-center gap-1"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <svg width="60" height="60" viewBox="0 0 60 60">
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={gradStart} />
            <stop offset="100%" stopColor={gradEnd} />
          </linearGradient>
        </defs>
        {/* Background ring */}
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke="#2A2A2E"
          strokeWidth={strokeWidth}
        />
        {/* Filled ring */}
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference - filled}`}
          strokeDashoffset={circumference * 0.25}
          style={{ transition: "stroke-dasharray 0.8s ease" }}
        />
        {/* Score text — uses same gradient as the ring arc */}
        <text
          x={cx}
          y={cy + 1}
          textAnchor="middle"
          dominantBaseline="middle"
          fill={`url(#${gradId})`}
          fontSize="13"
          fontWeight="700"
          fontFamily="var(--font-manrope)"
        >
          {score}
        </text>
      </svg>
      <span className="text-[10px] text-gray-400 font-medium">{label}</span>

      {/* Hover tooltip with reasoning — positioned by column to avoid overflow */}
      {hovered && reason && (
        <div className={`absolute bottom-full mb-2 z-50 w-56 px-3 py-2 rounded-lg bg-[#1a1a2e] border border-border/50 shadow-xl ${tooltipAlign}`}>
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-xs font-bold" style={{ color }}>
              {score}/100
            </span>
            <span className="text-[10px] text-gray-400">{label}</span>
          </div>
          <p className="text-[11px] text-gray-300 leading-relaxed">{reason}</p>
        </div>
      )}
    </div>
  );
}

export function TrustGauges({ scores, reasons, scorerConfidence }: TrustGaugesProps) {
  const overall = Math.round(
    Object.values(scores).reduce((a, b) => a + b, 0) / Object.values(scores).length
  );
  const overallColor = getColor(overall);

  return (
    <div className="flex-1 min-w-[240px]">
      {/* Overall score header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-2xl font-bold" style={{ color: overallColor }}>
            {overall}
          </span>
          <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">
            Trust Score
          </span>
        </div>
        <span className="text-[10px] text-gray-600 font-medium">
          Confidence: {scorerConfidence}%
        </span>
      </div>

      {/* Ring gauges grid */}
      <div className="grid grid-cols-3 gap-3">
        {DIMENSIONS.map(({ key, label }, idx) => (
          <RingGauge
            key={key}
            score={scores[key]}
            label={label}
            reason={reasons[key] || ""}
            colIndex={idx % 3}
          />
        ))}
      </div>
    </div>
  );
}
