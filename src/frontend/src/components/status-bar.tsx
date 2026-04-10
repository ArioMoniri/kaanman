"use client";

import React, { useState, useMemo } from "react";
import {
  CheckCircle2,
  Circle,
  CircleAlert,
  CircleDotDashed,
  CircleX,
  ChevronRight,
} from "lucide-react";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import { ShimmerText } from "./ui/shimmer-text";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Agent metadata & phase grouping
// ---------------------------------------------------------------------------

const AGENT_LABELS: Record<string, string> = {
  router: "Query Router",
  patient_fetch: "Patient Data Fetch",
  clinical: "Clinical Analysis",
  research: "Guideline Research",
  drug: "Drug Interaction Check",
  composer_fast: "Fast Answer Composer",
  composer_complete: "Complete Analysis Composer",
  decision_tree: "Decision Tree Generator",
  trust_scorer: "Trust Scorer",
  phi_check: "PHI Verification",
};

const AGENT_DESCRIPTIONS: Record<string, string> = {
  router: "Classify query type, detect language, extract protocol IDs",
  patient_fetch: "Fetch and mask patient data from Cerebral Plus EHR",
  clinical: "Deep clinical reasoning with patient context and history",
  research: "Search latest guidelines across country-specific sources",
  drug: "Analyze drug interactions, dosing, and contraindications",
  composer_fast: "Generate rapid concise answer from agent outputs",
  composer_complete: "Compose comprehensive analysis with citations",
  decision_tree: "Build clinical decision tree as React Flow diagram",
  trust_scorer: "Evaluate answer confidence across 6 trust dimensions",
  phi_check: "Regex-based PHI scan on final output",
};

interface PhaseGroup {
  id: string;
  title: string;
  agents: string[];
}

