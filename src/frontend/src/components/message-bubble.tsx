"use client";

import React, { useState, useMemo } from "react";
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
  importance?: "high" | "medium" | "low";
  effect_size?: "large" | "moderate" | "small" | "none";
  evidence_level?: string;
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

/** Entity from patient data for deep-linking into the knowledge graph */
export interface DeepLinkEntity {
  text: string;        // Text to match in answers
  category: string;    // diagnosis | medication | department | doctor | episode | icd | drug | allergy | facility
  label: string;       // Node label in the knowledge graph
}

const ENTITY_COLORS: Record<string, { text: string; bg: string; border: string }> = {
  diagnosis:  { text: "#c4b5fd", bg: "rgba(139,92,246,0.10)", border: "rgba(139,92,246,0.25)" },
  medication: { text: "#93c5fd", bg: "rgba(59,130,246,0.10)", border: "rgba(59,130,246,0.25)" },
  department: { text: "#6ee7b7", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.25)" },
  doctor:     { text: "#fcd34d", bg: "rgba(251,191,36,0.10)", border: "rgba(251,191,36,0.25)" },
  episode:    { text: "#d1d5db", bg: "rgba(156,163,175,0.08)", border: "rgba(156,163,175,0.20)" },
  icd:        { text: "#fdba74", bg: "rgba(251,146,60,0.08)",  border: "rgba(251,146,60,0.20)" },
  drug:       { text: "#5eead4", bg: "rgba(20,184,166,0.08)",  border: "rgba(20,184,166,0.20)" },
  allergy:    { text: "#fca5a5", bg: "rgba(252,165,165,0.08)", border: "rgba(252,165,165,0.20)" },
  facility:   { text: "#67e8f9", bg: "rgba(34,211,238,0.08)",  border: "rgba(34,211,238,0.20)" },
  report:     { text: "#a5b4fc", bg: "rgba(99,102,241,0.10)",  border: "rgba(99,102,241,0.25)" },
  labtest:    { text: "#7dd3fc", bg: "rgba(14,165,233,0.10)",  border: "rgba(14,165,233,0.25)" },
};

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
  // WHO sources get teal badge
  if (citation.country === "WHO") return "teal-subtle";
  // Priority-country sources get amber badge
  if (priorityCountry && citation.country === priorityCountry) return "amber";

  // Use structured importance/effect_size if available (from AI scorer)
  if (citation.importance || citation.effect_size) {
    if (citation.importance === "high" || citation.effect_size === "large") return "green";
    if (citation.importance === "medium" || citation.effect_size === "moderate") return "blue";
    if (citation.importance === "low" || citation.effect_size === "small") return "purple-subtle";
    return "gray-subtle";
  }

  // Fallback heuristics when structured data is absent
  const hasQuote = citation.quote && citation.quote.length > 20;
  const hasUrl = !!citation.url;
  const isRecent = citation.year && citation.year >= new Date().getFullYear() - 3;
  // Strong evidence signals: has supporting quote + URL + recent
  if ((hasQuote && hasUrl) || isRecent) return "green";
  if (hasQuote || hasUrl) return "blue";
  if (index < Math.ceil(total * 0.4)) return "purple-subtle";
  return "gray-subtle";
}

/** Extract key content blocks from the complete answer for highlighting.
 *  Preserves LaTeX blocks, headings, and structured content as whole units.
 */
