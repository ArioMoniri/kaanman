"use client";

import React, { useState, useMemo, useRef, useEffect } from "react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface AgentTiming {
  agent: string;
  time_ms: number;
  input_tokens: number;
  output_tokens: number;
}

interface MessageLike {
  role: "user" | "assistant";
  agent_timings?: AgentTiming[];
  total_input_tokens?: number;
  total_output_tokens?: number;
}

interface AgentStatusLike {
  agent: string;
  status: "running" | "done" | "error";
  tokens?: { input_tokens: number; output_tokens: number };
}

interface ContextWindowBarProps {
  messages: MessageLike[];
  agentStatuses: AgentStatusLike[];
}

/* ------------------------------------------------------------------ */
/*  Agent → Model mapping (mirrors backend config.py)                  */
/* ------------------------------------------------------------------ */

interface ModelInfo {
  name: string;
  short: string;
  contextWindow: number;
  tier: "opus" | "sonnet" | "haiku";
}

const MODELS: Record<string, ModelInfo> = {
  "claude-opus-4-6":             { name: "Claude Opus 4",   short: "Opus",   contextWindow: 200_000, tier: "opus" },
  "claude-sonnet-4-6":           { name: "Claude Sonnet 4", short: "Sonnet", contextWindow: 200_000, tier: "sonnet" },
  "claude-haiku-4-5-20251001":   { name: "Claude Haiku 4.5",short: "Haiku",  contextWindow: 200_000, tier: "haiku" },
};

const AGENT_MODEL_MAP: Record<string, string> = {
  router:            "claude-haiku-4-5-20251001",
  phi_check:         "claude-haiku-4-5-20251001",
  trust_scorer:      "claude-haiku-4-5-20251001",
  clinical:          "claude-opus-4-6",
  decision_tree:     "claude-opus-4-6",
  research:          "claude-sonnet-4-6",
  drug:              "claude-sonnet-4-6",
  reports:           "claude-sonnet-4-6",
  episodes:          "claude-sonnet-4-6",
  composer_fast:     "claude-sonnet-4-6",
  composer_complete: "claude-sonnet-4-6",
};

const AGENT_LABELS: Record<string, string> = {
  router:            "Router",
  patient_fetch:     "Patient Fetch",
  reports_fetch:     "Reports Fetch",
  episodes_fetch:    "Episodes Fetch",
  reports_index:     "Reports Index",
  episodes_index:    "Episodes Index",
  clinical:          "Clinical",
  research:          "Research",
  drug:              "Drug Check",
  reports:           "Reports",
  episodes:          "Episodes",
  composer_fast:     "Fast Composer",
  composer_complete: "Full Composer",
  decision_tree:     "Decision Tree",
  trust_scorer:      "Trust Scorer",
  phi_check:         "PHI Check",
};

const AGENT_ICONS: Record<string, string> = {
  router:            "🔀",
  patient_fetch:     "📋",
  reports_fetch:     "📄",
  episodes_fetch:    "📑",
  reports_index:     "🗂️",
  episodes_index:    "🗂️",
  clinical:          "🧠",
  research:          "🔬",
  drug:              "💊",
  reports:           "📊",
  episodes:          "📅",
  composer_fast:     "⚡",
  composer_complete: "📝",
  decision_tree:     "🌳",
  trust_scorer:      "🛡️",
  phi_check:         "🔒",
};

const TIER_COLORS: Record<string, { bar: string; barBg: string; text: string; badge: string; badgeBg: string }> = {
  opus:   { bar: "#c084fc", barBg: "rgba(192,132,252,0.12)", text: "#e9d5ff", badge: "#c084fc", badgeBg: "rgba(192,132,252,0.15)" },
  sonnet: { bar: "#60a5fa", barBg: "rgba(96,165,250,0.12)",  text: "#dbeafe", badge: "#60a5fa", badgeBg: "rgba(96,165,250,0.15)" },
  haiku:  { bar: "#34d399", barBg: "rgba(52,211,153,0.12)",  text: "#d1fae5", badge: "#34d399", badgeBg: "rgba(52,211,153,0.15)" },
};

