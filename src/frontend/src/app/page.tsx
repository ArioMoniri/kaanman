"use client";

import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { ChatInput } from "@/components/chat-input";
import { MessageBubble, type Message, type DeepLinkEntity } from "@/components/message-bubble";
import { PatientBanner } from "@/components/patient-banner";
import { StatusBar } from "@/components/status-bar";
import { ReferenceSidebar } from "@/components/reference-sidebar";
import { KnowledgeGraph } from "@/components/knowledge-graph";
import { DecisionTreeViewer } from "@/components/decision-tree-viewer";
import { ReferenceLegend } from "@/components/reference-legend";
import { ShimmerText } from "@/components/ui/shimmer-text";
import { CerebraLinkLogo } from "@/components/ui/cerebralink-logo";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8100";

/* Resizable sidebar wrapper — drag handle on left edge */
function ResizableSidebar({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const [width, setWidth] = useState(420);
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(420);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    startX.current = e.clientX;
    startW.current = width;
    e.preventDefault();
  }, [width]);

  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      if (!isDragging.current) return;
      const delta = startX.current - e.clientX;
      const newWidth = Math.max(280, Math.min(startW.current + delta, window.innerWidth * 0.6));
      setWidth(newWidth);
    }
    function handleMouseUp() {
      isDragging.current = false;
    }
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  return (
    <div
      className="fixed top-0 right-0 h-screen z-40 bg-[#131316] flex"
      style={{ width }}
    >
      {/* Drag handle — wide hit area with visible grip dots */}
      <div
        onMouseDown={handleMouseDown}
        className="w-4 h-full cursor-col-resize bg-[#1a1a1e] hover:bg-accent/20 active:bg-accent/40 transition-colors border-l border-border/40 shrink-0 flex items-center justify-center group"
        style={{ touchAction: "none" }}
      >
        <div className="flex flex-col items-center gap-1 opacity-80 group-hover:opacity-100 transition-opacity">
          <div className="w-1 h-1 rounded-full bg-gray-500 group-hover:bg-accent" />
          <div className="w-1 h-1 rounded-full bg-gray-500 group-hover:bg-accent" />
          <div className="w-1 h-1 rounded-full bg-gray-500 group-hover:bg-accent" />
          <div className="w-1 h-1 rounded-full bg-gray-500 group-hover:bg-accent" />
          <div className="w-1 h-1 rounded-full bg-gray-500 group-hover:bg-accent" />
          <div className="w-1 h-1 rounded-full bg-gray-500 group-hover:bg-accent" />
          <div className="w-1 h-1 rounded-full bg-gray-500 group-hover:bg-accent" />
        </div>
      </div>
      {/* Sidebar content */}
      <div className="flex-1 min-w-0 h-full">
        {children}
      </div>
    </div>
  );
}

interface AgentStatusItem {
  agent: string;
  status: "running" | "done" | "error";
  message?: string;
  time_ms?: number;
  tokens?: { input_tokens: number; output_tokens: number };
}

interface DecisionTreeData {
  title: string;
  nodes: { id: string; type?: string; data: Record<string, unknown>; position: Record<string, unknown> }[];
  edges: { id: string; source: string; target: string; label?: string }[];
}

/* History session entry persisted to localStorage */
interface HistoryEntry {
  sessionId: string;
  patientName: string | null;
  protocolNumber: string | null;
  timestamp: number;
  messageCount: number;
  firstQuery: string;
}

