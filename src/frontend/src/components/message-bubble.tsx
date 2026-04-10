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
  url?: string;
}

interface Citation {
  index: number;
  title: string;
  source: string;
  country: string;
  year?: number;
  url?: string;
  quote: string;
}

interface AgentTiming {
  agent: string;
  time_ms: number;
  input_tokens: number;
  output_tokens: number;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  fast_answer?: string;
  complete_answer?: string;
  trust_scores?: TrustScores;
  guidelines_used?: Guideline[];
  citations?: Citation[];
  agents_used?: string[];
  agent_timings?: AgentTiming[];
  total_time_ms?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  timestamp: number;
}

const COUNTRY_FLAGS: Record<string, string> = {
  USA: "US",
  UK: "GB",
  Europe: "EU",
  Turkey: "TR",
  WHO: "UN",
};

const COUNTRY_LABELS: Record<string, string> = {
  USA: "USA",
  UK: "UK",
  Europe: "EU",
  Turkey: "TR",
  WHO: "WHO",
};

export function MessageBubble({ message }: { message: Message }) {
  const [mode, setMode] = useState<"fast" | "complete">("fast");
  const [showCitations, setShowCitations] = useState(false);

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
    ? mode === "fast"
      ? message.fast_answer!
      : message.complete_answer!
    : message.content;

  const hasLatex = displayContent.includes("$$");
  const hasCitations =
    message.citations && message.citations.length > 0;
  const hasGuidelines =
    message.guidelines_used && message.guidelines_used.length > 0;

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

        {/* Answer content */}
        <div className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">
          {hasLatex ? (
            <LatexRenderer content={displayContent} />
          ) : (
            displayContent
          )}
        </div>

        {/* Guidelines used */}
        {hasGuidelines && (
          <div className="mt-3 pt-3 border-t border-border/30">
            <p className="text-xs text-gray-500 mb-1.5">
              Guidelines referenced:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {message.guidelines_used!.map((g, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface text-xs text-gray-400 border border-border/30"
                >
                  <span className="font-semibold text-accent/70">
                    {COUNTRY_LABELS[g.country] || g.country}
                  </span>
                  <span className="truncate max-w-[200px]">
                    {g.source}
                  </span>
                  {g.year && (
                    <span className="text-gray-500">({g.year})</span>
                  )}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Citations */}
        {hasCitations && (
          <div className="mt-2 pt-2 border-t border-border/20">
            <button
              onClick={() => setShowCitations(!showCitations)}
              className="text-[11px] text-accent/70 hover:text-accent transition-colors flex items-center gap-1"
            >
              <span>{showCitations ? "Hide" : "Show"} citations ({message.citations!.length})</span>
              <span className="text-[10px]">{showCitations ? "\u25B2" : "\u25BC"}</span>
            </button>
            {showCitations && (
              <div className="mt-2 space-y-1.5">
                {message.citations!.map((c) => (
                  <div
                    key={c.index}
                    className="flex gap-2 text-[11px] text-gray-400 px-2 py-1.5 rounded-lg bg-surface/50"
                  >
                    <span className="text-accent/60 font-bold shrink-0">
                      [{c.index}]
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-medium text-gray-300">
                          {c.source}
                        </span>
                        <span className="px-1 py-0 rounded bg-accent/10 text-accent/70 text-[9px] font-semibold">
                          {COUNTRY_LABELS[c.country] || c.country}
                        </span>
                        {c.year && (
                          <span className="text-gray-500">{c.year}</span>
                        )}
                      </div>
                      <div className="text-gray-500 mt-0.5 truncate">
                        {c.title}
                      </div>
                      {c.quote && (
                        <div className="text-gray-500 mt-0.5 italic text-[10px] line-clamp-2">
                          {c.quote}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
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

        {/* Timing stats */}
        {message.total_time_ms != null && message.total_time_ms > 0 && (
          <div className="mt-2 pt-2 border-t border-border/20 flex items-center gap-3 text-[10px] text-gray-600">
            <span>
              {message.total_time_ms < 1000
                ? `${message.total_time_ms}ms`
                : `${(message.total_time_ms / 1000).toFixed(1)}s`}
            </span>
            {(message.total_input_tokens ?? 0) > 0 && (
              <span>
                {(
                  (message.total_input_tokens ?? 0) +
                  (message.total_output_tokens ?? 0)
                ).toLocaleString()}{" "}
                tokens
              </span>
            )}
          </div>
        )}
      </div>

      {/* Radar chart — always show when trust scores exist */}
      {message.trust_scores && (
        <div className="ml-2">
          <RadarChart scores={message.trust_scores} />
        </div>
      )}
    </div>
  );
}