/* ------------------------------------------------------------------ */
/*  Per-agent usage computation                                        */
/* ------------------------------------------------------------------ */

interface AgentUsage {
  agent: string;
  model: ModelInfo;
  perQuery: { input: number; output: number }[];
  totalInput: number;
  totalOutput: number;
  totalTokens: number;
  fillPct: number;
  isLive: boolean;    // currently in-flight
  liveInput: number;
  liveOutput: number;
}

function computeAgentUsage(
  messages: MessageLike[],
  agentStatuses: AgentStatusLike[],
): AgentUsage[] {
  // 1. Accumulate from completed messages (agent_timings in assistant messages)
  const history = new Map<string, { perQuery: { input: number; output: number }[]; totalInput: number; totalOutput: number }>();

  // Count how many completed assistant messages have agent_timings (= completed queries)
  let completedQueries = 0;
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.agent_timings && msg.agent_timings.length > 0) {
      completedQueries++;
      for (const t of msg.agent_timings) {
        if (!history.has(t.agent)) {
          history.set(t.agent, { perQuery: [], totalInput: 0, totalOutput: 0 });
        }
        const h = history.get(t.agent)!;
        h.perQuery.push({ input: t.input_tokens, output: t.output_tokens });
        h.totalInput += t.input_tokens;
        h.totalOutput += t.output_tokens;
      }
    }
  }

  // 2. Always collect from agentStatuses (live streaming + recently completed)
  //    This ensures agents that appear during streaming are visible even after
  //    the query completes and agent_timings may not include all of them.
  const liveAgents = new Map<string, { input: number; output: number; running: boolean }>();
  for (const s of agentStatuses) {
    if (s.status === "done" && s.tokens) {
      liveAgents.set(s.agent, {
        input: s.tokens.input_tokens,
        output: s.tokens.output_tokens,
        running: false,
      });
    } else if (s.status === "running") {
      liveAgents.set(s.agent, { input: 0, output: 0, running: true });
    }
  }

  // 3. Determine which live agents are already captured in the latest completed
  //    message's agent_timings to avoid double-counting
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const latestTimingAgents = new Set<string>();
  if (lastMsg?.role === "assistant" && lastMsg.agent_timings && lastMsg.agent_timings.length > 0) {
    for (const t of lastMsg.agent_timings) {
      latestTimingAgents.add(t.agent);
    }
  }

  // 4. Merge: include all agents from history + live
  const allAgentsList = Array.from(new Set([...Array.from(history.keys()), ...Array.from(liveAgents.keys())]));
  const defaultModel = MODELS["claude-sonnet-4-6"];
  const result: AgentUsage[] = [];

  for (let ai = 0; ai < allAgentsList.length; ai++) {
    const agent = allAgentsList[ai];
    // Skip non-LLM agents (fetchers, indexers — they don't use context windows)
    const modelId = AGENT_MODEL_MAP[agent];
    if (!modelId) continue;

    const model = MODELS[modelId] || defaultModel;
    const h = history.get(agent);
    const live = liveAgents.get(agent);

    // Deduplicate: if agent has history data AND appears in the latest
    // message's agent_timings, its live data is already captured — skip it
    const liveAlreadyCaptured = h ? latestTimingAgents.has(agent) : false;

    const effectiveLiveInput = liveAlreadyCaptured ? 0 : (live?.input || 0);
    const effectiveLiveOutput = liveAlreadyCaptured ? 0 : (live?.output || 0);

    const totalInput = (h?.totalInput || 0) + effectiveLiveInput;
    const totalOutput = (h?.totalOutput || 0) + effectiveLiveOutput;
    const perQuery = h ? [...h.perQuery] : [];

    // If agent is only from live (no history), add its data as a query entry
    if (!h && live && !liveAlreadyCaptured && (live.input > 0 || live.output > 0)) {
      perQuery.push({ input: live.input, output: live.output });
    }

    const liveInput = effectiveLiveInput;
    const liveOutput = effectiveLiveOutput;
    const isLive = !liveAlreadyCaptured && liveAgents.has(agent);

    const grandTotal = totalInput + totalOutput;
    const fillPct = (grandTotal / model.contextWindow) * 100;

    result.push({
      agent,
      model,
      perQuery,
      totalInput,
      totalOutput,
      totalTokens: grandTotal,
      fillPct: Math.min(fillPct, 100),
      isLive,
      liveInput,
      liveOutput,
    });
  }

  // Sort: highest fill first
  result.sort((a, b) => b.totalTokens - a.totalTokens);
  return result;
}

