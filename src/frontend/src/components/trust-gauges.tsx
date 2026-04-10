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

const DIMENSIONS: { key: keyof TrustScores; label: string; icon: string }[] = [
  { key: "evidence_quality", label: "Evidence", icon: "E" },
  { key: "guideline_alignment", label: "Guidelines", icon: "G" },
  { key: "clinical_relevance", label: "Relevance", icon: "R" },
  { key: "safety_check", label: "Safety", icon: "S" },
  { key: "completeness", label: "Complete", icon: "C" },
  { key: "source_recency", label: "Recency", icon: "T" },
];

function getColor(score: number): string {
  if (score >= 80) return "#22C55E";
  if (score >= 60) return "#EAB308";
  if (score >= 40) return "#F97316";
  return "#EF4444";
}

function SpeedometerGauge({
  score,
  label,
  reason,
}: {
  score: number;
  label: string;
  reason: string;
}) {
  const [hovered, setHovered] = useState(false);
  const color = getColor(score);
  // Arc from -135deg to +135deg (270 degrees total)
  const radius = 28;
  const circumference = (270 / 360) * 2 * Math.PI * radius;
  const filled = (score / 100) * circumference;

  // Arc path (SVG arc from -135 to +135)
  const startAngle = -225;
  const endAngle = startAngle + 270;
  const needleAngle = startAngle + (score / 100) * 270;

  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const cx = 36;
  const cy = 36;

  const arcStart = {
    x: cx + radius * Math.cos(toRad(startAngle)),
    y: cy + radius * Math.sin(toRad(startAngle)),
  };
  const arcEnd = {
    x: cx + radius * Math.cos(toRad(endAngle)),
    y: cy + radius * Math.sin(toRad(endAngle)),
  };
  const arcFilled = {
    x: cx + radius * Math.cos(toRad(needleAngle)),
    y: cy + radius * Math.sin(toRad(needleAngle)),
  };

  const largeArcBg = 1;
  const largeArcFill = score > 50 ? 1 : 0;

  const needleTip = {
    x: cx + (radius - 6) * Math.cos(toRad(needleAngle)),
    y: cy + (radius - 6) * Math.sin(toRad(needleAngle)),
  };

  return (
    <div
      className="relative flex flex-col items-center"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <svg width="72" height="52" viewBox="0 0 72 52">
        {/* Background arc */}
        <path
          d={`M ${arcStart.x} ${arcStart.y} A ${radius} ${radius} 0 ${largeArcBg} 1 ${arcEnd.x} ${arcEnd.y}`}
          fill="none"
          stroke="#333"
          strokeWidth="5"
          strokeLinecap="round"
        />
        {/* Filled arc */}
        {score > 0 && (
          <path
            d={`M ${arcStart.x} ${arcStart.y} A ${radius} ${radius} 0 ${largeArcFill} 1 ${arcFilled.x} ${arcFilled.y}`}
            fill="none"
            stroke={color}
            strokeWidth="5"
            strokeLinecap="round"
          />
        )}
        {/* Needle */}
        <line
          x1={cx}
          y1={cy}
          x2={needleTip.x}
          y2={needleTip.y}
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <circle cx={cx} cy={cy} r="2.5" fill={color} />
        {/* Score text */}
        <text
          x={cx}
          y={cy + 14}
          textAnchor="middle"
          fill={color}
          fontSize="11"
          fontWeight="700"
          fontFamily="var(--font-manrope)"
        >
          {score}
        </text>
      </svg>
      <span className="text-[10px] text-gray-400 -mt-1">{label}</span>

      {/* Hover tooltip with reasoning */}
      {hovered && reason && (
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-50 w-56 px-3 py-2 rounded-lg bg-surface border border-border/50 shadow-xl">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-xs font-semibold" style={{ color }}>
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
    <div className="p-3 rounded-xl bg-surface border border-border/20">
      {/* Overall score */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xl font-bold" style={{ color: overallColor }}>
            {overall}
          </span>
          <span className="text-[10px] text-gray-500 uppercase tracking-wider">
            Trust Score
          </span>
        </div>
        <span className="text-[9px] text-gray-600">
          Confidence: {scorerConfidence}%
        </span>
      </div>

      {/* Individual gauges */}
      <div className="grid grid-cols-3 gap-2">
        {DIMENSIONS.map(({ key, label }) => (
          <SpeedometerGauge
            key={key}
            score={scores[key]}
            label={label}
            reason={reasons[key] || ""}
          />
        ))}
      </div>
    </div>
  );
}