/** Extract entity names from patient data for Obsidian-style deep links */
function extractPatientEntities(data: Record<string, unknown> | null): DeepLinkEntity[] {
  if (!data) return [];
  const entities: DeepLinkEntity[] = [];
  const seen = new Set<string>();

  const patient = (data.patient as Record<string, unknown>) || data;
  const episodes = (data.episodes as Record<string, unknown>[]) || [];

  // Departments
  for (const ep of episodes) {
    const svc = (ep.service_name as string) || "";
    if (svc && svc.length > 2 && !seen.has(svc.toLowerCase())) {
      seen.add(svc.toLowerCase());
      entities.push({ text: svc, category: "department", label: svc });
    }
  }

  // Diagnoses
  for (const ep of episodes) {
    for (const d of ((ep.diagnosis as Record<string, unknown>[]) || [])) {
      const name = (d.DiagnosisName as string) || (d.diagnosis_name as string) || "";
      if (name && name.length > 3 && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        entities.push({ text: name, category: "diagnosis", label: name });
      }
    }
  }

  // Medications
  const recipes = ((patient.previous_recipes as Record<string, unknown>[]) || []);
  for (const med of recipes) {
    const name = (med.MedicineName as string) || (med.medicine_name as string) || (med.name as string) || "";
    if (name && name.length > 3 && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      entities.push({ text: name, category: "medication", label: name });
    }
  }

  // Doctors
  for (const ep of episodes) {
    const doc = (ep.doctor_name as string) || "";
    if (doc && doc.length > 3 && !seen.has(doc.toLowerCase())) {
      seen.add(doc.toLowerCase());
      entities.push({ text: doc, category: "doctor", label: doc });
    }
  }

  return entities;
}

const HISTORY_KEY = "cerebralink_history";

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveHistory(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, 50)));
  } catch { /* quota exceeded — ignore */ }
}

function upsertHistory(entry: HistoryEntry) {
  const existing = loadHistory();
  const idx = existing.findIndex((e) => e.sessionId === entry.sessionId);
  if (idx >= 0) {
    existing[idx] = { ...existing[idx], ...entry };
  } else {
    existing.unshift(entry);
  }
  saveHistory(existing);
}