const PHASES: PhaseGroup[] = [
  { id: "intake", title: "Routing & Intake", agents: ["router", "patient_fetch"] },
  { id: "council", title: "Agent Council", agents: ["clinical", "research", "drug"] },
  { id: "compose", title: "Composition", agents: ["composer_fast", "composer_complete", "decision_tree"] },
  { id: "validate", title: "Validation", agents: ["trust_scorer", "phi_check"] },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function phaseStatus(
  agents: string[],
  agentMap: Map<string, AgentStatus>
): "completed" | "in-progress" | "error" | "pending" {
  const present = agents.filter((a) => agentMap.has(a));
  if (present.length === 0) return "pending";
  if (present.some((a) => agentMap.get(a)!.status === "error")) return "error";
  if (present.some((a) => agentMap.get(a)!.status === "running")) return "in-progress";
  if (present.every((a) => agentMap.get(a)!.status === "done")) return "completed";
  return "in-progress";
}

function formatTime(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Animation variants
// ---------------------------------------------------------------------------

const prefersReducedMotion =
  typeof window !== "undefined"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;

const taskVariants = {
  hidden: { opacity: 0, y: prefersReducedMotion ? 0 : -5 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      type: prefersReducedMotion ? "tween" : "spring",
      stiffness: 500,
      damping: 30,
      duration: prefersReducedMotion ? 0.2 : undefined,
    },
  },
};

const subtaskListVariants = {
  hidden: { opacity: 0, height: 0, overflow: "hidden" as const },
  visible: {
    height: "auto",
    opacity: 1,
    overflow: "visible" as const,
    transition: {
      duration: 0.25,
      staggerChildren: prefersReducedMotion ? 0 : 0.05,
      when: "beforeChildren" as const,
      ease: [0.2, 0.65, 0.3, 0.9],
    },
  },
  exit: {
    height: 0,
    opacity: 0,
    overflow: "hidden" as const,
    transition: { duration: 0.2, ease: [0.2, 0.65, 0.3, 0.9] },
  },
};

const subtaskVariants = {
  hidden: { opacity: 0, x: prefersReducedMotion ? 0 : -10 },
  visible: {
    opacity: 1,
    x: 0,
    transition: {
      type: prefersReducedMotion ? "tween" : "spring",
      stiffness: 500,
      damping: 25,
      duration: prefersReducedMotion ? 0.2 : undefined,
    },
  },
  exit: {
    opacity: 0,
    x: prefersReducedMotion ? 0 : -10,
    transition: { duration: 0.15 },
  },
};

const detailsVariants = {
  hidden: { opacity: 0, height: 0, overflow: "hidden" as const },
  visible: {
    opacity: 1,
    height: "auto",
    overflow: "visible" as const,
    transition: { duration: 0.25, ease: [0.2, 0.65, 0.3, 0.9] },
  },
};

const statusBadgeVariants = {
  initial: { scale: 1 },
  animate: {
    scale: prefersReducedMotion ? 1 : [1, 1.08, 1],
    transition: { duration: 0.35, ease: [0.34, 1.56, 0.64, 1] },
  },
};

// ---------------------------------------------------------------------------
// Status icon component
// ---------------------------------------------------------------------------

function StatusIcon({
  status,
  size = "sm",
}: {
  status: string;
  size?: "sm" | "md";
}) {
  const cls = size === "md" ? "h-4.5 w-4.5" : "h-3.5 w-3.5";

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={status}
        initial={{ opacity: 0, scale: 0.8, rotate: -10 }}
        animate={{ opacity: 1, scale: 1, rotate: 0 }}
        exit={{ opacity: 0, scale: 0.8, rotate: 10 }}
        transition={{ duration: 0.2, ease: [0.2, 0.65, 0.3, 0.9] }}
      >
        {status === "done" || status === "completed" ? (
          <CheckCircle2 className={`${cls} text-green-500`} />
        ) : status === "running" || status === "in-progress" ? (
          <CircleDotDashed className={`${cls} text-blue-400`} />
        ) : status === "error" ? (
          <CircleX className={`${cls} text-red-400`} />
        ) : status === "need-help" ? (
          <CircleAlert className={`${cls} text-yellow-400`} />
        ) : (
          <Circle className={`${cls} text-gray-600`} />
        )}
      </motion.div>
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// StatusBar component
// ---------------------------------------------------------------------------

export function StatusBar({ agents, elapsed, totalTokens }: StatusBarProps) {
  const agentMap = useMemo(
    () => new Map(agents.map((a) => [a.agent, a])),
    [agents]
  );

  // Auto-expand phases that have active agents
  const activePhaseIds = useMemo(() => {
    return PHASES.filter(
      (p) => p.agents.some((a) => agentMap.has(a))
    ).map((p) => p.id);
  }, [agentMap]);

  const [expandedPhases, setExpandedPhases] = useState<string[]>([]);
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>(
    {}
  );

  // Auto-expand the first in-progress phase
  const autoExpanded = useMemo(() => {
    const inProgress = PHASES.find(
      (p) =>
        activePhaseIds.includes(p.id) &&
        phaseStatus(p.agents, agentMap) === "in-progress"
    );
    return inProgress ? inProgress.id : activePhaseIds[activePhaseIds.length - 1];
  }, [activePhaseIds, agentMap]);

  const isPhaseExpanded = (id: string) =>
    expandedPhases.includes(id) || id === autoExpanded;

  const togglePhase = (id: string) => {
    setExpandedPhases((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const toggleAgent = (key: string) => {
    setExpandedAgents((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Latest running agent for shimmer header
  const latestRunning = agents.filter((a) => a.status === "running").pop();
  const doneCount = agents.filter((a) => a.status === "done").length;

  return (
    <motion.div
      className="mx-2 mb-3 rounded-xl bg-[#1F2023] border border-[#444]/30 shadow overflow-hidden"
      initial={{ opacity: 0, y: 10 }}
      animate={{
        opacity: 1,
        y: 0,
        transition: { duration: 0.3, ease: [0.2, 0.65, 0.3, 0.9] },
      }}
    >
      {/* Shimmer header — latest running agent */}
      {latestRunning && (
        <div className="px-3 py-2.5 border-b border-[#444]/20">
          <ShimmerText text={latestRunning.message || "Processing..."} />
        </div>
      )}

      <LayoutGroup>
        <div className="p-2 overflow-hidden">
          <ul className="space-y-0.5 overflow-hidden">
            {PHASES.map((phase) => {
              const presentAgents = phase.agents.filter((a) =>
                agentMap.has(a)
              );
              if (presentAgents.length === 0) return null;

              const pStatus = phaseStatus(phase.agents, agentMap);
              const expanded = isPhaseExpanded(phase.id);

              return (
                <motion.li
                  key={phase.id}
                  initial="hidden"
                  animate="visible"
                  variants={taskVariants}
                >
                  {/* Phase row */}
                  <motion.div
                    className="group flex items-center px-3 py-1.5 rounded-md cursor-pointer"
                    onClick={() => togglePhase(phase.id)}
                    whileHover={{
                      backgroundColor: "rgba(255,255,255,0.03)",
                      transition: { duration: 0.2 },
                    }}
                  >
                    <motion.div
                      className="mr-2 flex-shrink-0"
                      whileTap={{ scale: 0.9 }}
                    >
                      <StatusIcon status={pStatus} size="md" />
                    </motion.div>

                    <div className="flex min-w-0 flex-grow items-center justify-between">
                      <span
                        className={`text-[13px] font-medium ${
                          pStatus === "completed"
                            ? "text-gray-500 line-through"
                            : "text-gray-200"
                        }`}
                      >
                        {phase.title}
                      </span>

                      <div className="flex flex-shrink-0 items-center gap-2 text-xs">
                        {/* Agent count badge */}
                        <span className="text-[10px] text-gray-600">
                          {presentAgents.filter((a) => agentMap.get(a)!.status === "done").length}
                          /{presentAgents.length}
                        </span>

                        <motion.span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            pStatus === "completed"
                              ? "bg-green-500/15 text-green-400"
                              : pStatus === "in-progress"
                                ? "bg-blue-500/15 text-blue-400"
                                : pStatus === "error"
                                  ? "bg-red-500/15 text-red-400"
                                  : "bg-[#2A2A2E] text-gray-500"
                          }`}
                          variants={statusBadgeVariants}
                          initial="initial"
                          animate="animate"
                          key={pStatus}
                        >
                          {pStatus}
                        </motion.span>

                        <motion.div
                          animate={{ rotate: expanded ? 90 : 0 }}
                          transition={{ duration: 0.2 }}
                        >
                          <ChevronRight size={14} className="text-gray-600" />
                        </motion.div>
                      </div>
                    </div>
                  </motion.div>

                  {/* Agent subtasks */}
                  <AnimatePresence mode="wait">
                    {expanded && (
                      <motion.div
                        className="relative overflow-hidden"
                        variants={subtaskListVariants}
                        initial="hidden"
                        animate="visible"
                        exit="exit"
                        layout
                      >
                        {/* Vertical connecting line */}
                        <div className="absolute top-0 bottom-0 left-[20px] border-l-2 border-dashed border-gray-700/40" />

                        <ul className="mt-0.5 mr-2 mb-1 ml-3 space-y-0.5">
                          {presentAgents.map((agentName) => {
                            const a = agentMap.get(agentName)!;
                            const agentKey = `${phase.id}-${agentName}`;
                            const isExpanded = expandedAgents[agentKey];

                            return (
                              <motion.li
                                key={agentName}
                                className="flex flex-col py-0.5 pl-6"
                                variants={subtaskVariants}
                                initial="hidden"
                                animate="visible"
                                exit="exit"
                                layout
                              >
                                <motion.div
                                  className="flex flex-1 items-center rounded-md px-1.5 py-1 cursor-pointer"
                                  onClick={() => toggleAgent(agentKey)}
                                  whileHover={{
                                    backgroundColor: "rgba(255,255,255,0.03)",
                                    transition: { duration: 0.2 },
                                  }}
                                  layout
                                >
                                  <motion.div
                                    className="mr-2 flex-shrink-0"
                                    layout
                                  >
                                    <StatusIcon status={a.status} size="sm" />
                                  </motion.div>

                                  <div className="flex flex-1 items-center justify-between min-w-0 gap-2">
                                    <span
                                      className={`text-xs ${
                                        a.status === "done"
                                          ? "text-gray-500 line-through"
                                          : a.status === "running"
                                            ? "text-gray-200"
                                            : "text-gray-400"
                                      }`}
                                    >
                                      {AGENT_LABELS[agentName] || agentName}
                                    </span>

                                    <div className="flex items-center gap-1.5 shrink-0">
                                      {a.time_ms != null && a.status === "done" && (
                                        <span className="text-[10px] text-gray-600">
                                          {formatTime(a.time_ms)}
                                        </span>
                                      )}
                                      {a.tokens && a.status === "done" && (
                                        <span className="text-[10px] text-gray-600">
                                          {(a.tokens.input_tokens + a.tokens.output_tokens).toLocaleString()} tok
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </motion.div>

                                {/* Agent details on expand */}
                                <AnimatePresence mode="wait">
                                  {isExpanded && (
                                    <motion.div
                                      className="text-gray-500 border-l border-dashed border-gray-700/30 mt-1 ml-1.5 pl-5 text-[11px] overflow-hidden"
                                      variants={detailsVariants}
                                      initial="hidden"
                                      animate="visible"
                                      exit="hidden"
                                      layout
                                    >
                                      <p className="py-1 text-gray-400">
                                        {AGENT_DESCRIPTIONS[agentName] || ""}
                                      </p>
                                      {a.message && (
                                        <p className="pb-1 text-gray-500 italic">
                                          {a.message}
                                        </p>
                                      )}
                                      {a.tokens && (
                                        <div className="flex gap-3 pb-1 text-[10px]">
                                          <span>
                                            Input: {a.tokens.input_tokens.toLocaleString()} tok
                                          </span>
                                          <span>
                                            Output: {a.tokens.output_tokens.toLocaleString()} tok
                                          </span>
                                        </div>
                                      )}
                                    </motion.div>
                                  )}
                                </AnimatePresence>
                              </motion.li>
                            );
                          })}
                        </ul>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.li>
              );
            })}
          </ul>
        </div>
      </LayoutGroup>

      {/* Stats footer */}
      <div className="px-3 py-1.5 border-t border-[#444]/20 flex items-center gap-4 text-[10px] text-gray-500">
        <span>
          {elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`}
        </span>
        {(totalTokens.input > 0 || totalTokens.output > 0) && (
          <>
            <span>{totalTokens.input.toLocaleString()} in</span>
            <span>{totalTokens.output.toLocaleString()} out</span>
          </>
        )}
        <span className="ml-auto">
          {doneCount}/{agents.length} agents
        </span>
      </div>
    </motion.div>
  );
}