function extractHighlights(text: string): string[] {
  if (!text) return [];

  // Step 1: Split text into blocks — preserve LaTeX groups together
  // First, protect LaTeX blocks by collecting them, then split by paragraphs/sections
  const blocks: string[] = [];

  // Split by double newline (paragraphs) or by headings
  const rawBlocks = text.split(/\n{2,}/).filter((b) => b.trim());

  for (const block of rawBlocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // If block contains LaTeX, keep it as one unit (may span multiple lines)
    if (trimmed.includes("$$")) {
      blocks.push(trimmed);
      continue;
    }

    // If block is a heading + content, keep together
    if (trimmed.startsWith("#") || trimmed.startsWith("**")) {
      blocks.push(trimmed);
      continue;
    }

    // Otherwise split by sentences but keep reasonable chunks
    const sentences = trimmed.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
    if (sentences.length <= 3) {
      blocks.push(trimmed);
    } else {
      for (const s of sentences) {
        blocks.push(s);
      }
    }
  }

  // Step 2: Score each block for clinical relevance
  const keywords = [
    "recommend", "important", "critical", "essential", "warning",
    "contraindicated", "first-line", "gold standard", "evidence",
    "strongly", "must", "should not", "avoid", "risk", "significant",
    "key", "primary", "diagnosis", "treatment", "monitor", "formula",
    "target", "alert", "calculate", "dose", "guideline", "per ",
  ];

  const scored = blocks.map((s) => {
    const lower = s.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    if (s.startsWith("**") || s.startsWith("#")) score += 2;
    if (s.includes("$$")) score += 3; // LaTeX formulas are high-value
    if (/\[\d+\]/.test(s)) score += 1; // Has inline references
    if (/⚠️|ALERT|CRITICAL/i.test(s)) score += 3;
    if (s.includes("→") || s.includes("—")) score += 1; // Clinical reasoning
    return { text: s, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0).slice(0, 12).map((s) => s.text);
}

/** Extract clinical alert lines (⚠️ ALERT: or ⚠️ CRITICAL:) from the answer */
function extractAlerts(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  return lines
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter((l) => /⚠️\s*(ALERT|CRITICAL):/i.test(l) || /^CRITICAL:/i.test(l));
}

/** Convert inline [N] references to clickable elements */
function InlineRefText({ text, citations, onOpenReferenceUrl, onOpenReferences }: {
  text: string;
  citations?: Citation[];
  onOpenReferenceUrl?: (url: string, title: string) => void;
  onOpenReferences?: () => void;
}) {
  // Split text on [N] patterns (e.g., [1], [2], [1][2][3])
  const parts = text.split(/(\[\d+\])/g);
  if (parts.length <= 1) return <>{text}</>;

  return (
    <>
      {parts.map((part, i) => {
        const match = part.match(/^\[(\d+)\]$/);
        if (!match) return <React.Fragment key={i}>{part}</React.Fragment>;

        const refIndex = parseInt(match[1], 10);
        const citation = citations?.find((c) => c.index === refIndex);

        return (
          <button
            key={i}
            onClick={() => {
              if (citation?.url && onOpenReferenceUrl) {
                onOpenReferenceUrl(citation.url, citation.title);
              } else if (onOpenReferences) {
                onOpenReferences();
              }
            }}
            className="inline-flex items-center justify-center min-w-[20px] h-[18px] px-1 mx-0.5 rounded text-[10px] font-bold bg-accent/15 text-accent hover:bg-accent/30 hover:text-white transition-all cursor-pointer border border-accent/20 align-middle leading-none"
            title={citation ? `${citation.source} — ${citation.title}` : `Reference [${refIndex}]`}
          >
            {refIndex}
          </button>
        );
      })}
    </>
  );
}

/** Pre-process markdown text: replace [N] with placeholder links for markdown renderer.
 *  Protects LaTeX blocks and code spans from modification. */
function preprocessInlineRefs(text: string): string {
  // Protect LaTeX and code from [N] replacement
  const placeholders: string[] = [];
  const protect = (m: string) => { placeholders.push(m); return `\x01REF${placeholders.length - 1}\x01`; };
  let safe = text;
  safe = safe.replace(/\$\$[\s\S]*?\$\$/g, protect);   // display LaTeX
  safe = safe.replace(/\$[^$\n]+?\$/g, protect);        // inline LaTeX
  safe = safe.replace(/`[^`]+`/g, protect);              // inline code

  // Replace [N] with markdown-compatible link: [⟨N⟩](#cite-N)
  safe = safe.replace(/\[(\d+)\]/g, "[`[$1]`](#cite-$1)");

  // Restore protected content
  safe = safe.replace(/\x01REF(\d+)\x01/g, (_, idx) => placeholders[parseInt(idx)]);
  return safe;
}

/** Pharmaceutical name suffixes — matches generic drug names with high specificity */
const DRUG_SUFFIX_RE = /\b([A-Za-z]{4,}(?:mab|zumab|ximab|mumab|nib|tinib|fenib|ciclib|pril|sartan|statin|olol|azole|prazole|conazole|cillin|mycin|cycline|floxacin|dipine|zosin|gliptin|glutide|fenac|profen|triptan|setron|vaptan|lukast|semide|thiazide|sertide|terol|sonide|metasone|olone|nisone))\b/gi;

/** ICD-10 code pattern: Letter + 2 digits, optional .digit(s) */
const ICD_CODE_RE = /\b([A-TV-Z]\d{2}(?:\.\d{1,2})?)\b/g;

/** Report type names for deep linking */
const REPORT_TYPE_NAMES = [
  "Muayene", "Laboratuvar", "Radyoloji", "Kardiyoloji",
  "Endoskopi", "SGK", "Patoloji",
];

/** Common Turkish lab test names for trend deep linking */
const LAB_TEST_NAMES = [
  "Lokosit", "Hemoglobin", "Hematokrit", "Trombosit", "Eritrosit",
  "MCV", "MCH", "MCHC", "RDW", "MPV", "PCT", "PDW",
  "Notrofil", "Lenfosit", "Monosit", "Eozinofil", "Bazofil",
  "TSH", "sT3", "sT4", "T3", "T4",
  "Kolesterol", "LDL", "HDL", "Trigliserit", "VLDL",
  "Glukoz", "HbA1c", "Insulin",
  "AST", "ALT", "GGT", "ALP", "LDH", "Bilirubin",
  "BUN", "Kreatinin", "Albumin", "Protein",
  "Sodyum", "Potasyum", "Kalsiyum", "Magnezyum", "Fosfor", "Klor",
  "CRP", "Sedimantasyon", "Ferritin", "Demir", "B12", "Folat",
  "Fibrinojen", "D-Dimer", "INR", "PT", "aPTT",
  "PSA", "AFP", "CEA", "CA125", "CA15-3", "CA19-9",
  "WBC", "RBC", "PLT", "Hgb", "Hct",
];

/** Pre-process text: wrap patient entity mentions with deep-link markers.
 *  Also pattern-detects ICD codes, drug names, report types, and lab tests.
 *  Produces Obsidian-style [[links]] as markdown links with #kg- prefix. */
function preprocessDeepLinks(text: string, entities: DeepLinkEntity[]): string {
  // 1. Protect LaTeX, code, and existing links from modification
  const placeholders: string[] = [];
  const protect = (m: string) => { placeholders.push(m); return `\x00PH${placeholders.length - 1}\x00`; };
  let safe = text;
  safe = safe.replace(/\$\$[\s\S]*?\$\$/g, protect);         // display LaTeX
  safe = safe.replace(/\$[^$\n]+?\$/g, protect);              // inline LaTeX
  safe = safe.replace(/`[^`]+`/g, protect);                    // inline code
  safe = safe.replace(/\[([^\]]+)\]\([^)]+\)/g, protect);     // markdown links

  const linked = new Set<string>();

  // 2. Patient-data entities (highest priority — longest-first to prevent partial overlap)
  if (entities && entities.length > 0) {
    const sorted = [...entities].sort((a, b) => b.text.length - a.text.length);
    for (const ent of sorted) {
      if (ent.text.length < 3) continue;
      const escaped = ent.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b(${escaped})\\b`, "gi");
      safe = safe.replace(re, (match) => {
        const key = match.toLowerCase();
        if (linked.has(key)) return match;
        linked.add(key);
        return `[${match}](#kg-${encodeURIComponent(ent.category)}-${encodeURIComponent(ent.label)})`;
      });
    }
  }

  // 3. Report type names — deep link to reports KG tab
  for (const rt of REPORT_TYPE_NAMES) {
    const escaped = rt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b(${escaped})\\b`, "gi");
    safe = safe.replace(re, (match) => {
      const key = match.toLowerCase();
      if (linked.has(key)) return match;
      linked.add(key);
      return `[${match}](#kg-report-${encodeURIComponent(match)})`;
    });
  }

  // 4. Lab test names — deep link to trend monitor
  // Use negative lookbehind/lookahead for Turkish letters to prevent
  // matching inside Turkish words (e.g., "altında" should not match "ALT")
  const turkishLetters = "a-zA-ZçÇğĞıİöÖşŞüÜâÂîÎûÛ";
  for (const lt of LAB_TEST_NAMES) {
    if (lt.length < 3) continue; // Skip very short names to avoid false positives
    const escaped = lt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Use word boundary but verify no adjacent Turkish letters
    const re = new RegExp(`(?<![${turkishLetters}])(${escaped})(?![${turkishLetters}])`, "g");
    safe = safe.replace(re, (match) => {
      const key = match.toLowerCase();
      if (linked.has(key)) return match;
      linked.add(key);
      return `[${match}](#kg-labtest-${encodeURIComponent(match)})`;
    });
  }

  // 5. ICD-10 codes (pattern-based — catches codes not in patient data too)
  safe = safe.replace(ICD_CODE_RE, (match) => {
    const key = match.toLowerCase();
    if (linked.has(key)) return match;
    linked.add(key);
    return `[${match}](#kg-icd-${encodeURIComponent(match)})`;
  });

  // 6. Drug names by pharmaceutical suffix (catches drugs not in patient's prescription list)
  safe = safe.replace(DRUG_SUFFIX_RE, (match) => {
    const key = match.toLowerCase();
    if (linked.has(key)) return match;
    linked.add(key);
    return `[${match}](#kg-drug-${encodeURIComponent(match)})`;
  });

  // 7. Restore placeholders
  safe = safe.replace(/\x00PH(\d+)\x00/g, (_, idx) => placeholders[parseInt(idx)]);
  return safe;
}

