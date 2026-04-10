"use client";

import React from "react";

interface AgentStatus {
  agent: string;
  status: "running" | "done" | "error";
  message?: string;
  time_ms?: number;
  tokens?: { input_tokens: number; output_tokens: number };
}

interface StatusBarProps {
  agents: AgentStatus[];
  elapsed: number;
  totalTokens: { input: number; output: number };
}

const AGENT_ICONS: Record<string, string> = {
  router: "R",
  clinical: "C",
  research: "S",
  drug: "D",
  composer: "W",
  trust_scorer: "T",
  phi_check: "P",
};

const AGENT_NAMES: Record<string, string> = {
  router: "Router",
  clinical: "Clinical",
  research: "Research",
  drug: "Drug",
  composer: "Composer",
  trust_scorer: "Trust",
  phi_check: "PHI Check",
};

const PHASE_ORDER = [
  "router",
  "clinical",
  "research",
  "drug",
  "composer",
  "trust_scorer",
  "phi_check",
];

export function StatusBar({ agents, elapsed, totalTokens }: StatusBarProps) {
  const agentMap = new Map(agents.map((a) => [a.agent, a]));
  const activeAgents = PHASE_ORDER.filter((a) => agentMap.has(a));
  const latestRunning = agents.filter((a) => a.status === "running").pop();

  return (
    <div className="mx-2 mb-3 rounded-xl bg-surface border border-border/30 overflow-hidden">
      {/* Thinking message */}
      {latestRunning && (
        <div className="px-3 py-2 flex items-center gap-2 border-b border-border/20">
          <div className="flex gap-1">
            <span
              className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce"
              style={{ animationDelay: "0ms" }}
            />
            <span
              className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce"
              style={{ animationDelay: "150ms" }}
            />
            <span
              className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce"
              style={{ animationDelay: "300ms" }}
            />
          </div>
          <span className="text-xs text-gray-400">{latestRunning.message}</span>
        </div>
      )}

      {/* Agent pipeline */}
      <div className="px-3 py-2 flex items-center gap-1.5 flex-wrap">
        {activeAgents.map((name, i) => {
          const a = agentMap.get(name)!;
          const isDone = a.status === "done";
          const isRunning = a.status === "running";

          return (
            <React.Fragment key={name}>
              {i > 0 && (
                <div
                  className={`w-3 h-px ${isDone ? "bg-green-500/50" : "bg-border/40"}`}
                />
              )}
              <div
                className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium border transition-all ${
                  isDone
                    ? "bg-green-500/10 border-green-500/30 text-green-400"
                    : isRunning
                      ? "bg-accent/10 border-accent/30 text-accent animate-pulse"
                      : "bg-surface-light border-border/20 text-gray-500"
                }`}
                title={
                  a.time_ms
                    ? `${a.time_ms}ms | ${a.tokens?.input_tokens || 0} in / ${a.tokens?.output_tokens || 0} out`
                    : undefined
                }
              >
                <span className="font-bold">{AGENT_ICONS[name] || "?"}</span>
                <span>{AGENT_NAMES[name] || name}</span>
                {isDone && a.time_ms != null && (
                  <span className="text-[9px] text-gray-500 ml-0.5">
                    {a.time_ms < 1000
                      ? `${a.time_ms}ms`
                      : `${(a.time_ms / 1000).toFixed(1)}s`}
                  </span>
                )}
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {/* Stats row */}
      <div className="px-3 py-1.5 border-t border-border/20 flex items-center gap-4 text-[10px] text-gray-500">
        <span>
          Time: {elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`}
        </span>
        {(totalTokens.input > 0 || totalTokens.output > 0) && (
          <>
            <span>In: {totalTokens.input.toLocaleString()} tok</span>
            <span>Out: {totalTokens.output.toLocaleString()} tok</span>
          </>
        )}
        <span>
          Agents: {agents.filter((a) => a.status === "done").length}/{agents.length}
        </span>
      </div>
    </div>
  );
}
