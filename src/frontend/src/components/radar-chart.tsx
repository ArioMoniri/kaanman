"use client";

import React from "react";
import {
  Radar,
  RadarChart as RechartsRadar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

interface TrustScores {
  evidence_quality: number;
  guideline_alignment: number;
  clinical_relevance: number;
  safety_check: number;
  completeness: number;
  source_recency: number;
}

const LABELS: Record<string, string> = {
  evidence_quality: "Evidence",
  guideline_alignment: "Guidelines",
  clinical_relevance: "Relevance",
  safety_check: "Safety",
  completeness: "Completeness",
  source_recency: "Recency",
};

function getOverallScore(scores: TrustScores): number {
  const values = Object.values(scores);
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function getScoreColor(score: number): string {
  if (score >= 80) return "#22C55E";
  if (score >= 60) return "#EAB308";
  return "#EF4444";
}

export function RadarChart({ scores }: { scores: TrustScores }) {
  const data = Object.entries(scores).map(([key, value]) => ({
    dimension: LABELS[key] || key,
    score: value,
    fullMark: 100,
  }));

  const overall = getOverallScore(scores);
  const color = getScoreColor(overall);

  return (
    <div className="flex items-center gap-3">
      <div className="w-[180px] h-[140px]">
        <ResponsiveContainer width="100%" height="100%">
          <RechartsRadar data={data} cx="50%" cy="50%" outerRadius="70%">
            <PolarGrid stroke="#333" strokeDasharray="3 3" />
            <PolarAngleAxis
              dataKey="dimension"
              tick={{ fill: "#9CA3AF", fontSize: 9 }}
            />
            <PolarRadiusAxis
              angle={90}
              domain={[0, 100]}
              tick={false}
              axisLine={false}
            />
            <Radar
              dataKey="score"
              stroke={color}
              fill={color}
              fillOpacity={0.15}
              strokeWidth={1.5}
            />
            <Tooltip
              contentStyle={{
                background: "#1F2023",
                border: "1px solid #444",
                borderRadius: "8px",
                fontSize: "12px",
                color: "#E5E7EB",
              }}
            />
          </RechartsRadar>
        </ResponsiveContainer>
      </div>

      <div className="flex flex-col items-center gap-1">
        <div className="text-2xl font-bold" style={{ color }}>
          {overall}
        </div>
        <div className="text-[10px] text-gray-500 uppercase tracking-wider">
          Trust Score
        </div>
      </div>
    </div>
  );
}