/* ------------------------------------------------------------------ */
/*  Formatters                                                         */
/* ------------------------------------------------------------------ */

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtPct(pct: number): string {
  if (pct < 0.1) return "<0.1%";
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

/* ------------------------------------------------------------------ */
/*  Progress bar component                                             */
/* ------------------------------------------------------------------ */

function ProgressBar({
  pct,
  color,
  bgColor,
  height = 6,
  animated = false,
}: {
  pct: number;
  color: string;
  bgColor: string;
  height?: number;
  animated?: boolean;
}) {
  return (
    <div
      style={{
        width: "100%",
        height,
        borderRadius: height / 2,
        background: bgColor,
        overflow: "hidden",
        position: "relative",
      }}
    >
      <div
        style={{
          width: `${Math.min(pct, 100)}%`,
          height: "100%",
          borderRadius: height / 2,
          background: `linear-gradient(90deg, ${color}cc, ${color})`,
          transition: "width 0.6s ease",
          boxShadow: pct > 0 ? `0 0 8px ${color}40` : "none",
          animation: animated ? "context-pulse 1.5s ease-in-out infinite" : undefined,
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main exported component                                            */
/* ------------------------------------------------------------------ */

export function ContextWindowBar({ messages, agentStatuses }: ContextWindowBarProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as globalThis.Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen]);

  const agents = useMemo(
    () => computeAgentUsage(messages, agentStatuses),
    [messages, agentStatuses],
  );

  // Session-level aggregates
  const sessionTotal = useMemo(() => {
    let input = 0, output = 0;
    for (const a of agents) {
      input += a.totalInput;
      output += a.totalOutput;
    }
    return { input, output, total: input + output };
  }, [agents]);

  // Group by model tier
  const tierTotals = useMemo(() => {
    const tiers: Record<string, { input: number; output: number; agents: string[] }> = {};
    for (const a of agents) {
      const tier = a.model.tier;
      if (!tiers[tier]) tiers[tier] = { input: 0, output: 0, agents: [] };
      tiers[tier].input += a.totalInput;
      tiers[tier].output += a.totalOutput;
      tiers[tier].agents.push(a.agent);
    }
    return tiers;
  }, [agents]);

  const hasAnyData = sessionTotal.total > 0 || agentStatuses.length > 0;
  const isProcessing = agentStatuses.some((s) => s.status === "running");

  // The total session fill against a single model's context (for summary bar)
  const maxContextWindow = 200_000;
  const sessionFillPct = (sessionTotal.total / maxContextWindow) * 100;

  if (!hasAnyData) return null;

  return (
    <div ref={panelRef} style={{ position: "relative", zIndex: 50 }}>
      <style>{`
        @keyframes context-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
      `}</style>

      {/* Trigger button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold transition-all border"
        style={{
          background: isOpen ? "rgba(129,140,248,0.15)" : "rgba(255,255,255,0.03)",
          color: isOpen ? "#a5b4fc" : "#9ca3af",
          borderColor: isOpen ? "rgba(129,140,248,0.3)" : "rgba(255,255,255,0.08)",
        }}
        title="Agent context window usage"
      >
        {/* Mini bar icon */}
        <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 12 }}>
          {[0.3, 0.6, 0.45, 0.8].map((h, i) => (
            <div
              key={i}
              style={{
                width: 2.5,
                height: `${h * 100}%`,
                borderRadius: 1,
                background: isProcessing
                  ? `hsl(${220 + i * 20}, 80%, 65%)`
                  : sessionFillPct > 50
                    ? "#fbbf24"
                    : "#818cf8",
                transition: "all 0.3s",
                animation: isProcessing ? `context-pulse ${1 + i * 0.2}s ease-in-out infinite` : undefined,
              }}
            />
          ))}
        </div>
        <span>{fmtTokens(sessionTotal.total)}</span>
        <svg
          width="10" height="10" viewBox="0 0 10 10" fill="none"
          style={{ transition: "transform 0.2s", transform: isOpen ? "rotate(180deg)" : "rotate(0)" }}
        >
          <path d="M2 4L5 7L8 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Dropdown panel */}
      {isOpen && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            width: 380,
            maxHeight: "70vh",
            overflowY: "auto",
            background: "linear-gradient(180deg, rgba(15,15,20,0.98), rgba(10,10,14,0.98))",
            backdropFilter: "blur(20px)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 14,
            boxShadow: "0 16px 48px rgba(0,0,0,0.6), 0 0 1px rgba(255,255,255,0.1)",
            padding: 0,
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "14px 16px 10px",
              borderBottom: "1px solid rgba(255,255,255,0.06)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#e5e7eb" }}>Context Window Usage</span>
              <span style={{ fontSize: 10, color: "#6b7280" }}>
                {fmtTokens(sessionTotal.total)} total
              </span>
            </div>

            {/* Session summary bar */}
            <div style={{ marginBottom: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                <span style={{ fontSize: 10, color: "#9ca3af" }}>
                  Session: {fmtTokens(sessionTotal.input)} in / {fmtTokens(sessionTotal.output)} out
                </span>
                <span style={{ fontSize: 10, color: sessionFillPct > 75 ? "#fbbf24" : sessionFillPct > 50 ? "#60a5fa" : "#6b7280" }}>
                  {fmtPct(sessionFillPct)}
                </span>
              </div>
              <ProgressBar
                pct={sessionFillPct}
                color={sessionFillPct > 75 ? "#fbbf24" : sessionFillPct > 50 ? "#60a5fa" : "#818cf8"}
                bgColor="rgba(255,255,255,0.04)"
                height={5}
                animated={isProcessing}
              />
            </div>

            {/* Tier summary pills */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {Object.entries(tierTotals).map(([tier, data]) => {
                const tc = TIER_COLORS[tier] || TIER_COLORS.sonnet;
                return (
                  <div
                    key={tier}
                    style={{
                      fontSize: 9,
                      fontWeight: 600,
                      padding: "2px 8px",
                      borderRadius: 6,
                      background: tc.badgeBg,
                      color: tc.badge,
                      border: `1px solid ${tc.badge}25`,
                    }}
                  >
                    {tier.charAt(0).toUpperCase() + tier.slice(1)}: {fmtTokens(data.input + data.output)}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Agent list */}
          <div style={{ padding: "6px 0" }}>
            {agents.length === 0 && (
              <div style={{ padding: "20px 16px", textAlign: "center", fontSize: 11, color: "#6b7280" }}>
                No agent activity yet
              </div>
            )}
            {agents.map((a) => {
              const tc = TIER_COLORS[a.model.tier] || TIER_COLORS.sonnet;
              const isExpanded = expandedAgent === a.agent;
              const icon = AGENT_ICONS[a.agent] || "⚙️";
              const label = AGENT_LABELS[a.agent] || a.agent;

              return (
                <div key={a.agent}>
                  <button
                    onClick={() => setExpandedAgent(isExpanded ? null : a.agent)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      width: "100%",
                      padding: "7px 16px",
                      border: "none",
                      background: isExpanded ? "rgba(255,255,255,0.03)" : "transparent",
                      cursor: "pointer",
                      textAlign: "left",
                      transition: "background 0.15s",
                    }}
                    onMouseEnter={(e) => {
                      if (!isExpanded) (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.02)";
                    }}
                    onMouseLeave={(e) => {
                      if (!isExpanded) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                    }}
                  >
                    {/* Icon */}
                    <span style={{ fontSize: 13, width: 18, textAlign: "center", flexShrink: 0 }}>{icon}</span>

                    {/* Label + model badge */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: a.isLive ? "#e5e7eb" : "#d1d5db" }}>
                          {label}
                        </span>
                        <span
                          style={{
                            fontSize: 8,
                            fontWeight: 700,
                            padding: "1px 5px",
                            borderRadius: 4,
                            background: tc.badgeBg,
                            color: tc.badge,
                            letterSpacing: 0.3,
                          }}
                        >
                          {a.model.short}
                        </span>
                        {a.isLive && (
                          <span
                            style={{
                              width: 5,
                              height: 5,
                              borderRadius: "50%",
                              background: "#60a5fa",
                              animation: "context-pulse 1s ease-in-out infinite",
                              flexShrink: 0,
                            }}
                          />
                        )}
                      </div>
                      <ProgressBar
                        pct={a.fillPct}
                        color={tc.bar}
                        bgColor={tc.barBg}
                        height={4}
                        animated={a.isLive}
                      />
                    </div>

                    {/* Token count + percentage */}
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: tc.text }}>
                        {fmtTokens(a.totalTokens)}
                      </div>
                      <div style={{ fontSize: 9, color: "#6b7280" }}>
                        {fmtPct(a.fillPct)}
                      </div>
                    </div>
                  </button>

                  {/* Expanded per-query breakdown */}
                  {isExpanded && (
                    <div
                      style={{
                        padding: "6px 16px 10px 42px",
                        borderBottom: "1px solid rgba(255,255,255,0.04)",
                      }}
                    >
                      {/* Input / Output split */}
                      <div style={{ display: "flex", gap: 16, marginBottom: 6 }}>
                        <div>
                          <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 1 }}>Input</div>
                          <div style={{ fontSize: 11, color: "#d1d5db", fontWeight: 600 }}>
                            {fmtTokens(a.totalInput)}
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 1 }}>Output</div>
                          <div style={{ fontSize: 11, color: "#d1d5db", fontWeight: 600 }}>
                            {fmtTokens(a.totalOutput)}
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 1 }}>Context</div>
                          <div style={{ fontSize: 11, color: "#d1d5db", fontWeight: 600 }}>
                            {fmtTokens(a.model.contextWindow)}
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 1 }}>Queries</div>
                          <div style={{ fontSize: 11, color: "#d1d5db", fontWeight: 600 }}>
                            {a.perQuery.length}{a.isLive ? "+" : ""}
                          </div>
                        </div>
                      </div>

                      {/* Per-query mini bars */}
                      {a.perQuery.length > 0 && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                          <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.6 }}>
                            Per-query breakdown
                          </div>
                          {a.perQuery.map((q, qi) => {
                            const qTotal = q.input + q.output;
                            const qPct = (qTotal / a.model.contextWindow) * 100;
                            return (
                              <div key={qi} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <span style={{ fontSize: 9, color: "#6b7280", width: 18, textAlign: "right", flexShrink: 0 }}>
                                  Q{qi + 1}
                                </span>
                                <div style={{ flex: 1 }}>
                                  <ProgressBar pct={qPct} color={tc.bar} bgColor={tc.barBg} height={3} />
                                </div>
                                <span style={{ fontSize: 9, color: "#9ca3af", width: 45, textAlign: "right", flexShrink: 0 }}>
                                  {fmtTokens(qTotal)}
                                </span>
                              </div>
                            );
                          })}
                          {a.isLive && a.liveInput + a.liveOutput > 0 && (
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <span style={{ fontSize: 9, color: "#60a5fa", width: 18, textAlign: "right", flexShrink: 0 }}>
                                ⚡
                              </span>
                              <div style={{ flex: 1 }}>
                                <ProgressBar
                                  pct={((a.liveInput + a.liveOutput) / a.model.contextWindow) * 100}
                                  color="#60a5fa"
                                  bgColor="rgba(96,165,250,0.08)"
                                  height={3}
                                  animated
                                />
                              </div>
                              <span style={{ fontSize: 9, color: "#60a5fa", width: 45, textAlign: "right", flexShrink: 0 }}>
                                {fmtTokens(a.liveInput + a.liveOutput)}
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div
            style={{
              padding: "8px 16px",
              borderTop: "1px solid rgba(255,255,255,0.06)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span style={{ fontSize: 9, color: "#6b7280" }}>
              {agents.length} agent{agents.length !== 1 ? "s" : ""} · {agents.reduce((s, a) => s + a.perQuery.length, 0)} total calls
            </span>
            <span style={{ fontSize: 9, color: "#6b7280" }}>
              Max context: {fmtTokens(maxContextWindow)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
