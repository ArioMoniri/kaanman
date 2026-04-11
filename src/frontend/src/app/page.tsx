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
import { ReportViewer } from "@/components/report-viewer";
import { TrendMonitor } from "@/components/trend-monitor";
import { ContextWindowBar } from "@/components/context-window-bar";
import type { ManifestEntry } from "@/components/reports-knowledge-graph";
import type { EpisodeEntry } from "@/components/episodes-knowledge-graph";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

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
  const add = (text: string, category: string, label: string) => {
    const key = text.toLowerCase();
    if (!text || text.length < 3 || seen.has(key)) return;
    seen.add(key);
    entities.push({ text, category, label });
  };

  const patient = (data.patient as Record<string, unknown>) || data;
  const episodes = (data.episodes as Record<string, unknown>[]) || [];

  // Departments
  for (const ep of episodes) {
    add((ep.service_name as string) || "", "department", (ep.service_name as string) || "");
  }

  // Diagnoses + ICD codes
  for (const ep of episodes) {
    for (const d of ((ep.diagnosis as Record<string, unknown>[]) || [])) {
      const name = (d.DiagnosisName as string) || (d.diagnosis_name as string) || "";
      add(name, "diagnosis", name);
      const icd = (d.ICDCode as string) || (d.icd_code as string) || "";
      if (icd && icd.length >= 3) add(icd, "icd", name || icd);
    }
  }

  // Medications from prescription history
  for (const med of ((patient.previous_recipes as Record<string, unknown>[]) || [])) {
    const name = (med.MedicineName as string) || (med.medicine_name as string) || (med.name as string) || "";
    add(name, "medication", name);
  }

  // Doctors
  for (const ep of episodes) {
    add((ep.doctor_name as string) || "", "doctor", (ep.doctor_name as string) || "");
  }

  // Facilities
  for (const ep of episodes) {
    const fac = (ep.facility_name as string) || "";
    if (fac.length > 3) add(fac, "facility", fac);
  }

  // Visit dates (DD.MM.YYYY or YYYY-MM-DD)
  for (const ep of episodes) {
    const dt = (ep.date as string) || "";
    if (dt && dt.length >= 8) {
      const svc = (ep.service_name as string) || "Visit";
      add(dt, "episode", `${dt} | ${svc}`);
    }
  }

  // Allergy items
  const allergy = (patient.allergy || data.allergy) as Record<string, unknown> | undefined;
  if (allergy && typeof allergy === "object") {
    for (const [key, val] of Object.entries(allergy)) {
      if (key === "AllergySwc") continue;
      const name = String(val);
      if (name && name.length > 2 && name !== "F" && name !== "T") {
        add(name, "allergy", "Allergy Alert");
      }
    }
  }

  // Complaints / chief complaints
  for (const ep of episodes) {
    for (const c of ((ep.complaint as Record<string, unknown>[]) || [])) {
      const title = (c.COMPLAINTTITLE as string) || (c.complaint_title as string) || "";
      if (title.length > 3) add(title, "diagnosis", title);
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

  // Report state
  const [reportManifest, setReportManifest] = useState<ManifestEntry[] | null>(null);
  const [reportTrends, setReportTrends] = useState<Record<string, unknown[]> | null>(null);
  const [pacsAllStudies, setPacsAllStudies] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] = useState<{
    file: string;
    textFile?: string;
    title: string;
    highlightText?: string;
    reportId?: string;
    accessionNumber?: string;
    fileEndpointType?: "reports" | "episodes";
  } | null>(null);
  const [showTrendMonitor, setShowTrendMonitor] = useState(false);

  // Episode state
  const [episodeManifest, setEpisodeManifest] = useState<EpisodeEntry[] | null>(null);

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

  const handleOpenReport = useCallback(
    (file: string, textFile?: string, title?: string, highlightText?: string) => {
      setSelectedReport({
        file,
        textFile,
        title: title || file,
        highlightText,
      });
    },
    [],
  );

  const handleOpenReportEntry = useCallback(
    (entry: ManifestEntry) => {
      setSelectedReport({
        file: entry.file,
        textFile: entry.text_file,
        title: entry.report_name || entry.file,
        reportId: entry.report_id,
        accessionNumber: entry.accession_number,
      });
    },
    [],
  );

  const [trendFocusTest, setTrendFocusTest] = useState<string | undefined>(undefined);

  const handleOpenTrend = useCallback(
    async (testName?: string) => {
      // Extract protocol ID from patient data
      const pid =
        (patientData as Record<string, unknown>)?.protocol_no as string ||
        (patientData as Record<string, unknown>)?.patient_id as string ||
        ((patientData as Record<string, unknown>)?.patient as Record<string, unknown>)?.patient_id as string ||
        "";
      if (!pid) return;
      // Set focus test for auto-scroll
      setTrendFocusTest(testName);
      // If we already have trends cached, just show the monitor
      if (reportTrends) {
        setShowTrendMonitor(true);
        return;
      }
      try {
        const resp = await fetch(`${API_URL}/api/reports/${pid}/trends`);
        if (!resp.ok) return;
        const json = await resp.json();
        const trends = json.trends || {};
        setReportTrends(trends);
        setShowTrendMonitor(true);
      } catch {
        // silently fail
      }
    },
    [patientData, reportTrends],
  );

  const handleOpenEpisode = useCallback(
    (entry: EpisodeEntry) => {
      // Open episode text file in a simple text viewer via episodes endpoint
      if (entry.output_file) {
        setSelectedReport({
          file: entry.output_file,
          title: `${entry.is_hospitalization ? "Yatış" : "Poliklinik"}: ${entry.date} — ${entry.service_text}`,
          fileEndpointType: "episodes",
        });
      }
    },
    [],
  );

  const handleOpenPacsEntry = useCallback(
    (entry: ManifestEntry) => {
      // Open report viewer with PACS info — the viewer has PACS link handling built-in
      setSelectedReport({
        file: entry.file,
        textFile: entry.text_file,
        title: entry.report_name || entry.file,
        reportId: entry.report_id,
        accessionNumber: entry.accession_number,
      });
    },
    [],
  );

  const handleOpenReportType = useCallback((reportType: string) => {
    setKgFocusLabel(reportType);
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
    setReportManifest(null);
    setReportTrends(null);
    setPacsAllStudies(null);
    setSelectedReport(null);
    setShowTrendMonitor(false);
    setEpisodeManifest(null);
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

  // Fetch report manifest + trends in parallel when patient data is available
  useEffect(() => {
    if (!patientData) return;
    const pid =
      (patientData as Record<string, unknown>)?.protocol_no as string ||
      (patientData as Record<string, unknown>)?.patient_id as string ||
      ((patientData as Record<string, unknown>)?.patient as Record<string, unknown>)?.patient_id as string ||
      "";
    if (!pid) return;

    const fetchManifestAndTrends = async () => {
      try {
        // Fetch manifest, trends, and episodes in parallel
        const [manifestRes, trendsRes, episodesRes] = await Promise.allSettled([
          fetch(`${API_URL}/api/reports/${pid}/manifest`).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          }),
          fetch(`${API_URL}/api/reports/${pid}/trends`).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          }),
          fetch(`${API_URL}/api/episodes/${pid}/manifest`).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          }),
        ]);

        if (manifestRes.status === "fulfilled" && manifestRes.value?.manifest) {
          setReportManifest(manifestRes.value.manifest);
          if (manifestRes.value.pacs_all_studies) {
            setPacsAllStudies(manifestRes.value.pacs_all_studies);
          }
        }
        if (trendsRes.status === "fulfilled" && trendsRes.value?.trends) {
          setReportTrends(trendsRes.value.trends);
        }
        if (episodesRes.status === "fulfilled" && episodesRes.value?.episodes) {
          setEpisodeManifest(episodesRes.value.episodes);
        }

        // If manifest was not found, trigger report fetch
        if (manifestRes.status === "rejected") {
          try {
            const fetchRes = await fetch(`${API_URL}/api/reports/fetch/${pid}`, { method: "POST" });
            if (fetchRes.ok) {
              const data = await fetchRes.json();
              if (data.success) {
                // Re-fetch manifest + trends after download
                const [m, t] = await Promise.allSettled([
                  fetch(`${API_URL}/api/reports/${pid}/manifest`).then((r) => r.json()),
                  fetch(`${API_URL}/api/reports/${pid}/trends`).then((r) => r.json()),
                ]);
                if (m.status === "fulfilled" && m.value?.manifest) {
                  setReportManifest(m.value.manifest);
                  if (m.value.pacs_all_studies) {
                    setPacsAllStudies(m.value.pacs_all_studies);
                  }
                }
                if (t.status === "fulfilled" && t.value?.trends) {
                  setReportTrends(t.value.trends);
                }
              }
            }
          } catch { /* report fetch not available */ }
        }

        // If episodes were not found, trigger episode fetch
        if (episodesRes.status === "rejected") {
          try {
            const epRes = await fetch(`${API_URL}/api/episodes/fetch/${pid}`, { method: "POST" });
            if (epRes.ok) {
              const epData = await epRes.json();
              if (epData.success) {
                const re = await fetch(`${API_URL}/api/episodes/${pid}/manifest`);
                if (re.ok) {
                  const reData = await re.json();
                  if (reData.episodes) setEpisodeManifest(reData.episodes);
                }
              }
            }
          } catch { /* episode fetch not available */ }
        }
      } catch { /* network error */ }
    };

    fetchManifestAndTrends();
  }, [patientData]);

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

    // Fetch full session data: messages + patient context
    try {
      const resp = await fetch(`${API_URL}/api/session/${entry.sessionId}/messages`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      // Restore patient context
      if (data.patient_context) {
        setPatientData(data.patient_context);
        const pt = data.patient_context.patient || data.patient_context;
        setPatientSummary(
          pt.full_name ||
          pt.page_title ||
          data.patient_context.full_name ||
          data.patient_context.page_title ||
          entry.patientName ||
          "Patient data loaded"
        );
      }

      // Convert Redis message history → frontend Message objects
      if (data.messages && data.messages.length > 0) {
        const restored: Message[] = data.messages.map(
          (m: Record<string, unknown>, idx: number) => {
            const msg: Message = {
              id: `restored-${entry.sessionId}-${idx}`,
              role: m.role as "user" | "assistant",
              content: (m.content as string) || "",
              timestamp: ((m.ts as number) || 0) * 1000, // Redis ts is in seconds
            };
            // Restore assistant metadata if available
            if (m.role === "assistant") {
              msg.fast_answer = (m.content as string) || "";
              if (m.complete_answer) msg.complete_answer = m.complete_answer as string;
              if (m.trust_scores) msg.trust_scores = m.trust_scores as Message["trust_scores"];
              if (m.trust_reasons) msg.trust_reasons = m.trust_reasons as Message["trust_reasons"];
              if (m.scorer_confidence) msg.scorer_confidence = m.scorer_confidence as number;
              if (m.citations) msg.citations = m.citations as Message["citations"];
              if (m.guidelines_used) msg.guidelines_used = m.guidelines_used as Message["guidelines_used"];
              if (m.agents_used) msg.agents_used = m.agents_used as string[];
              if (m.total_time_ms) msg.total_time_ms = m.total_time_ms as number;
              if (m.language) msg.language = m.language as string;
            }
            return msg;
          }
        );
        setMessages(restored);
      }
    } catch {
      // Session may have expired in Redis — show empty chat
      // Fall back to session info for at least the patient summary
      try {
        const infoResp = await fetch(`${API_URL}/api/session/${entry.sessionId}`);
        const info = await infoResp.json();
        if (info.patient_summary) {
          setPatientSummary(info.patient_summary);
        }
      } catch { /* fully expired */ }
    }
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
                onClick={() => handleOpenTrend("")}
                className="text-xs text-sky-400/80 hover:text-sky-400 transition-colors px-3 py-1.5 rounded-lg border border-sky-500/30 hover:border-sky-500/50 flex items-center gap-1"
                title="Open lab results trend monitor"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                </svg>
                Lab Trends
              </button>
            )}
            <ContextWindowBar messages={messages} agentStatuses={agentStatuses} />
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
              onOpenReportType={handleOpenReportType}
              onOpenTrendForTest={handleOpenTrend}
            />
          ))}

          {/* Status bar + persistent shimmer during loading */}
          {isLoading && (
            <>
              {agentStatuses.length > 0 ? (
                <StatusBar
                  agents={agentStatuses}
                  elapsed={elapsed}
                  totalTokens={totalTokens}
                />
              ) : (
                <div className="pl-2">
                  <ShimmerText text="Connecting to agent council..." showChevron={false} />
                </div>
              )}
              {/* Always-visible shimmer indicator while loading */}
              <div className="pl-2 pb-1">
                <ShimmerText
                  text={agentStatuses.length > 0 ? "Waiting for agents to complete..." : "Initializing pipeline..."}
                  showChevron={false}
                />
              </div>
            </>
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
      {showKnowledgeGraph && (
        patientData ? (
          <KnowledgeGraph
            patientData={patientData}
            onClose={() => { setShowKnowledgeGraph(false); setKgFocusLabel(undefined); }}
            focusLabel={kgFocusLabel}
            reportManifest={reportManifest || undefined}
            protocolId={
              ((patientData as Record<string, unknown>)?.protocol_no as string) ||
              ((patientData as Record<string, unknown>)?.patient_id as string) ||
              (((patientData as Record<string, unknown>)?.patient as Record<string, unknown>)?.patient_id as string) ||
              undefined
            }
            pacsAllStudies={pacsAllStudies || undefined}
            onOpenReport={handleOpenReportEntry}
            onOpenPacs={handleOpenPacsEntry}
            onOpenTrend={handleOpenTrend}
            episodeManifest={episodeManifest || undefined}
            onOpenEpisode={handleOpenEpisode}
          />
        ) : (
          /* No patient data — show a placeholder modal */
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-3"
            style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(4px)" }}
            onClick={() => { setShowKnowledgeGraph(false); setKgFocusLabel(undefined); }}
          >
            <div
              className="flex flex-col items-center justify-center gap-4 p-10 rounded-2xl"
              style={{
                background: "linear-gradient(180deg, #0d0d12, #08080c)",
                border: "1px solid rgba(255,255,255,0.08)",
                boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
                maxWidth: 420,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="w-16 h-16 rounded-full flex items-center justify-center" style={{ background: "rgba(129,140,248,0.12)", border: "1px solid rgba(129,140,248,0.25)" }}>
                <span style={{ fontSize: 28 }}>🧠</span>
              </div>
              <div className="text-center">
                <h3 className="text-lg font-bold text-gray-200 mb-1">No Patient Data</h3>
                <p className="text-sm text-gray-500 leading-relaxed">
                  Ask a patient-specific question first (e.g., include a protocol number) to load the knowledge graph.
                </p>
              </div>
              <button
                onClick={() => { setShowKnowledgeGraph(false); setKgFocusLabel(undefined); }}
                className="px-5 py-2 rounded-lg text-sm font-semibold transition-all"
                style={{ background: "rgba(129,140,248,0.15)", color: "#a5b4fc", border: "1px solid rgba(129,140,248,0.3)" }}
              >
                Close
              </button>
            </div>
          </div>
        )
      )}

      {/* Report Viewer Modal */}
      {selectedReport && (
        <ReportViewer
          file={selectedReport.file}
          textFile={selectedReport.textFile}
          title={selectedReport.title}
          protocolId={
            ((patientData as Record<string, unknown>)?.protocol_no as string) ||
            ((patientData as Record<string, unknown>)?.patient_id as string) ||
            (((patientData as Record<string, unknown>)?.patient as Record<string, unknown>)?.patient_id as string) ||
            ""
          }
          onClose={() => setSelectedReport(null)}
          highlightText={selectedReport.highlightText}
          reportId={selectedReport.reportId}
          accessionNumber={selectedReport.accessionNumber}
          fileEndpointType={selectedReport.fileEndpointType || "reports"}
        />
      )}

      {/* Trend Monitor Popup */}
      {showTrendMonitor && reportTrends && (
        <TrendMonitor
          protocolId={
            ((patientData as Record<string, unknown>)?.protocol_no as string) ||
            ((patientData as Record<string, unknown>)?.patient_id as string) ||
            (((patientData as Record<string, unknown>)?.patient as Record<string, unknown>)?.patient_id as string) ||
            ""
          }
          trends={reportTrends as Record<string, never[]>}
          onClose={() => { setShowTrendMonitor(false); setTrendFocusTest(undefined); }}
          focusTestName={trendFocusTest}
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
