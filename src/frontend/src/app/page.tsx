"use client";

import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { ChatInput } from "@/components/chat-input";
import { MessageBubble, type Message, type DeepLinkEntity, type PrescriptionData } from "@/components/message-bubble";
import { PatientBanner } from "@/components/patient-banner";
import { StatusBar } from "@/components/status-bar";
import { ReferenceSidebar } from "@/components/reference-sidebar";
import { KnowledgeGraph } from "@/components/knowledge-graph";
import { DecisionTreeViewer } from "@/components/decision-tree-viewer";
import { ReferenceLegend } from "@/components/reference-legend";
import { ShimmerText } from "@/components/ui/shimmer-text";
import { CerebraLinkLogo } from "@/components/ui/cerebralink-logo";
import { LampBar } from "@/components/ui/lamp-bar";
import { AgentLogo, resetAvatarSeed } from "@/components/ui/agent-logo";
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
  /** Concatenated message content for full-text search across all chat history */
  searchText?: string;
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

/* ------------------------------------------------------------------ */
/*  Self-improving entity learning — persists across patients/sessions */
/* ------------------------------------------------------------------ */

const ENTITY_LEARN_KEY = "cerebralink_entity_learn";

interface LearnedEntity {
  text: string;
  category: string;
  label: string;
  seenCount: number;
  lastSeen: number; // timestamp
}

/** Load learned entities from localStorage */
function loadLearnedEntities(): Map<string, LearnedEntity> {
  try {
    const raw = localStorage.getItem(ENTITY_LEARN_KEY);
    if (!raw) return new Map();
    const arr: LearnedEntity[] = JSON.parse(raw);
    const map = new Map<string, LearnedEntity>();
    for (const e of arr) map.set(e.text.toLowerCase(), e);
    return map;
  } catch { return new Map(); }
}

/** Save learned entities to localStorage */
function saveLearnedEntities(map: Map<string, LearnedEntity>) {
  try {
    // Keep top 500 by seenCount, prune old ones
    const arr = Array.from(map.values())
      .sort((a, b) => b.seenCount - a.seenCount)
      .slice(0, 500);
    localStorage.setItem(ENTITY_LEARN_KEY, JSON.stringify(arr));
  } catch { /* quota exceeded */ }
}

/** Learn entities from new patient data — merges with existing knowledge */
function learnFromPatientData(entities: DeepLinkEntity[]) {
  const learned = loadLearnedEntities();
  const now = Date.now();
  let changed = false;

  for (const ent of entities) {
    const key = ent.text.toLowerCase();
    if (key.length < 3) continue;
    const existing = learned.get(key);
    if (existing) {
      existing.seenCount++;
      existing.lastSeen = now;
      // Upgrade category if we see a more specific one
      if (ent.category !== "episode" && existing.category === "episode") {
        existing.category = ent.category;
        existing.label = ent.label;
      }
    } else {
      learned.set(key, {
        text: ent.text,
        category: ent.category,
        label: ent.label,
        seenCount: 1,
        lastSeen: now,
      });
    }
    changed = true;
  }

  if (changed) saveLearnedEntities(learned);
}