/** Render a single highlight item with markdown + LaTeX support + inline refs + deep links */
function HighlightItem({ text, onOpenReferenceUrl, citations, onOpenReferences, onOpenKgFocus, patientEntities, onOpenReportType, onOpenTrendForTest }: { text: string; onOpenReferenceUrl?: (url: string, title: string) => void; citations?: Citation[]; onOpenReferences?: () => void; onOpenKgFocus?: (label: string) => void; patientEntities?: DeepLinkEntity[]; onOpenReportType?: (reportType: string) => void; onOpenTrendForTest?: (testName: string) => void }) {
  let processed = preprocessInlineRefs(text);
  processed = preprocessDeepLinks(processed, patientEntities || []);
  const hasLatex = processed.includes("$");
  const components = markdownComponents(onOpenReferenceUrl, citations, onOpenReferences, onOpenKgFocus, onOpenReportType, onOpenTrendForTest);

  if (hasLatex) {
    const segments = splitLatex(processed);
    return (
      <div className="prose-content">
        {segments.map((seg, i) => {
          if (seg.isLatex) {
            return <LatexRenderer key={i} content={seg.content} />;
          }
          return (
            <ReactMarkdown key={i} remarkPlugins={[remarkGfm]} components={components}>
              {seg.content}
            </ReactMarkdown>
          );
        })}
      </div>
    );
  }
  return (
    <div className="prose-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {processed}
      </ReactMarkdown>
    </div>
  );
}

