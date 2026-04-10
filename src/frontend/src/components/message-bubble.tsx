"use client";

import React, { useState } from "react";
import { TrustGauges } from "./trust-gauges";
import { RadarChart } from "./radar-chart";
import { Badge, type BadgeVariant } from "./ui/badge";
import { LatexRenderer } from "./latex-renderer";

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

interface DecisionTreeData {
  title: string;
  nodes: { id: string; type?: string; data: Record<string, unknown>; position: Record<string, unknown> }[];
  edges: { id: string; source: string; target: string; label?: string }[];
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  fast_answer?: string;
  complete_answer?: string;
  trust_scores?: TrustScores;
  trust_reasons?: TrustReasons;
  scorer_confidence?: number;
  guidelines_used?: Guideline[];
  citations?: Citation[];
  agents_used?: string[];
  agent_timings?: AgentTiming[];
  total_time_ms?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  decision_tree?: DecisionTreeData;
  language?: string;
  priority_country?: string;
  timestamp: number;
}

const COUNTRY_LABELS: Record<string, string> = {
  USA: "USA",
  UK: "UK",
  Europe: "EU",
  Turkey: "TR",
  WHO: "WHO",
};

const COUNTRY_FLAGS: Record<string, string> = {
  USA: "\u{1F1FA}\u{1F1F8}",
  UK: "\u{1F1EC}\u{1F1E7}",
  Europe: "\u{1F1EA}\u{1F1FA}",
  Turkey: "\u{1F1F9}\u{1F1F7}",
  WHO: "\u{1F3E5}",
};

/** Determine badge variant based on effect size heuristic */
function getEffectBadgeVariant(
  citation: Citation,
  index: number,
  total: number,
  priorityCountry?: string
): BadgeVariant {
  // WHO always gets teal
  if (citation.country === "WHO") return "teal-subtle";
  // Priority country gets amber
  if (priorityCountry && citation.country === priorityCountry) return "amber";
  // Effect size: top third = high, middle = moderate, bottom = low
  const position = index / Math.max(total, 1);
  const hasQuote = citation.quote && citation.quote.length > 20;
  if (position < 0.33 || (position < 0.5 && hasQuote)) return "green";
  if (position < 0.66) return "blue";
  if (hasQuote) return "purple-subtle";
  return "gray-subtle";
}

/** Render markdown-like bold (**text**) and bullet points */
function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];

  lines.forEach((line, lineIdx) => {
    const parts = line.split(/(\*\*[^*]+\*\*)/g);
    const rendered = parts.map((part, i) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return (
          <strong key={i} className="text-gray-100 font-semibold">
            {part.slice(2, -2)}
          </strong>
        );
      }
      return part;
    });

    elements.push(
      <React.Fragment key={lineIdx}>
        {rendered}
        {lineIdx < lines.length - 1 && "\n"}
      </React.Fragment>
    );
  });

  return elements;
}

interface MessageBubbleProps {
  message: Message;
  onOpenDecisionTree?: (tree: DecisionTreeData) => void;
  onOpenKnowledgeGraph?: () => void;
  onOpenReferences?: () => void;
  hasPatientData?: boolean;
}