/** Enhance entities with learned patterns from previous patients */
function enhanceWithLearnedEntities(entities: DeepLinkEntity[]): DeepLinkEntity[] {
  const learned = loadLearnedEntities();
  if (learned.size === 0) return entities;

  const existing = new Set(entities.map(e => e.text.toLowerCase()));
  const enhanced = [...entities];

  // Add frequently-seen entities (seenCount >= 2) that aren't already present
  // These are patterns learned from previous patients
  for (const [key, le] of Array.from(learned.entries())) {
    if (existing.has(key)) continue;
    if (le.seenCount >= 2 && le.category !== "episode") {
      // Only add non-date entities that have been seen in 2+ patients
      enhanced.push({ text: le.text, category: le.category, label: le.label });
    }
  }

  return enhanced;
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

/* History drawer component with full-text search */
function HistoryDrawer({ onClose, onRestore }: { onClose: () => void; onRestore: (entry: HistoryEntry) => void }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setEntries(loadHistory());
    setTimeout(() => searchInputRef.current?.focus(), 100);
  }, []);

  const handleDelete = (sid: string) => {
    const updated = entries.filter((e) => e.sessionId !== sid);
    saveHistory(updated);
    setEntries(updated);
  };

  // Filter entries by search query across all searchable fields
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return entries;
    const q = searchQuery.toLowerCase();
    const terms = q.split(/\s+/).filter((t) => t.length >= 2);
    return entries.filter((entry) => {
      const haystack = [
        entry.patientName || "",
        entry.protocolNumber || "",
        entry.firstQuery || "",
        entry.searchText || "",
      ].join(" ").toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [entries, searchQuery]);

  /** Highlight matching text in a string */
  const highlight = (text: string) => {
    if (!searchQuery.trim() || !text) return text;
    const terms = searchQuery.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
    if (terms.length === 0) return text;
    const pattern = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
    const parts = text.split(pattern);
    return parts.map((part, i) =>
      terms.some((t) => part.toLowerCase() === t)
        ? <mark key={i} style={{ background: "rgba(129,140,248,0.25)", color: "#e0e7ff", borderRadius: 2, padding: "0 1px" }}>{part}</mark>
        : part
    );
  };

  /** Find matching snippet from searchText to show context */
  const getMatchSnippet = (entry: HistoryEntry): string | null => {
    if (!searchQuery.trim() || !entry.searchText) return null;
    const q = searchQuery.toLowerCase();
    const idx = entry.searchText.toLowerCase().indexOf(q);
    if (idx < 0) return null;
    const start = Math.max(0, idx - 40);
    const end = Math.min(entry.searchText.length, idx + q.length + 60);
    let snippet = entry.searchText.slice(start, end).trim();
    if (start > 0) snippet = "..." + snippet;
    if (end < entry.searchText.length) snippet += "...";
    return snippet;
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

        {/* Search bar */}
        <div className="px-4 py-3 border-b border-white/5">
          <div className="relative">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className="absolute left-3 top-1/2 -translate-y-1/2">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search chats by patient, protocol, content..."
              className="w-full pl-9 pr-8 py-2 text-sm text-gray-200 rounded-lg border border-white/10 bg-white/[0.03] placeholder-gray-600 outline-none focus:border-indigo-500/50 focus:bg-white/[0.05] transition-all"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-300 text-sm px-1"
              >
                &times;
              </button>
            )}
          </div>
          {searchQuery && (
            <div className="text-[10px] text-gray-600 mt-1.5 px-1">
              {filtered.length} of {entries.length} sessions match
            </div>
          )}
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center p-6">
              <div className="text-gray-600 text-sm">No previous sessions</div>
              <div className="text-gray-700 text-xs mt-1">Past patient conversations will appear here</div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-center p-6">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#374151" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mb-3">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <div className="text-gray-600 text-sm">No matching chats found</div>
              <div className="text-gray-700 text-xs mt-1">Try different keywords</div>
            </div>
          ) : (
            filtered.map((entry) => {
              const snippet = getMatchSnippet(entry);
              return (
                <div
                  key={entry.sessionId}
                  className="px-5 py-3 border-b border-white/5 hover:bg-white/[0.03] transition-colors cursor-pointer group"
                  onClick={() => onRestore(entry)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-200 truncate">
                        {highlight(entry.patientName || "Unknown Patient")}
                      </div>
                      {entry.protocolNumber && (
                        <div className="text-xs text-indigo-400/80 mt-0.5">Protocol: {highlight(entry.protocolNumber)}</div>
                      )}
                      <div className="text-xs text-gray-500 mt-1 truncate">{highlight(entry.firstQuery)}</div>
                      {/* Search context snippet */}
                      {snippet && (
                        <div className="text-[11px] text-gray-500 mt-1.5 leading-relaxed line-clamp-2 bg-white/[0.02] rounded px-2 py-1 border-l-2 border-indigo-500/30">
                          {highlight(snippet)}
                        </div>
                      )}
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
              );
            })
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
    fileEndpointType?: "reports" | "episodes" | "izlem";
  } | null>(null);
  const [showTrendMonitor, setShowTrendMonitor] = useState(false);

  // Episode state
  const [episodeManifest, setEpisodeManifest] = useState<EpisodeEntry[] | null>(null);

  // Patient entities for Obsidian-style deep links
  const patientEntities = useMemo(() => {
    const base = extractPatientEntities(patientData);
    // Learn from this patient's data (persists across patients/sessions)
    if (base.length > 0) learnFromPatientData(base);
    // Enhance with patterns learned from previous patients
    return enhanceWithLearnedEntities(base);
  }, [patientData]);

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

  const handleOpenIzlemPdf = useCallback(
    (pdfPath: string) => {
      // pdfPath is like "izlem_brief_13025094_20260412T163000.pdf"
      const pid =
        ((patientData as Record<string, unknown>)?.protocol_no as string) ||
        ((patientData as Record<string, unknown>)?.patient_id as string) ||
        (((patientData as Record<string, unknown>)?.patient as Record<string, unknown>)?.patient_id as string) ||
        "";
      if (pid && pdfPath) {
        setSelectedReport({
          file: pdfPath,
          title: "İzlem Monitoring Brief",
          fileEndpointType: "izlem",
        });
      }
    },
    [patientData],
  );

  const handleOpenPacsEntry = useCallback(
    async (entry: ManifestEntry) => {
      const pid =
        ((patientData as Record<string, unknown>)?.protocol_no as string) ||
        ((patientData as Record<string, unknown>)?.patient_id as string) ||
        (((patientData as Record<string, unknown>)?.patient as Record<string, unknown>)?.patient_id as string) ||
        "";
      if (pid) {
        // Always try to generate a fresh per-study PACS link via backend.
        // Backend will look up accession_number from manifest/text if not provided.
        try {
          const resp = await fetch(`${API_URL}/api/reports/${pid}/pacs/link`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              report_id: entry.report_id ? String(entry.report_id) : null,
              accession_number: entry.accession_number || null,
            }),
          });
          if (resp.ok) {
            const data = await resp.json();
            if (data.url && data.accession_number) {
              // Per-study link with accession number — open directly
              window.open(data.url, "_blank", "noopener");
              return;
            }
          }
        } catch {
          // Fall through to fallback
        }
      }
      // Fallback: use pre-generated per-study URL if available
      if (entry.pacs_url && entry.accession_number) {
        window.open(entry.pacs_url, "_blank", "noopener,noreferrer");
      } else if (pacsAllStudies) {
        // Last resort: open all-studies view
        window.open(pacsAllStudies, "_blank", "noopener,noreferrer");
      }
    },
    [patientData, pacsAllStudies],
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
                  prescription_data: data.prescription_data || undefined,
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
                  izlem_brief_pdf: data.izlem_brief_pdf,
                  prescription_data: data.prescription_data || undefined,
                  timestamp: Date.now(),
                };

                setMessages((prev) => {
                  // Strategy 1: Replace by pending ID
                  if (pendingId) {
                    const idx = prev.findIndex((m) => m.id === pendingId);
                    if (idx >= 0) {
                      const next = [...prev];
                      // Preserve citations/guidelines from fast_answer if result has none
                      const merged = { ...fullMsg };
                      if ((!merged.citations || merged.citations.length === 0) && prev[idx].citations && prev[idx].citations!.length > 0) {
                        merged.citations = prev[idx].citations;
                      }
                      if ((!merged.guidelines_used || merged.guidelines_used.length === 0) && prev[idx].guidelines_used && prev[idx].guidelines_used!.length > 0) {
                        merged.guidelines_used = prev[idx].guidelines_used;
                      }
                      next[idx] = merged;
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
                      // Preserve citations/guidelines from fast_answer if result has none
                      const merged = { ...fullMsg, id: prev[i].id };
                      if ((!merged.citations || merged.citations.length === 0) && prev[i].citations && prev[i].citations!.length > 0) {
                        merged.citations = prev[i].citations;
                      }
                      if ((!merged.guidelines_used || merged.guidelines_used.length === 0) && prev[i].guidelines_used && prev[i].guidelines_used!.length > 0) {
                        merged.guidelines_used = prev[i].guidelines_used;
                      }
                      next[i] = merged;
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
    resetAvatarSeed(); // new avatar face for each new chat
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
    // Build searchable text from all messages (capped at 3000 chars to fit localStorage)
    const searchText = messages
      .map((m) => m.content || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .slice(0, 3000);
    upsertHistory({
      sessionId,
      patientName: patientSummary,
      protocolNumber: protocolNumber || null,
      timestamp: Date.now(),
      messageCount: messages.length,
      firstQuery: firstUserMsg?.content?.slice(0, 100) || "",
      searchText,
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
              if (m.priority_country) msg.priority_country = m.priority_country as string;
              if (m.izlem_brief_pdf) msg.izlem_brief_pdf = m.izlem_brief_pdf as string;
              if (m.prescription_data) msg.prescription_data = m.prescription_data as PrescriptionData;
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
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border/30">
          {/* Logo + title — compact */}
          <div className="flex items-center gap-2 shrink-0">
            <CerebraLinkLogo size={30} />
            <div className="leading-tight">
              <h1 className="text-sm font-bold text-gray-100">CerebraLink</h1>
              <p className="text-[10px] text-gray-500">Medical AI Assistant</p>
            </div>
          </div>

          {/* Spacer */}
          <div className="flex-1 min-w-0" />

          {/* Navigation buttons — order: New Chat, History, Knowledge Graph, Lab Trends, Context Size, Legend */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleNewChat}
              className="text-[11px] text-gray-400 hover:text-gray-200 transition-colors px-2 py-1 rounded-md border border-border/40 hover:border-border bg-surface/50 hover:bg-surface-light flex items-center gap-1"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New Chat
            </button>
            <button
              onClick={() => setShowHistory(true)}
              className="text-[11px] text-indigo-400/80 hover:text-indigo-400 transition-colors px-2 py-1 rounded-md border border-indigo-500/25 hover:border-indigo-500/50 flex items-center gap-1 hover:bg-indigo-500/5"
              title="Patient History"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              History
            </button>
            {patientData && (
              <button
                onClick={() => setShowKnowledgeGraph(true)}
                className="text-[11px] text-emerald-400/80 hover:text-emerald-400 transition-colors px-2 py-1 rounded-md border border-emerald-500/25 hover:border-emerald-500/50 flex items-center gap-1 hover:bg-emerald-500/5"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" /><line x1="12" y1="1" x2="12" y2="5" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="7.05" y2="7.05" /><line x1="16.95" y1="16.95" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="5" y2="12" /><line x1="19" y1="12" x2="23" y2="12" />
                </svg>
                Knowledge Graph
              </button>
            )}
            {patientData && (
              <button
                onClick={() => handleOpenTrend("")}
                className="text-[11px] text-sky-400/80 hover:text-sky-400 transition-colors px-2 py-1 rounded-md border border-sky-500/25 hover:border-sky-500/50 flex items-center gap-1 hover:bg-sky-500/5"
                title="Open lab results trend monitor"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                </svg>
                Lab Trends
              </button>
            )}
            <ContextWindowBar messages={messages} agentStatuses={agentStatuses} />
            <ReferenceLegend />
          </div>
        </header>

        {/* Purple lamp bar — visible when idle, hidden during agent processing */}
        <LampBar visible={!isLoading} />

        {/* Patient Banner */}
        {patientSummary && <PatientBanner summary={patientSummary} />}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              {/* Logos side by side */}
              <div className="flex items-center gap-4 mb-6">
                <CerebraLinkLogo size={70} />
                <AgentLogo size={64} />
              </div>
              {/* Localized greeting */}
              <h2 className="text-2xl font-extrabold text-gray-100 mb-1 tracking-tight">
                {typeof navigator !== "undefined" && navigator.language?.startsWith("tr")
                  ? "Merhaba, ben Link"
                  : "Hi, I\u2019m Link"}
              </h2>
              <p className="text-gray-400 max-w-md text-sm leading-relaxed mb-1">
                {typeof navigator !== "undefined" && navigator.language?.startsWith("tr")
                  ? "CerebraLink yapay zeka asistanınız. Klinik sorularınızda size yardımcı olmak için buradayım."
                  : "Your CerebraLink AI assistant. I\u2019m here to help with your clinical questions."}
              </p>
              <p className="text-gray-600 text-xs">
                {typeof navigator !== "undefined" && navigator.language?.startsWith("tr")
                  ? "Herhangi bir klinik soru sorun \u2014 kanıta dayalı yanıtlar alın."
                  : "Ask any clinical question \u2014 get evidence-backed answers."}
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
              onOpenIzlemPdf={handleOpenIzlemPdf}
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
