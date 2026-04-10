"use client";

import React, { useState } from "react";
import { RadarChart } from "./radar-chart";
import { LatexRenderer } from "./latex-renderer";

interface TrustScores {
  evidence_quality: number;
  guideline_alignment: number;
  clinical_relevance: number;
  safety_check: number;
  completeness: number;
  source_recency: number;
}

interface Guideline {
  title: string;
  source: string;
  country: string;
  year?: number;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  fast_answer?: string;
  complete_answer?: string;
  trust_scores?: TrustScores;
  guidelines_used?: Guideline[];
  agents_used?: string[];
  timestamp: number;
}

const COUNTRY_LABELS: Record<string, string> = {
  USA: "USA", UK: "UK", Europe: "EU", Turkey: "TR", WHO: "WHO",
};

export function MessageBubble({ message }: { message: Message }) {
  const [mode, setMode] = useState<"fast" | "complete">("fast");

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent/90 px-4 py-2.5 text-sm text-white">
          {message.content}
        </div>
      </div>
    );
  }

  const hasDualMode = message.fast_answer && message.complete_answer;
  const displayContent = hasDualMode
    ? mode === "fast" ? message.fast_answer! : message.complete_answer!
    : message.content;

  const hasLatex = displayContent.includes("$$");

  return (
    <div className="flex flex-col gap-3 max-w-full">
      <div className="rounded-2xl rounded-bl-md bg-surface-light border border-border/30 px-4 py-3">
        {/* Mode tabs */}
        {hasDualMode && (
          <div className="flex gap-1 mb-3 p-0.5 bg-surface rounded-lg w-fit">
            <button
              onClick={() => setMode("fast")}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                mode === "fast"
                  ? "bg-accent text-white"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              Fast
            </button>
            <button
              onClick={() => setMode("complete")}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                mode === "complete"
                  ? "bg-accent text-white"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              Complete
            </button>
          </div>
        )}

        {/* Answer content — with LaTeX rendering */}
        <div className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">
          {hasLatex ? <LatexRenderer content={displayContent} /> : displayContent}
        </div>

        {/* Guidelines used */}
        {message.guidelines_used && message.guidelines_used.length > 0 && (
          <div className="mt-3 pt-3 border-t border-border/30">
            <p className="text-xs text-gray-500 mb-1.5">Guidelines referenced:</p>
            <div className="flex flex-wrap gap-1.5">
              {message.guidelines_used.map((g, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface text-xs text-gray-400 border border-border/30"
                >
                  <span className="font-semibold text-accent/70">
                    {COUNTRY_LABELS[g.country] || g.country}
                  </span>
                  {g.source} {g.year && `(${g.year})`}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Agents used */}
        {message.agents_used && message.agents_used.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {message.agents_used.map((a, i) => (
              <span
                key={i}
                className="px-1.5 py-0.5 rounded text-[10px] text-gray-500 bg-surface border border-border/20"
              >
                {a}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Radar chart */}
      {message.trust_scores && (
        <div className="ml-2">
          <RadarChart scores={message.trust_scores} />
        </div>
      )}
    </div>
  );
}