export function MessageBubble({
  message,
  onOpenDecisionTree,
  onOpenKnowledgeGraph,
  onOpenReferences,
  hasPatientData,
}: MessageBubbleProps) {
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
  const hasCitations = message.citations && message.citations.length > 0;
  const hasGuidelines =
    message.guidelines_used && message.guidelines_used.length > 0;
  const hasDecisionTree =
    message.decision_tree &&
    message.decision_tree.nodes &&
    message.decision_tree.nodes.length > 0;

  const priorityCountry = message.priority_country;
  const countryFlag = priorityCountry ? COUNTRY_FLAGS[priorityCountry] : null;

  return (
    <div className="flex flex-col gap-3 max-w-full">
      <div className="rounded-2xl rounded-bl-md bg-surface-light border border-border/30 px-4 py-3">
        {/* Country / Language header */}
        {countryFlag && priorityCountry && (
          <div className="flex items-center gap-1.5 mb-2 text-[11px] text-gray-400">
            <span className="text-base">{countryFlag}</span>
            <span>Priority: {COUNTRY_LABELS[priorityCountry] || priorityCountry} guidelines</span>
          </div>
        )}

        {/* Mode tabs + action buttons row */}
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          {hasDualMode ? (
            <div className="flex gap-1 p-0.5 bg-surface rounded-lg w-fit">
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
          ) : (
            <div />
          )}

          <div className="flex items-center gap-1.5">
            {hasDecisionTree && onOpenDecisionTree && (
              <button
                onClick={() => onOpenDecisionTree(message.decision_tree!)}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-accent/10 text-accent/80 hover:bg-accent/20 hover:text-accent border border-accent/20 transition-all"
              >
                <span>&#9670;</span> Decision Tree
              </button>
            )}
            {hasPatientData && onOpenKnowledgeGraph && (
              <button
                onClick={onOpenKnowledgeGraph}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-emerald-500/10 text-emerald-400/80 hover:bg-emerald-500/20 hover:text-emerald-400 border border-emerald-500/20 transition-all"
              >
                <span>&#9675;</span> Knowledge Graph
              </button>
            )}
            {hasCitations && onOpenReferences && (
              <button
                onClick={onOpenReferences}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-blue-500/10 text-blue-400/80 hover:bg-blue-500/20 hover:text-blue-400 border border-blue-500/20 transition-all"
              >
                <span>&#9741;</span> References
              </button>
            )}
          </div>
        </div>

        {/* Answer content */}
        <div className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">
          {hasLatex ? (
            <LatexRenderer content={displayContent} />
          ) : (
            renderMarkdown(displayContent)
          )}
        </div>

        {/* Guidelines as effect-size badges */}
        {hasGuidelines && (
          <div className="mt-3 pt-3 border-t border-border/30">
            <p className="text-xs text-gray-500 mb-1.5">
              Guidelines referenced:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {message.guidelines_used!.map((g, i) => {
                let variant: BadgeVariant = "blue-subtle";
                if (g.country === "WHO") variant = "teal-subtle";
                else if (priorityCountry && g.country === priorityCountry)
                  variant = "amber";
                else if (i === 0) variant = "green";
                else if (i < 3) variant = "blue";
                else variant = "purple-subtle";

                return (
                  <Badge
                    key={i}
                    variant={variant}
                    size="sm"
                    href={g.url}
                    title={g.title}
                    icon={
                      <span className="text-[9px] font-bold opacity-70">
                        {COUNTRY_LABELS[g.country] || g.country}
                      </span>
                    }
                  >
                    {g.source}
                    {g.year ? ` (${g.year})` : ""}
                  </Badge>
                );
              })}
            </div>
          </div>
        )}

        {/* Citations as effect-size badges */}
        {hasCitations && (
          <div className="mt-2 pt-2 border-t border-border/20">
            <button
              onClick={() => setShowCitations(!showCitations)}
              className="text-[11px] text-accent/70 hover:text-accent transition-colors flex items-center gap-1"
            >
              <span>
                {showCitations ? "Hide" : "Show"} references (
                {message.citations!.length})
              </span>
              <span className="text-[10px]">
                {showCitations ? "\u25B2" : "\u25BC"}
              </span>
            </button>
            {showCitations && (
              <div className="mt-2 space-y-2">
                {message.citations!.map((c, idx) => {
                  const variant = getEffectBadgeVariant(
                    c,
                    idx,
                    message.citations!.length,
                    priorityCountry
                  );

                  return (
                    <div
                      key={c.index}
                      className="flex items-start gap-2 px-2 py-1.5 rounded-lg bg-surface/50"
                    >
                      <Badge
                        variant={variant}
                        size="sm"
                        className="mt-0.5 shrink-0"
                      >
                        [{c.index}]
                      </Badge>
                      <div className="min-w-0 flex-1 text-[11px]">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {c.url ? (
                            <a
                              href={c.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-medium text-accent/80 hover:text-accent underline underline-offset-2"
                            >
                              {c.source}
                            </a>
                          ) : (
                            <span className="font-medium text-gray-300">
                              {c.source}
                            </span>
                          )}
                          <Badge variant="pill" size="sm">
                            {COUNTRY_LABELS[c.country] || c.country}
                          </Badge>
                          {c.year && (
                            <span className="text-gray-500 text-[10px]">
                              {c.year}
                            </span>
                          )}
                        </div>
                        <div className="text-gray-500 mt-0.5 truncate">
                          {c.title}
                        </div>
                        {c.quote && (
                          <div className="text-gray-500 mt-0.5 italic text-[10px] line-clamp-2">
                            &quot;{c.quote}&quot;
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Agents used */}
        {message.agents_used && message.agents_used.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {message.agents_used.map((a, i) => (
              <Badge key={i} variant="gray-subtle" size="sm">
                {a}
              </Badge>
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

      {/* Trust visualization: Radar + Gauges side by side */}
      {message.trust_scores && (
        <div className="ml-2 flex flex-wrap gap-3 items-start">
          <RadarChart scores={message.trust_scores} />
          <TrustGauges
            scores={message.trust_scores}
            reasons={message.trust_reasons || {
              evidence_quality: "",
              guideline_alignment: "",
              clinical_relevance: "",
              safety_check: "",
              completeness: "",
              source_recency: "",
            }}
            scorerConfidence={message.scorer_confidence ?? 70}
          />
        </div>
      )}
    </div>
  );
}
