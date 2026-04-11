"use client";

import React, { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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

function getEffectBadgeVariant(
  citation: Citation,
  index: number,
  total: number,
  priorityCountry?: string
): BadgeVariant {
  if (citation.country === "WHO") return "teal-subtle";
  if (priorityCountry && citation.country === priorityCountry) return "amber";
  const position = index / Math.max(total, 1);
  const hasQuote = citation.quote && citation.quote.length > 20;
  if (position < 0.33 || (position < 0.5 && hasQuote)) return "green";
  if (position < 0.66) return "blue";
  if (hasQuote) return "purple-subtle";
  return "gray-subtle";
}

/** Extract key sentences from the complete answer for highlighting */
function extractHighlights(text: string): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const keywords = [
    "recommend", "important", "critical", "essential", "warning",
    "contraindicated", "first-line", "gold standard", "evidence",
    "strongly", "must", "should not", "avoid", "risk", "significant",
    "key", "primary", "diagnosis", "treatment", "monitor",
  ];
  const scored = sentences.map((s) => {
    const lower = s.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    if (s.startsWith("**")) score += 2;
    if (lower.includes("$$")) score += 1;
    return { text: s, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0).slice(0, 8).map((s) => s.text);
}

/** Extract clinical alert lines (⚠️ ALERT: or ⚠️ CRITICAL:) from the answer */
function extractAlerts(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  return lines
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter((l) => /⚠️\s*(ALERT|CRITICAL):/i.test(l) || /^CRITICAL:/i.test(l));
}

/** Render a single highlight item with markdown + LaTeX support */
function HighlightItem({ text, onOpenReferenceUrl }: { text: string; onOpenReferenceUrl?: (url: string, title: string) => void }) {
  const hasLatex = text.includes("$$");
  if (hasLatex) {
    const parts = text.split(/(\$\$[\s\S]*?\$\$)/g);
    return (
      <div className="prose-content">
        {parts.map((part, i) => {
          if (part.startsWith("$$") && part.endsWith("$$")) {
            return <LatexRenderer key={i} content={part} />;
          }
          return (
            <ReactMarkdown key={i} remarkPlugins={[remarkGfm]} components={markdownComponents(onOpenReferenceUrl)}>
              {part}
            </ReactMarkdown>
          );
        })}
      </div>
    );
  }
  return (
    <div className="prose-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents(onOpenReferenceUrl)}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Animated highlight component with markdown + LaTeX + clickable references */
function HighlightedContent({ highlights, onOpenReferenceUrl }: { highlights: string[]; onOpenReferenceUrl?: (url: string, title: string) => void }) {
  const [visibleCount, setVisibleCount] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setVisibleCount(0);
    let i = 0;
    function showNext() {
      i++;
      setVisibleCount(i);
      if (i < highlights.length) {
        timerRef.current = setTimeout(showNext, 150);
      }
    }
    timerRef.current = setTimeout(showNext, 100);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [highlights]);

  if (highlights.length === 0) {
    return (
      <p className="text-sm text-gray-500 italic">No key highlights detected.</p>
    );
  }

  return (
    <div className="space-y-2.5">
      {highlights.map((h, i) => {
        const isAlert = h.includes("ALERT:") || h.includes("CRITICAL:");
        return (
          <div
            key={i}
            className={`transition-all duration-500 ${
              i < visibleCount
                ? "opacity-100 translate-y-0"
                : "opacity-0 translate-y-2"
            }`}
          >
            <div className={`flex gap-2.5 items-start ${isAlert ? "bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2" : ""}`}>
              <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 animate-pulse ${isAlert ? "bg-red-400" : "bg-amber-400"}`} />
              <div className="text-base text-gray-200 leading-relaxed flex-1">
                <HighlightItem text={h} onOpenReferenceUrl={onOpenReferenceUrl} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Markdown renderer with proper styling */
function MarkdownContent({ content, onOpenReferenceUrl }: { content: string; onOpenReferenceUrl?: (url: string, title: string) => void }) {
  // Check if content has LaTeX
  const hasLatex = content.includes("$$");

  if (hasLatex) {
    // Split by LaTeX blocks and render each part
    const parts = content.split(/(\$\$[\s\S]*?\$\$)/g);
    return (
      <div className="prose-content">
        {parts.map((part, i) => {
          if (part.startsWith("$$") && part.endsWith("$$")) {
            return <LatexRenderer key={i} content={part} />;
          }
          return (
            <ReactMarkdown
              key={i}
              remarkPlugins={[remarkGfm]}
              components={markdownComponents(onOpenReferenceUrl)}
            >
              {part}
            </ReactMarkdown>
          );
        })}
      </div>
    );
  }

  return (
    <div className="prose-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents(onOpenReferenceUrl)}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function markdownComponents(onOpenReferenceUrl?: (url: string, title: string) => void) {
  return {
    h1: ({ children, ...props }: React.ComponentPropsWithoutRef<"h1">) => (
      <h1 className="text-xl font-bold text-gray-100 mt-4 mb-2" {...props}>{children}</h1>
    ),
    h2: ({ children, ...props }: React.ComponentPropsWithoutRef<"h2">) => (
      <h2 className="text-lg font-bold text-gray-100 mt-3 mb-2" {...props}>{children}</h2>
    ),
    h3: ({ children, ...props }: React.ComponentPropsWithoutRef<"h3">) => (
      <h3 className="text-base font-bold text-gray-200 mt-2.5 mb-1.5" {...props}>{children}</h3>
    ),
    h4: ({ children, ...props }: React.ComponentPropsWithoutRef<"h4">) => (
      <h4 className="text-sm font-bold text-gray-200 mt-2 mb-1" {...props}>{children}</h4>
    ),
    p: ({ children, ...props }: React.ComponentPropsWithoutRef<"p">) => (
      <p className="text-base text-gray-200 leading-relaxed mb-2" {...props}>{children}</p>
    ),
    strong: ({ children, ...props }: React.ComponentPropsWithoutRef<"strong">) => (
      <strong className="text-gray-100 font-bold" {...props}>{children}</strong>
    ),
    em: ({ children, ...props }: React.ComponentPropsWithoutRef<"em">) => (
      <em className="text-gray-300 italic" {...props}>{children}</em>
    ),
    ul: ({ children, ...props }: React.ComponentPropsWithoutRef<"ul">) => (
      <ul className="list-disc list-outside ml-5 mb-2 space-y-1" {...props}>{children}</ul>
    ),
    ol: ({ children, ...props }: React.ComponentPropsWithoutRef<"ol">) => (
      <ol className="list-decimal list-outside ml-5 mb-2 space-y-1" {...props}>{children}</ol>
    ),
    li: ({ children, ...props }: React.ComponentPropsWithoutRef<"li">) => (
      <li className="text-base text-gray-200 leading-relaxed" {...props}>{children}</li>
    ),
    a: ({ href, children, ...props }: React.ComponentPropsWithoutRef<"a">) => (
      <button
        className="text-accent hover:text-accent/80 underline underline-offset-2 font-medium"
        onClick={(e) => {
          e.preventDefault();
          if (href && onOpenReferenceUrl) {
            onOpenReferenceUrl(href, String(children) || href);
          } else if (href) {
            window.open(href, "_blank");
          }
        }}
        {...(props as React.ComponentPropsWithoutRef<"button">)}
      >
        {children}
      </button>
    ),
    code: ({ children, className, ...props }: React.ComponentPropsWithoutRef<"code"> & { className?: string }) => {
      const isBlock = className?.startsWith("language-");
      if (isBlock) {
        return (
          <pre className="bg-[#1a1a2e] border border-border/30 rounded-lg p-3 my-2 overflow-x-auto">
            <code className="text-sm text-accent font-mono" {...props}>{children}</code>
          </pre>
        );
      }
      return (
        <code className="bg-surface/80 text-accent px-1 py-0.5 rounded text-sm font-mono" {...props}>{children}</code>
      );
    },
    blockquote: ({ children, ...props }: React.ComponentPropsWithoutRef<"blockquote">) => (
      <blockquote className="border-l-3 border-accent/50 pl-3 my-2 italic text-gray-400" {...props}>{children}</blockquote>
    ),
    hr: (props: React.ComponentPropsWithoutRef<"hr">) => (
      <hr className="border-border/30 my-3" {...props} />
    ),
    table: ({ children, ...props }: React.ComponentPropsWithoutRef<"table">) => (
      <div className="overflow-x-auto my-2">
        <table className="w-full text-sm border border-border/30 rounded" {...props}>{children}</table>
      </div>
    ),
    th: ({ children, ...props }: React.ComponentPropsWithoutRef<"th">) => (
      <th className="px-3 py-1.5 text-left font-bold text-gray-200 bg-surface border-b border-border/30" {...props}>{children}</th>
    ),
    td: ({ children, ...props }: React.ComponentPropsWithoutRef<"td">) => (
      <td className="px-3 py-1.5 text-gray-300 border-b border-border/20" {...props}>{children}</td>
    ),
  };
}

interface MessageBubbleProps {
  message: Message;
  onOpenDecisionTree?: (tree: DecisionTreeData) => void;
  onOpenKnowledgeGraph?: () => void;
  onOpenReferences?: () => void;
  onOpenReferenceUrl?: (url: string, title: string) => void;
  hasPatientData?: boolean;
}

export function MessageBubble({
  message,
  onOpenDecisionTree,
  onOpenKnowledgeGraph,
  onOpenReferences,
  onOpenReferenceUrl,
  hasPatientData,
}: MessageBubbleProps) {
  const [mode, setMode] = useState<"fast" | "complete" | "highlight">("fast");
  const [showCitations, setShowCitations] = useState(false);

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent/90 px-4 py-2.5 text-base text-white">
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

  const highlights = hasDualMode
    ? extractHighlights(message.complete_answer!)
    : [];

  // Extract clinical alert lines from the current display content
  const alerts = extractAlerts(displayContent);
  const hasCitations = message.citations && message.citations.length > 0;
  const hasGuidelines =
    message.guidelines_used && message.guidelines_used.length > 0;
  const hasDecisionTree =
    message.decision_tree &&
    message.decision_tree.nodes &&
    message.decision_tree.nodes.length > 0;
  const hasTrustScores = message.trust_scores != null;
  // Show gauges if any score is non-zero (real data from scorer)
  const trustScoresAreReal = hasTrustScores &&
    Object.values(message.trust_scores!).some((v) => v > 0);

  const priorityCountry = message.priority_country;
  const countryFlag = priorityCountry ? COUNTRY_FLAGS[priorityCountry] : null;

  return (
    <div className="flex flex-col gap-0 max-w-full">
      <div className="rounded-2xl rounded-bl-md bg-surface-light border border-border/30">
        {/* Country / Language header */}
        {countryFlag && priorityCountry && (
          <div className="flex items-center gap-1.5 px-5 pt-3 text-xs text-gray-400">
            <span className="text-base">{countryFlag}</span>
            <span>Priority: <strong className="text-gray-300">{COUNTRY_LABELS[priorityCountry] || priorityCountry}</strong> guidelines</span>
          </div>
        )}

        {/* Mode tabs + action buttons row */}
        <div className="flex items-center justify-between px-5 pt-3 pb-2 gap-2 flex-wrap">
          {hasDualMode ? (
            <div className="flex gap-1 p-0.5 bg-surface rounded-lg w-fit">
              <button
                onClick={() => setMode("fast")}
                className={`px-3 py-1 rounded-md text-xs font-semibold transition-all ${
                  mode === "fast"
                    ? "bg-accent text-white"
                    : "text-gray-400 hover:text-gray-200"
                }`}
              >
                Fast
              </button>
              <button
                onClick={() => setMode("complete")}
                className={`px-3 py-1 rounded-md text-xs font-semibold transition-all ${
                  mode === "complete"
                    ? "bg-accent text-white"
                    : "text-gray-400 hover:text-gray-200"
                }`}
              >
                Complete
              </button>
              <button
                onClick={() => setMode("highlight")}
                className={`px-3 py-1 rounded-md text-xs font-semibold transition-all ${
                  mode === "highlight"
                    ? "bg-amber-500 text-white"
                    : "text-gray-400 hover:text-gray-200"
                }`}
              >
                Highlights
              </button>
            </div>
          ) : (
            <div />
          )}

          <div className="flex items-center gap-1.5">
            {hasDecisionTree && onOpenDecisionTree && (
              <button
                onClick={() => onOpenDecisionTree(message.decision_tree!)}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-accent/10 text-accent/80 hover:bg-accent/20 hover:text-accent border border-accent/20 transition-all"
              >
                Decision Tree
              </button>
            )}
            {hasPatientData && onOpenKnowledgeGraph && (
              <button
                onClick={onOpenKnowledgeGraph}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-emerald-500/10 text-emerald-400/80 hover:bg-emerald-500/20 hover:text-emerald-400 border border-emerald-500/20 transition-all"
              >
                Knowledge Graph
              </button>
            )}
            {hasCitations && onOpenReferences && (
              <button
                onClick={onOpenReferences}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-blue-500/10 text-blue-400/80 hover:bg-blue-500/20 hover:text-blue-400 border border-blue-500/20 transition-all"
              >
                References
              </button>
            )}
          </div>
        </div>

        {/* Clinical alerts */}
        {alerts.length > 0 && (
          <div className="mx-5 mb-2 space-y-1.5">
            {alerts.map((alert, i) => (
              <div key={i} className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30">
                <svg className="w-5 h-5 text-red-400 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                </svg>
                <div className="text-sm text-red-200 leading-relaxed flex-1 prose-content">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents(onOpenReferenceUrl)}>
                    {alert.replace(/^⚠️\s*ALERT:\s*/i, "").replace(/^⚠️\s*CRITICAL:\s*/i, "")}
                  </ReactMarkdown>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Answer content */}
        <div className="px-5 pb-4">
          {mode === "highlight" && hasDualMode ? (
            <HighlightedContent highlights={highlights} onOpenReferenceUrl={onOpenReferenceUrl} />
          ) : (
            <MarkdownContent content={displayContent} onOpenReferenceUrl={onOpenReferenceUrl} />
          )}
        </div>

        {/* Guidelines as effect-size badges */}
        {hasGuidelines && (
          <div className="mx-5 pt-3 pb-3 border-t border-border/30">
            <p className="text-xs text-gray-500 mb-1.5 font-semibold">
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

                const handleClick = (e: React.MouseEvent) => {
                  e.preventDefault();
                  if (g.url && onOpenReferenceUrl) {
                    onOpenReferenceUrl(g.url, g.title);
                  } else if (onOpenReferences) {
                    onOpenReferences();
                  }
                };

                return (
                  <div
                    key={i}
                    onClick={handleClick}
                    className="cursor-pointer"
                    title={g.url ? `Open: ${g.url}` : g.title}
                  >
                    <Badge
                      variant={variant}
                      size="sm"
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
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Citations as effect-size badges */}
        {hasCitations && (
          <div className="mx-5 pt-2 pb-3 border-t border-border/20">
            <button
              onClick={() => setShowCitations(!showCitations)}
              className="text-xs text-accent/70 hover:text-accent transition-colors flex items-center gap-1 font-semibold"
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
                      className="flex items-start gap-2 px-2.5 py-2 rounded-lg bg-surface/50"
                    >
                      <Badge
                        variant={variant}
                        size="sm"
                        className="mt-0.5 shrink-0"
                      >
                        [{c.index}]
                      </Badge>
                      <div className="min-w-0 flex-1 text-xs">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {c.url ? (
                            <button
                              onClick={() => {
                                if (onOpenReferenceUrl) {
                                  onOpenReferenceUrl(c.url!, c.title);
                                } else {
                                  window.open(c.url!, "_blank");
                                }
                              }}
                              className="font-semibold text-accent/80 hover:text-accent underline underline-offset-2 text-left"
                            >
                              {c.source}
                            </button>
                          ) : (
                            <span className="font-semibold text-gray-300">
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
                        <div className="text-gray-400 mt-0.5 truncate">
                          {c.title}
                        </div>
                        {c.quote && (
                          <div className="text-gray-500 mt-0.5 italic text-[11px] line-clamp-2">
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

        {/* Trust visualization — inside the answer box */}
        {hasTrustScores && (
          <div className="mx-5 pt-3 pb-4 border-t border-border/30">
            {trustScoresAreReal ? (
              <div className="flex flex-wrap gap-3 items-start">
                <RadarChart scores={message.trust_scores!} />
                <TrustGauges
                  scores={message.trust_scores!}
                  reasons={message.trust_reasons || {
                    evidence_quality: "",
                    guideline_alignment: "",
                    clinical_relevance: "",
                    safety_check: "",
                    completeness: "",
                    source_recency: "",
                  }}
                  scorerConfidence={message.scorer_confidence!}
                />
              </div>
            ) : (
              <div className="text-xs text-gray-500 italic px-1">
                Trust scoring unavailable for this response — the scorer could not evaluate the answer content.
                {message.trust_reasons?.evidence_quality && (
                  <span className="block mt-1 text-gray-600">
                    Reason: {message.trust_reasons.evidence_quality}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Agents used + timing — footer */}
        {(message.agents_used?.length || message.total_time_ms) && (
          <div className="px-5 py-2 border-t border-border/20 flex items-center gap-3 flex-wrap">
            {message.agents_used && message.agents_used.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {message.agents_used.map((a, i) => (
                  <Badge key={i} variant="gray-subtle" size="sm">
                    {a}
                  </Badge>
                ))}
              </div>
            )}
            {message.total_time_ms != null && message.total_time_ms > 0 && (
              <div className="flex items-center gap-3 text-[10px] text-gray-600 ml-auto">
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
        )}
      </div>
    </div>
  );
}