/* History drawer component */
function HistoryDrawer({ onClose, onRestore }: { onClose: () => void; onRestore: (entry: HistoryEntry) => void }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);

  useEffect(() => { setEntries(loadHistory()); }, []);

  const handleDelete = (sessionId: string) => {
    const updated = entries.filter((e) => e.sessionId !== sessionId);
    saveHistory(updated);
    setEntries(updated);
  };

  return (
    <div className="fixed inset-0 z-50 flex" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative ml-auto w-full max-w-sm h-full bg-[#111114] border-l border-white/10 flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <h2 className="text-sm font-semibold text-gray-200">Patient History</h2>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-200 text-lg px-2 py-1 rounded hover:bg-white/5">&times;</button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center p-6">
              <div className="text-gray-600 text-sm">No previous sessions</div>
              <div className="text-gray-700 text-xs mt-1">Past patient conversations will appear here</div>
            </div>
          ) : (
            entries.map((entry) => (
              <div
                key={entry.sessionId}
                className="px-5 py-3 border-b border-white/5 hover:bg-white/[0.03] transition-colors cursor-pointer group"
                onClick={() => onRestore(entry)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-200 truncate">
                      {entry.patientName || "Unknown Patient"}
                    </div>
                    {entry.protocolNumber && (
                      <div className="text-xs text-indigo-400/80 mt-0.5">Protocol: {entry.protocolNumber}</div>
                    )}
                    <div className="text-xs text-gray-500 mt-1 truncate">{entry.firstQuery}</div>
                    <div className="flex items-center gap-3 mt-1.5">
                      <span className="text-[10px] text-gray-600">{new Date(entry.timestamp).toLocaleDateString()}</span>
                      <span className="text-[10px] text-gray-600">{entry.messageCount} messages</span>
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(entry.sessionId); }}
                    className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 text-xs px-1.5 py-0.5 rounded transition-all"
                    title="Remove from history"
                  >
                    &times;
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [patientSummary, setPatientSummary] = useState<string | null>(null);
  const [patientData, setPatientData] = useState<Record<string, unknown> | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<AgentStatusItem[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [totalTokens, setTotalTokens] = useState({ input: 0, output: 0 });

  // Sidebar & modal state
  const [showReferences, setShowReferences] = useState(false);
  const [showKnowledgeGraph, setShowKnowledgeGraph] = useState(false);
  const [activeDecisionTree, setActiveDecisionTree] = useState<DecisionTreeData | null>(null);
  const [refUrl, setRefUrl] = useState<string | undefined>(undefined);
  const [refTitle, setRefTitle] = useState<string | undefined>(undefined);
  const [showHistory, setShowHistory] = useState(false);
  const [kgFocusLabel, setKgFocusLabel] = useState<string | undefined>(undefined);

  // Patient entities for Obsidian-style deep links
  const patientEntities = useMemo(() => extractPatientEntities(patientData), [patientData]);

  // Abort controller for cancelling requests
  const abortControllerRef = useRef<AbortController | null>(null);

  const handleOpenReferenceUrl = useCallback((url: string, title: string) => {
    setRefUrl(url);
    setRefTitle(title);
    setShowReferences(true);
  }, []);

  const handleOpenKgWithFocus = useCallback((label?: string) => {
    setKgFocusLabel(label);
    setShowKnowledgeGraph(true);
  }, []);

  // Find the latest message with citations/guidelines for the reference sidebar
  const latestRefMsg = [...messages].reverse().find(
    (m) => m.role === "assistant" && ((m.citations && m.citations.length > 0) || (m.guidelines_used && m.guidelines_used.length > 0))
  );

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingMsgIdRef = useRef<string | null>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, agentStatuses, scrollToBottom]);

  const startTimer = useCallback(() => {
    const t0 = Date.now();
    timerRef.current = setInterval(() => {
      setElapsed(Date.now() - t0);
    }, 100);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handleCancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsLoading(false);
    stopTimer();
  }, [stopTimer]);

  const handleSend = async (text: string) => {
    if (!text.trim() || isLoading) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);
    setAgentStatuses([]);
    setElapsed(0);
    setTotalTokens({ input: 0, output: 0 });
    pendingMsgIdRef.current = null;
    startTimer();

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const resp = await fetch(`${API_URL}/api/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, session_id: sessionId }),
        signal: controller.signal,
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      if (!resp.body) throw new Error("No response body");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventType = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            const dataStr = line.slice(6);
            try {
              const data = JSON.parse(dataStr);

              if (eventType === "status") {
                setAgentStatuses((prev) => {
                  const existing = prev.findIndex(
                    (a) => a.agent === data.agent
                  );
                  const item: AgentStatusItem = {
                    agent: data.agent,
                    status: data.status,
                    message: data.message,
                    time_ms: data.time_ms,
                    tokens: data.tokens,
                  };
                  if (existing >= 0) {
                    const next = [...prev];
                    next[existing] = item;
                    return next;
                  }
                  return [...prev, item];
                });

                if (data.status === "done" && data.tokens) {
                  setTotalTokens((prev) => ({
                    input: prev.input + (data.tokens.input_tokens || 0),
                    output: prev.output + (data.tokens.output_tokens || 0),
                  }));
                }

                // If patient_fetch succeeded, store patient data
                if (data.agent === "patient_fetch" && data.status === "done") {
                  // Patient data will come in the result event
                }
              } else if (eventType === "fast_answer") {
                const msgId = crypto.randomUUID();
                pendingMsgIdRef.current = msgId;
                const fastMsg: Message = {
                  id: msgId,
                  role: "assistant",
                  content: data.fast_answer,
                  fast_answer: data.fast_answer,
                  guidelines_used: data.guidelines_used,
                  citations: data.citations,
                  timestamp: Date.now(),
                };
                setMessages((prev) => [...prev, fastMsg]);
              } else if (eventType === "result") {
                if (!sessionId) setSessionId(data.session_id);

                // Store patient data if available in the result
                if (data.patient_context) {
                  setPatientData(data.patient_context);
                  const pt = data.patient_context.patient || data.patient_context;
                  setPatientSummary(
                    pt.full_name ||
                    pt.page_title ||
                    data.patient_context.full_name ||
                    data.patient_context.page_title ||
                    "Patient data loaded"
                  );
                }

                const pendingId = pendingMsgIdRef.current;
                const fullMsg: Message = {
                  id: pendingId || crypto.randomUUID(),
                  role: "assistant",
                  content: data.fast_answer,
                  fast_answer: data.fast_answer,
                  complete_answer: data.complete_answer,
                  trust_scores: data.trust_scores,
                  trust_reasons: data.trust_reasons,
                  scorer_confidence: data.scorer_confidence,
                  guidelines_used: data.guidelines_used,
                  citations: data.citations,
                  agents_used: data.agents_used,
                  agent_timings: data.agent_timings,
                  total_time_ms: data.total_time_ms,
                  total_input_tokens: data.total_input_tokens,
                  total_output_tokens: data.total_output_tokens,
                  decision_tree: data.decision_tree,
                  language: data.language,
                  priority_country: data.priority_country,
                  timestamp: Date.now(),
                };

                setMessages((prev) => {
                  // Strategy 1: Replace by pending ID
                  if (pendingId) {
                    const idx = prev.findIndex((m) => m.id === pendingId);
                    if (idx >= 0) {
                      const next = [...prev];
                      next[idx] = fullMsg;
                      return next;
                    }
                  }
                  // Strategy 2: Replace the last fast-only assistant message
                  for (let i = prev.length - 1; i >= 0; i--) {
                    if (
                      prev[i].role === "assistant" &&
                      prev[i].fast_answer &&
                      !prev[i].complete_answer
                    ) {
                      const next = [...prev];
                      next[i] = { ...fullMsg, id: prev[i].id };
                      return next;
                    }
                  }
                  // Strategy 3: Append as new message
                  return [...prev, fullMsg];
                });
                pendingMsgIdRef.current = null;
              } else if (eventType === "error") {
                const errorMsg: Message = {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: `Error: ${data.message}`,
                  timestamp: Date.now(),
                };
                setMessages((prev) => [...prev, errorMsg]);
              }
            } catch {
              // skip malformed JSON
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // User cancelled — do nothing
      } else {
        const errorMsg: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `Connection error: ${err instanceof Error ? err.message : "Unknown error"}. Make sure the backend is running on ${API_URL}.`,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, errorMsg]);
      }
    } finally {
      setIsLoading(false);
      stopTimer();
      abortControllerRef.current = null;
    }
  };

  const handleNewChat = async () => {
    handleCancel();
    if (sessionId) {
      await fetch(`${API_URL}/api/patient/clear?session_id=${sessionId}`, {
        method: "POST",
      }).catch(() => {});
    }
    setPatientSummary(null);
    setPatientData(null);
    setSessionId(null);
    setMessages([]);
    setAgentStatuses([]);
    setShowReferences(false);
    setActiveDecisionTree(null);
    setShowKnowledgeGraph(false);
  };

  // Check for patient data on session
  useEffect(() => {
    if (!sessionId) return;
    fetch(`${API_URL}/api/session/${sessionId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.patient_summary) {
          setPatientSummary(data.patient_summary);
        }
      })
      .catch(() => {});
  }, [sessionId]);

  // Persist session to history whenever messages or patient change
  useEffect(() => {
    if (!sessionId || messages.length === 0) return;
    const firstUserMsg = messages.find((m) => m.role === "user");
    // Try to extract protocol number from patient data
    const protocolNumber =
      (patientData as Record<string, unknown>)?.protocol_no as string ||
      (patientData as Record<string, unknown>)?.patient_id as string ||
      ((patientData as Record<string, unknown>)?.patient as Record<string, unknown>)?.patient_id as string ||
      null;
    upsertHistory({
      sessionId,
      patientName: patientSummary,
      protocolNumber: protocolNumber || null,
      timestamp: Date.now(),
      messageCount: messages.length,
      firstQuery: firstUserMsg?.content?.slice(0, 100) || "",
    });
  }, [sessionId, messages.length, patientSummary, patientData, messages]);

  // Restore a previous session from history
  const handleRestoreSession = useCallback(async (entry: HistoryEntry) => {
    setShowHistory(false);
    setSessionId(entry.sessionId);
    setMessages([]);
    setPatientData(null);
    setPatientSummary(entry.patientName);
    setAgentStatuses([]);
    setShowReferences(false);
    setActiveDecisionTree(null);
    setShowKnowledgeGraph(false);

    // Re-fetch session info from backend to get patient context
    try {
      const resp = await fetch(`${API_URL}/api/session/${entry.sessionId}`);
      const data = await resp.json();
      if (data.patient_summary) {
        setPatientSummary(data.patient_summary);
      }
    } catch { /* session may have expired */ }
  }, []);

  return (
    <div className="flex h-screen relative">
      {/* Main chat area — always centered */}
      <div className="flex flex-col mx-auto w-full max-w-[720px] min-w-0">
        {/* Header */}
        <header className="flex items-center justify-between px-6 py-4 border-b border-border/30">
          <div className="flex items-center gap-3">
            <CerebraLinkLogo size={38} />
            <div>
              <h1 className="text-xl font-bold text-gray-100">CerebraLink</h1>
              <p className="text-sm text-gray-500">Medical AI Assistant</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ReferenceLegend />
            {patientData && (
              <button
                onClick={() => setShowKnowledgeGraph(true)}
                className="text-xs text-emerald-400/80 hover:text-emerald-400 transition-colors px-3 py-1.5 rounded-lg border border-emerald-500/30 hover:border-emerald-500/50"
              >
                Knowledge Graph
              </button>
            )}
            <button
              onClick={() => setShowHistory(true)}
              className="text-xs text-indigo-400/80 hover:text-indigo-400 transition-colors px-3 py-1.5 rounded-lg border border-indigo-500/30 hover:border-indigo-500/50"
              title="Patient History"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="inline mr-1 -mt-0.5">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              History
            </button>
            <button
              onClick={handleNewChat}
              className="text-xs text-gray-400 hover:text-gray-200 transition-colors px-3 py-1.5 rounded-lg border border-border/50 hover:border-border bg-surface hover:bg-surface-light"
            >
              + New Chat
            </button>
          </div>
        </header>

        {/* Patient Banner */}
        {patientSummary && <PatientBanner summary={patientSummary} />}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="mb-4">
                <CerebraLinkLogo size={80} />
              </div>
              <h2 className="text-xl font-bold text-gray-200 mb-2">
                CerebraLink
              </h2>
              <p className="text-gray-500 max-w-md text-sm leading-relaxed">
                Medical AI assistant with multi-agent council. Ask any clinical
                question — get fast and complete answers backed by the latest
                guidelines with LaTeX calculations.
              </p>
            </div>
          )}

          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              onOpenDecisionTree={(tree) => setActiveDecisionTree(tree)}
              onOpenKnowledgeGraph={() => setShowKnowledgeGraph(true)}
              onOpenKnowledgeGraphFocus={handleOpenKgWithFocus}
              onOpenReferences={() => setShowReferences(true)}
              onOpenReferenceUrl={handleOpenReferenceUrl}
              hasPatientData={!!patientData}
              patientEntities={patientEntities}
            />
          ))}

          {/* Status bar */}
          {isLoading && agentStatuses.length > 0 && (
            <StatusBar
              agents={agentStatuses}
              elapsed={elapsed}
              totalTokens={totalTokens}
            />
          )}

          {isLoading && agentStatuses.length === 0 && (
            <div className="pl-2">
              <ShimmerText text="Connecting to agent council..." showChevron={false} />
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Chat Input */}
        <div className="px-4 pb-6 pt-2">
          <ChatInput onSend={handleSend} isLoading={isLoading} onCancel={handleCancel} />
        </div>
      </div>

      {/* Reference Sidebar — fixed to right edge, resizable */}
      {showReferences && (latestRefMsg || refUrl) && (
        <ResizableSidebar
          onClose={() => { setShowReferences(false); setRefUrl(undefined); setRefTitle(undefined); }}
        >
          <ReferenceSidebar
            citations={latestRefMsg?.citations || []}
            guidelines={latestRefMsg?.guidelines_used || []}
            onClose={() => { setShowReferences(false); setRefUrl(undefined); setRefTitle(undefined); }}
            initialUrl={refUrl}
            initialTitle={refTitle}
          />
        </ResizableSidebar>
      )}

      {/* Knowledge Graph Modal */}
      {showKnowledgeGraph && patientData && (
        <KnowledgeGraph
          patientData={patientData}
          onClose={() => { setShowKnowledgeGraph(false); setKgFocusLabel(undefined); }}
          focusLabel={kgFocusLabel}
        />
      )}

      {/* Decision Tree Modal */}
      {activeDecisionTree && (
        <DecisionTreeViewer
          title={activeDecisionTree.title}
          nodes={activeDecisionTree.nodes}
          edges={activeDecisionTree.edges}
          onClose={() => setActiveDecisionTree(null)}
        />
      )}

      {/* History Drawer */}
      {showHistory && (
        <HistoryDrawer
          onClose={() => setShowHistory(false)}
          onRestore={handleRestoreSession}
        />
      )}
    </div>
  );
}