/** Highlight component — renders all highlights immediately (no stagger delay) */
function HighlightedContent({ highlights, onOpenReferenceUrl, citations, onOpenReferences, onOpenKgFocus, patientEntities, onOpenReportType, onOpenTrendForTest }: {
  highlights: string[];
  onOpenReferenceUrl?: (url: string, title: string) => void;
  citations?: Citation[];
  onOpenReferences?: () => void;
  onOpenKgFocus?: (label: string) => void;
  patientEntities?: DeepLinkEntity[];
  onOpenReportType?: (reportType: string) => void;
  onOpenTrendForTest?: (testName: string) => void;
}) {
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
          <div key={i}>
            <div className={`flex gap-2.5 items-start ${isAlert ? "bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2" : ""}`}>
              <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${isAlert ? "bg-red-400" : "bg-amber-400"}`} />
              <div className="text-base text-gray-200 leading-relaxed flex-1">
                <HighlightItem text={h} onOpenReferenceUrl={onOpenReferenceUrl} citations={citations} onOpenReferences={onOpenReferences} onOpenKgFocus={onOpenKgFocus} patientEntities={patientEntities} onOpenReportType={onOpenReportType} onOpenTrendForTest={onOpenTrendForTest} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Split text into alternating plain/LaTeX segments. Handles both $$ (display) and $ (inline) */
function splitLatex(text: string): { content: string; isLatex: boolean; isDisplay: boolean }[] {
  const segments: { content: string; isLatex: boolean; isDisplay: boolean }[] = [];
  // Match display $$ first, then inline $
  const regex = /(\$\$[\s\S]*?\$\$|\$[^$\n]+?\$)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ content: text.slice(lastIndex, match.index), isLatex: false, isDisplay: false });
    }
    const isDisplay = match[0].startsWith("$$");
    segments.push({ content: match[0], isLatex: true, isDisplay });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    segments.push({ content: text.slice(lastIndex), isLatex: false, isDisplay: false });
  }
  return segments;
}

/** Markdown renderer with proper styling — includes inline [N] ref support + deep links */
function MarkdownContent({ content, onOpenReferenceUrl, citations, onOpenReferences, onOpenKgFocus, patientEntities, onOpenReportType, onOpenTrendForTest }: {
  content: string;
  onOpenReferenceUrl?: (url: string, title: string) => void;
  citations?: Citation[];
  onOpenReferences?: () => void;
  onOpenKgFocus?: (label: string) => void;
  patientEntities?: DeepLinkEntity[];
  onOpenReportType?: (reportType: string) => void;
  onOpenTrendForTest?: (testName: string) => void;
}) {
  let processed = preprocessInlineRefs(content);
  processed = preprocessDeepLinks(processed, patientEntities || []);
  const hasLatex = processed.includes("$");
  const components = markdownComponents(onOpenReferenceUrl, citations, onOpenReferences, onOpenKgFocus, onOpenReportType, onOpenTrendForTest);

  if (hasLatex) {
    const segments = splitLatex(processed);
    return (
      <div className="prose-content">
        {segments.map((seg, i) => {
          if (seg.isLatex) {
            return <LatexRenderer key={i} content={seg.content} />;
          }
          return (
            <ReactMarkdown key={i} remarkPlugins={[remarkGfm]} components={components}>
              {seg.content}
            </ReactMarkdown>
          );
        })}
      </div>
    );
  }

  return (
    <div className="prose-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {processed}
      </ReactMarkdown>
    </div>
  );
}

function markdownComponents(
  onOpenReferenceUrl?: (url: string, title: string) => void,
  citations?: Citation[],
  onOpenReferences?: () => void,
  onOpenKgFocus?: (label: string) => void,
  onOpenReportType?: (reportType: string) => void,
  onOpenTrendForTest?: (testName: string) => void,
) {
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
    a: ({ href, children, ...props }: React.ComponentPropsWithoutRef<"a">) => {
      // Handle inline citation links (#cite-N)
      const citeMatch = href?.match(/^#cite-(\d+)$/);
      if (citeMatch) {
        const refIndex = parseInt(citeMatch[1], 10);
        const citation = citations?.find((c) => c.index === refIndex);
        return (
          <button
            className="inline-flex items-center justify-center min-w-[20px] h-[18px] px-1 mx-0.5 rounded text-[10px] font-bold bg-accent/15 text-accent hover:bg-accent/30 hover:text-white transition-all cursor-pointer border border-accent/20 align-middle leading-none"
            title={citation ? `${citation.source} — ${citation.title}` : `Reference [${refIndex}]`}
            onClick={(e) => {
              e.preventDefault();
              if (citation?.url && onOpenReferenceUrl) {
                onOpenReferenceUrl(citation.url, citation.title);
              } else if (onOpenReferences) {
                onOpenReferences();
              }
            }}
          >
            {refIndex}
          </button>
        );
      }
      // Handle knowledge-graph deep links (#kg-category-label)
      const kgMatch = href?.match(/^#kg-([^-]+)-(.+)$/);
      if (kgMatch) {
        let category: string, label: string;
        try { category = decodeURIComponent(kgMatch[1]); } catch { category = kgMatch[1]; }
        try { label = decodeURIComponent(kgMatch[2]); } catch { label = kgMatch[2]; }
        const colors = ENTITY_COLORS[category] || ENTITY_COLORS.episode;
        const tipMap: Record<string, string> = {
          diagnosis: `Diagnosis: "${label}" — View in Knowledge Graph`,
          medication: `Patient medication: "${label}" — View in Knowledge Graph`,
          department: `Department: "${label}" — View in Knowledge Graph`,
          doctor: `Doctor: "${label}" — View in Knowledge Graph`,
          episode: `Visit: ${label} — View in Knowledge Graph`,
          icd: `ICD-10 code: ${label}`,
          drug: `Drug: ${label}`,
          allergy: `Allergy: "${label}" — View in Knowledge Graph`,
          facility: `Facility: "${label}" — View in Knowledge Graph`,
          report: `Report type: "${label}" — View in Reports Graph`,
          labtest: `Lab test: "${label}" — View trend`,
        };
        const tip = tipMap[category] || `${label} — View in Knowledge Graph`;
        const isReport = category === "report";
        const isLabTest = category === "labtest";
        const canOpenKg = onOpenKgFocus && !["icd", "drug", "report", "labtest"].includes(category);
        return (
          <button
            className="inline-flex items-center gap-0.5 px-0.5 py-0 rounded text-[inherit] font-inherit transition-all align-baseline leading-inherit"
            style={{
              color: colors.text,
              borderBottom: `1.5px dotted ${colors.border}`,
              background: "transparent",
              cursor: (isReport || isLabTest || canOpenKg) ? "pointer" : "help",
            }}
            title={tip}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = colors.bg; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            onClick={(e) => {
              e.preventDefault();
              if (isReport && onOpenReportType) {
                onOpenReportType(label);
              } else if (isLabTest && onOpenTrendForTest) {
                onOpenTrendForTest(label);
              } else if (canOpenKg) {
                onOpenKgFocus!(label);
              } else if (onOpenKgFocus) {
                onOpenKgFocus(label);
              }
            }}
          >
            {children}
          </button>
        );
      }
      // Check if this is an auto-linked raw URL (children text equals href)
      const childText = String(children || "");
      const isRawUrl = href && (childText === href || childText.replace(/\/$/, "") === href.replace(/\/$/, ""));
      const isExternalUrl = href && /^https?:\/\//.test(href);

      if (isRawUrl && isExternalUrl) {
        // Render as a compact badge instead of showing the raw URL
        let domain = "";
        try { domain = new URL(href).hostname.replace(/^www\./, ""); } catch { domain = "link"; }
        return (
          <button
            className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded text-[10px] font-semibold bg-accent/10 text-accent/80 hover:bg-accent/20 hover:text-accent transition-all cursor-pointer border border-accent/15 hover:border-accent/30 align-middle leading-none"
            title={href}
            onClick={(e) => {
              e.preventDefault();
              if (onOpenReferenceUrl) {
                onOpenReferenceUrl(href, domain);
              } else {
                window.open(href, "_blank");
              }
            }}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            {domain}
          </button>
        );
      }

      return (
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
      );
    },
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
  onOpenKnowledgeGraphFocus?: (label: string) => void;
  onOpenReferences?: () => void;
  onOpenReferenceUrl?: (url: string, title: string) => void;
  hasPatientData?: boolean;
  patientEntities?: DeepLinkEntity[];
  onOpenReportType?: (reportType: string) => void;
  onOpenTrendForTest?: (testName: string) => void;
}

export function MessageBubble({
  message,
  onOpenDecisionTree,
  onOpenKnowledgeGraph,
  onOpenKnowledgeGraphFocus,
  onOpenReferences,
  onOpenReferenceUrl,
  hasPatientData,
  patientEntities,
  onOpenReportType,
  onOpenTrendForTest,
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

  const highlights = useMemo(
    () => (hasDualMode ? extractHighlights(message.complete_answer!) : []),
    [hasDualMode, message.complete_answer],
  );

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
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents(onOpenReferenceUrl, message.citations, onOpenReferences, onOpenKnowledgeGraphFocus, onOpenReportType, onOpenTrendForTest)}>
                    {preprocessInlineRefs(alert.replace(/^⚠️\s*ALERT:\s*/i, "").replace(/^⚠️\s*CRITICAL:\s*/i, ""))}
                  </ReactMarkdown>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Answer content */}
        <div className="px-5 pb-4">
          {mode === "highlight" && hasDualMode ? (
            <HighlightedContent highlights={highlights} onOpenReferenceUrl={onOpenReferenceUrl} citations={message.citations} onOpenReferences={onOpenReferences} onOpenKgFocus={onOpenKnowledgeGraphFocus} patientEntities={patientEntities} onOpenReportType={onOpenReportType} onOpenTrendForTest={onOpenTrendForTest} />
          ) : (
            <MarkdownContent content={displayContent} onOpenReferenceUrl={onOpenReferenceUrl} citations={message.citations} onOpenReferences={onOpenReferences} onOpenKgFocus={onOpenKnowledgeGraphFocus} patientEntities={patientEntities} onOpenReportType={onOpenReportType} onOpenTrendForTest={onOpenTrendForTest} />
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
                      className="max-w-[220px]"
                      icon={
                        <span className="text-[9px] font-bold opacity-70">
                          {COUNTRY_LABELS[g.country] || g.country}
                        </span>
                      }
                    >
                      <span className="truncate">{g.source}{g.year ? ` (${g.year})` : ""}</span>
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

                  // Compute a human-readable impact label — always shown
                  const impactLabel = c.importance
                    ? (c.importance === "high" ? "High impact" : c.importance === "medium" ? "Moderate impact" : "Low impact")
                    : c.effect_size && c.effect_size !== "none"
                    ? (c.effect_size === "large" ? "High impact" : c.effect_size === "moderate" ? "Moderate impact" : "Contextual")
                    : variant === "green" ? "High impact"
                    : variant === "blue" ? "Moderate impact"
                    : variant === "teal-subtle" ? "WHO / International"
                    : variant === "amber" ? "Priority country"
                    : variant === "purple-subtle" ? "Contextual"
                    : "Low impact";

                  const openInBrowser = (e: React.MouseEvent) => {
                    e.stopPropagation();
                    if (c.url && onOpenReferenceUrl) {
                      onOpenReferenceUrl(c.url, c.title);
                    } else if (onOpenReferences) {
                      onOpenReferences();
                    }
                  };

                  return (
                    <div
                      key={c.index}
                      className="flex items-start gap-2 px-2.5 py-2 rounded-lg bg-surface/50 hover:bg-surface-light transition-colors group"
                    >
                      <button
                        onClick={openInBrowser}
                        className="mt-0.5 shrink-0 cursor-pointer hover:scale-110 hover:brightness-125 transition-all"
                        title={c.url ? `Open ${c.source} in browser` : c.title}
                      >
                        <Badge variant={variant} size="sm">
                          [{c.index}]
                        </Badge>
                      </button>
                      <div className="min-w-0 flex-1 text-xs">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <button
                            onClick={openInBrowser}
                            className={`font-semibold text-left cursor-pointer transition-colors ${c.url ? "text-accent/80 hover:text-accent underline underline-offset-2 decoration-accent/40 hover:decoration-accent/80" : "text-gray-300 hover:text-gray-200"}`}
                            title={c.url ? `Open: ${c.url}` : c.title}
                          >
                            {c.source}
                          </button>
                          <Badge variant="pill" size="sm">
                            {COUNTRY_LABELS[c.country] || c.country}
                          </Badge>
                          {c.year && (
                            <span className="text-gray-500 text-[10px]">
                              {c.year}
                            </span>
                          )}
                          {/* Always-visible impact badge — computed from LLM data or heuristics */}
                          <button
                            onClick={openInBrowser}
                            className="cursor-pointer hover:scale-110 hover:brightness-125 transition-all hover:ring-1 hover:ring-accent/30 rounded-full"
                            title={c.url ? `${impactLabel} — click to open article` : impactLabel}
                          >
                            <Badge variant={variant} size="sm">
                              {impactLabel}
                            </Badge>
                          </button>
                          {c.evidence_level && (
                            <button
                              onClick={openInBrowser}
                              className="text-[9px] text-gray-500 font-medium bg-surface/80 px-1.5 py-0.5 rounded cursor-pointer hover:text-accent/80 hover:bg-surface transition-colors"
                              title={c.url ? `${c.evidence_level} — click to open article` : c.evidence_level}
                            >
                              {c.evidence_level}
                            </button>
                          )}
                          {c.url && (
                            <button
                              onClick={openInBrowser}
                              className="text-[10px] text-accent/50 hover:text-accent/80 ml-auto cursor-pointer transition-colors"
                            >
                              Open &nearr;
                            </button>
                          )}
                        </div>
                        <button
                          onClick={openInBrowser}
                          className="text-gray-400 mt-0.5 truncate block text-left w-full cursor-pointer hover:text-accent/70 transition-colors"
                          title={c.url ? `Open: ${c.title}` : c.title}
                        >
                          {c.title}
                        </button>
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
