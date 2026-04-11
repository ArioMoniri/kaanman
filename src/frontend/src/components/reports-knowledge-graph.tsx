"use client";

import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type OnNodesChange,
  applyNodeChanges,
  Handle,
  Position,
  useReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ManifestEntry {
  report_id: string;
  report_type: string;
  report_type_swc: string;
  report_name: string;
  date: string;
  facility: string;
  approver: string;
  file: string;
  text_file?: string;
  episode_id?: string;
  form_name?: string;
  e_signed?: boolean;
  accession_number?: string;
  pacs_url?: string;
  file_size?: number;
  text_length?: number;
}

/** Alias for external consumption */
export type ReportManifest = ManifestEntry;

export interface ReportsKnowledgeGraphProps {
  manifest: ManifestEntry[];
  protocolId?: string;
  pacsAllStudies?: string;
  onClose: () => void;
  onOpenReport?: (entry: ManifestEntry) => void;
  onOpenPacs?: (entry: ManifestEntry) => void;
  focusLabel?: string;
}

type ReportCategory =
  | "center" | "muayene" | "laboratuvar" | "radyoloji"
  | "kardiyoloji" | "endoskopi" | "patoloji" | "noroloji"
  | "odyoloji" | "solunum" | "sgk" | "other";

interface GraphNodeData {
  label: string;
  subtitle?: string;
  category: ReportCategory;
  count?: number;
  pacsCount?: number;
  entries?: ManifestEntry[];
  onOpenReport?: (entry: ManifestEntry) => void;
  onOpenPacs?: (entry: ManifestEntry) => void;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/*  Colors per report category                                         */
/* ------------------------------------------------------------------ */

const COLORS: Record<ReportCategory, { bg: string; border: string; text: string; glow: string; icon: string }> = {
  center:      { bg: "#312e81", border: "#818cf8", text: "#e0e7ff", glow: "rgba(129,140,248,0.4)", icon: "\u{1F4C1}" },
  muayene:     { bg: "#064e3b", border: "#34d399", text: "#d1fae5", glow: "rgba(52,211,153,0.3)", icon: "\u{1FA7A}" },
  laboratuvar: { bg: "#172554", border: "#60a5fa", text: "#dbeafe", glow: "rgba(96,165,250,0.3)", icon: "\u{1F9EA}" },
  radyoloji:   { bg: "#2e1065", border: "#c4b5fd", text: "#ede9fe", glow: "rgba(196,181,253,0.3)", icon: "\u{1FA7B}" },
  kardiyoloji: { bg: "#450a0a", border: "#fca5a5", text: "#fee2e2", glow: "rgba(252,165,165,0.35)", icon: "\u2764\uFE0F" },
  endoskopi:   { bg: "#422006", border: "#fbbf24", text: "#fef3c7", glow: "rgba(251,191,36,0.25)", icon: "\u{1F52C}" },
  patoloji:    { bg: "#1f2937", border: "#9ca3af", text: "#e5e7eb", glow: "rgba(156,163,175,0.15)", icon: "\u{1F9EC}" },
  noroloji:    { bg: "#0c4a6e", border: "#22d3ee", text: "#cffafe", glow: "rgba(34,211,238,0.25)", icon: "\u{1F9E0}" },
  odyoloji:    { bg: "#365314", border: "#84cc16", text: "#ecfccb", glow: "rgba(132,204,22,0.25)", icon: "\u{1F442}" },
  solunum:     { bg: "#3b0764", border: "#d946ef", text: "#fae8ff", glow: "rgba(217,70,239,0.25)", icon: "\u{1FAC1}" },
  sgk:         { bg: "#27150a", border: "#f97316", text: "#ffedd5", glow: "rgba(249,115,22,0.25)", icon: "\u{1F4CB}" },
  other:       { bg: "#1e293b", border: "#94a3b8", text: "#e2e8f0", glow: "rgba(148,163,184,0.2)", icon: "\u{1F4C4}" },
};

function categorize(type: string, swc: string): ReportCategory {
  const t = type.toLowerCase();
  const s = swc.toUpperCase();
  if (s === "M" || t.includes("muayene")) return "muayene";
  if (s === "L" || t.includes("laboratuvar")) return "laboratuvar";
  if (t.includes("radyoloji") || t.includes("grafi") || t.includes("tomografi") || t.includes("mr ") || t.includes("ultrason")) return "radyoloji";
  if (t.includes("kardiyoloji") || t.includes("eko") || t.includes("ekg")) return "kardiyoloji";
  if (t.includes("endoskopi") || t.includes("kolon")) return "endoskopi";
  if (t.includes("patoloji")) return "patoloji";
  if (t.includes("n\u00F6roloji") || t.includes("eeg") || t.includes("emg")) return "noroloji";
  if (t.includes("odyoloji") || t.includes("ody")) return "odyoloji";
  if (t.includes("solunum") || t.includes("sft")) return "solunum";
  if (s === "G" || t.includes("sgk") || t.includes("provizyon")) return "sgk";
  return "other";
}

/* ------------------------------------------------------------------ */
/*  Custom node                                                        */
/* ------------------------------------------------------------------ */

function ReportNode({ data }: { data: GraphNodeData }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const nodeRef = useRef<HTMLDivElement>(null);
  const palette = COLORS[data.category];
  const isCenter = data.category === "center";

  useEffect(() => {
    if (!pinned) return;
    const handler = (e: MouseEvent) => {
      if (nodeRef.current && !nodeRef.current.contains(e.target as globalThis.Node)) {
        setPinned(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pinned]);

  return (
    <div
      ref={nodeRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => { e.stopPropagation(); setPinned(!pinned); }}
      style={{
        background: palette.bg,
        border: `1.5px solid ${palette.border}`,
        borderRadius: isCenter ? 16 : 10,
        padding: isCenter ? "10px 16px" : "6px 12px",
        color: palette.text,
        fontSize: isCenter ? 12 : 10,
        fontWeight: isCenter ? 700 : 600,
        boxShadow: hovered
          ? `0 0 24px ${palette.glow}, 0 4px 20px rgba(0,0,0,0.4)`
          : `0 2px 8px rgba(0,0,0,0.3)`,
        transition: "all 0.2s",
        transform: hovered ? "scale(1.05)" : "scale(1)",
        cursor: "pointer",
        minWidth: isCenter ? 120 : 85,
        textAlign: "center" as const,
        position: "relative" as const,
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />

      <div style={{ marginBottom: 2 }}>
        <span style={{ marginRight: 4 }}>{palette.icon}</span>
        {data.label}
      </div>
      {data.count !== undefined && (
        <div style={{ fontSize: 9, opacity: 0.7 }}>
          {data.count} reports
          {data.pacsCount ? ` \u00B7 ${data.pacsCount} PACS` : ""}
        </div>
      )}
      {data.subtitle && (
        <div style={{ fontSize: 9, opacity: 0.6, marginTop: 2 }}>{data.subtitle}</div>
      )}

      {(pinned || hovered) && data.entries && data.entries.length > 0 && (
        <div
          onClick={(ev) => ev.stopPropagation()}
          onMouseDown={(ev) => ev.stopPropagation()}
          style={{
            position: "absolute" as const, top: "100%", left: "50%",
            transform: "translateX(-50%)", marginTop: 8,
            background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 8, padding: "8px 12px", fontSize: 10, color: "#d1d5db",
            minWidth: 220, maxWidth: "min(320px, 40vw)", maxHeight: "min(260px, 45vh)", overflow: "auto",
            zIndex: 100, boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            pointerEvents: "all" as const,
          }}>
          <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4, fontWeight: 600, borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: 4, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{data.entries.length} reports — click to view</span>
            {data.pacsCount && data.pacsCount > 0 && (
              <span style={{ fontSize: 8, color: "#60a5fa", fontWeight: 600, background: "rgba(96,165,250,0.1)", border: "1px solid rgba(96,165,250,0.2)", padding: "2px 6px", borderRadius: 4 }}>
                {data.pacsCount} PACS
              </span>
            )}
          </div>
          {data.entries.slice(0, 20).map((e, i) => (
            <div key={i}
              style={{
                padding: "4px 6px", borderBottom: i < 19 ? "1px solid rgba(255,255,255,0.04)" : "none",
                borderRadius: 4,
              }}
            >
              <div
                onClick={(ev) => { ev.stopPropagation(); if (data.onOpenReport) data.onOpenReport(e); }}
                style={{ cursor: "pointer", transition: "background 0.15s", borderRadius: 4, padding: "3px 6px" }}
                onMouseEnter={(ev) => { (ev.currentTarget as HTMLDivElement).style.background = "rgba(255,255,255,0.06)"; }}
                onMouseLeave={(ev) => { (ev.currentTarget as HTMLDivElement).style.background = "transparent"; }}
              >
                <div style={{ fontWeight: 600, color: palette.text, display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.report_name}</span>
                  <span style={{ fontSize: 9, color: "#818cf8", flexShrink: 0 }}>&rarr;</span>
                </div>
                <div style={{ color: "#6b7280", fontSize: 9 }}>{e.date} &middot; {e.facility}</div>
              </div>
              {e.accession_number && (
                <div style={{ display: "flex", gap: 4, marginTop: 2, paddingLeft: 4 }}>
                  <button
                    onClick={(ev) => { ev.stopPropagation(); if (data.onOpenPacs) data.onOpenPacs(e); }}
                    style={{
                      fontSize: 8, color: "#60a5fa", fontWeight: 600,
                      background: "rgba(96,165,250,0.1)", border: "1px solid rgba(96,165,250,0.2)",
                      padding: "2px 8px", borderRadius: 4, cursor: "pointer",
                      transition: "all 0.15s", display: "flex", alignItems: "center", gap: 3,
                    }}
                    onMouseEnter={(ev) => { (ev.currentTarget as HTMLButtonElement).style.background = "rgba(96,165,250,0.25)"; }}
                    onMouseLeave={(ev) => { (ev.currentTarget as HTMLButtonElement).style.background = "rgba(96,165,250,0.1)"; }}
                    title={`Open PACS (Acc: ${e.accession_number})`}
                  >
                    <span>PACS</span>
                    <span style={{ fontSize: 7, opacity: 0.7 }}>{e.accession_number}</span>
                  </button>
                </div>
              )}
            </div>
          ))}
          {data.entries.length > 20 && (
            <div style={{ color: "#6b7280", marginTop: 4, fontSize: 9 }}>+{data.entries.length - 20} more...</div>
          )}
        </div>
      )}
    </div>
  );
}

const nodeTypes = { reportNode: ReportNode };

/* ------------------------------------------------------------------ */
/*  Build graph from manifest                                          */
/* ------------------------------------------------------------------ */

function buildGraph(manifest: ManifestEntry[], onOpenReport?: (entry: ManifestEntry) => void, onOpenPacs?: (entry: ManifestEntry) => void): { nodes: Node<GraphNodeData>[]; edges: Edge[] } {
  const groups: Record<string, ManifestEntry[]> = {};
  for (const entry of manifest) {
    const cat = categorize(entry.report_type, entry.report_type_swc);
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(entry);
  }

  const nodes: Node<GraphNodeData>[] = [];
  const edges: Edge[] = [];

  nodes.push({
    id: "center",
    type: "reportNode",
    position: { x: 0, y: 0 },
    data: {
      label: `${manifest.length} Reports`,
      subtitle: "All patient reports",
      category: "center",
      count: manifest.length,
    },
  });

  const categories = Object.entries(groups);
  const radius = 220;
  const SUB_RADIUS = 100;

  categories.forEach(([cat, entries], i) => {
    const angle = (2 * Math.PI * i) / categories.length - Math.PI / 2;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;

    const dates = entries.map((e) => e.date).filter(Boolean).sort();
    const dateRange = dates.length > 0 ? `${dates[0]} - ${dates[dates.length - 1]}` : "";

    const pacsCount = entries.filter((e) => e.accession_number).length;

    nodes.push({
      id: `cat-${cat}`,
      type: "reportNode",
      position: { x, y },
      data: {
        label: cat.charAt(0).toUpperCase() + cat.slice(1),
        subtitle: dateRange,
        category: cat as ReportCategory,
        count: entries.length,
        pacsCount: pacsCount || undefined,
        entries,
        onOpenReport,
        onOpenPacs,
      },
    });

    edges.push({
      id: `edge-center-${cat}`,
      source: "center",
      target: `cat-${cat}`,
      style: { stroke: COLORS[cat as ReportCategory]?.border || "#6b7280", strokeWidth: 1.5, opacity: 0.4 },
      animated: true,
    });

    // Radiology / imaging: group by episode or date for better navigation
    if (cat === "radyoloji" && entries.length > 1) {
      const byDate: Record<string, ManifestEntry[]> = {};
      for (const e of entries) {
        const key = e.episode_id || e.date || "unknown";
        if (!byDate[key]) byDate[key] = [];
        byDate[key].push(e);
      }

      const dateGroups = Object.entries(byDate);
      if (dateGroups.length > 1) {
        dateGroups.forEach(([key, groupEntries], gi) => {
          const subAngle = angle + ((gi - (dateGroups.length - 1) / 2) * 0.35);
          const sx = x + Math.cos(subAngle) * SUB_RADIUS;
          const sy = y + Math.sin(subAngle) * SUB_RADIUS;

          const dateLabel = groupEntries[0].date || key;
          const subPacs = groupEntries.filter((e) => e.accession_number).length;

          nodes.push({
            id: `rad-group-${gi}`,
            type: "reportNode",
            position: { x: sx, y: sy },
            data: {
              label: dateLabel,
              subtitle: groupEntries.map((e) => e.report_name).join(", ").slice(0, 60),
              category: "radyoloji",
              count: groupEntries.length,
              pacsCount: subPacs || undefined,
              entries: groupEntries,
              onOpenReport,
              onOpenPacs,
            },
          });

          edges.push({
            id: `edge-rad-${cat}-${gi}`,
            source: `cat-${cat}`,
            target: `rad-group-${gi}`,
            style: { stroke: COLORS.radyoloji.border, strokeWidth: 1, opacity: 0.3, strokeDasharray: "4 2" },
          });
        });
      }
    }
  });

  return { nodes, edges };
}

/* ------------------------------------------------------------------ */
/*  PACS quick-access panel                                            */
/* ------------------------------------------------------------------ */

function PacsPanel({ entries, pacsAllStudies, onOpenPacs }: {
  entries: ManifestEntry[];
  pacsAllStudies?: string;
  onOpenPacs?: (entry: ManifestEntry) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        position: "absolute", top: 12, right: 12,
        background: "rgba(10,10,20,0.97)", backdropFilter: "blur(16px)",
        border: "1px solid rgba(96,165,250,0.35)", borderRadius: 12,
        padding: "10px 14px", zIndex: 50, pointerEvents: "all",
        maxWidth: 340, boxShadow: "0 8px 32px rgba(0,0,0,0.5), 0 0 12px rgba(96,165,250,0.15)",
      }}
    >
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
      >
        <span style={{ fontSize: 12 }}>🏥</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#60a5fa" }}>
          PACS ({entries.length})
        </span>
        <span style={{ fontSize: 9, color: "#6b7280", marginLeft: "auto" }}>
          {expanded ? "▲" : "▼"}
        </span>
      </div>

      {pacsAllStudies && (
        <a
          href={pacsAllStudies}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "block", marginTop: 6, fontSize: 9, fontWeight: 600,
            color: "#34d399", background: "rgba(52,211,153,0.1)",
            border: "1px solid rgba(52,211,153,0.2)", borderRadius: 6,
            padding: "4px 8px", textAlign: "center", textDecoration: "none",
            transition: "all 0.15s",
          }}
        >
          View All Studies in PACS ↗
        </a>
      )}

      {expanded && (
        <div style={{ marginTop: 6, maxHeight: "min(280px, 45vh)", overflowY: "auto" }}>
          {entries.map((e, i) => (
            <div
              key={i}
              style={{
                padding: "4px 6px",
                borderBottom: i < entries.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: "#d1d5db", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {e.report_name}
                  </div>
                  <div style={{ fontSize: 9, color: "#6b7280" }}>{e.date}</div>
                </div>
                <button
                  onClick={(ev) => { ev.stopPropagation(); if (onOpenPacs) onOpenPacs(e); }}
                  style={{
                    fontSize: 8, color: "#60a5fa", fontWeight: 600,
                    background: "rgba(96,165,250,0.1)", border: "1px solid rgba(96,165,250,0.2)",
                    padding: "3px 8px", borderRadius: 4, cursor: "pointer",
                    transition: "all 0.15s", flexShrink: 0,
                  }}
                  onMouseEnter={(ev) => { (ev.currentTarget as HTMLButtonElement).style.background = "rgba(96,165,250,0.25)"; }}
                  onMouseLeave={(ev) => { (ev.currentTarget as HTMLButtonElement).style.background = "rgba(96,165,250,0.1)"; }}
                  title={`Open PACS (Acc: ${e.accession_number})`}
                >
                  PACS ↗
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

function ReportsKnowledgeGraphInner({ manifest, protocolId, pacsAllStudies, onClose, onOpenReport, onOpenPacs, focusLabel }: ReportsKnowledgeGraphProps) {
  const { nodes: initialNodes, edges } = useMemo(() => buildGraph(manifest, onOpenReport, onOpenPacs), [manifest, onOpenReport, onOpenPacs]);
  const [nodes, setNodes] = useState(initialNodes);
  const reactFlowInstance = useReactFlow();

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setNodes((nds) => applyNodeChanges(changes, nds) as Node<GraphNodeData>[]),
    [],
  );

  // Node click is handled inside ReportNode (pin tooltip) — don't auto-open first report
  // so the dropdown stays visible and users can click individual reports / PACS links
  const handleNodeClick = useCallback(
    (_: React.MouseEvent, _node: Node) => {
      // Intentionally empty — tooltip pinning handled inside ReportNode
    },
    [],
  );

  // Auto-zoom to focused node (from deep links) — zoom inside canvas, not the whole popup
  useEffect(() => {
    if (!focusLabel || !reactFlowInstance) return;
    const target = focusLabel.toLowerCase();
    const focusedNode = nodes.find((n) => {
      const d = n.data as GraphNodeData;
      return d.label.toLowerCase().includes(target) ||
        (d.entries && d.entries.some(e => e.report_type.toLowerCase().includes(target) || e.report_name.toLowerCase().includes(target)));
    });
    if (focusedNode) {
      // First fit all, then zoom to the focused node within the canvas
      setTimeout(() => {
        reactFlowInstance.setCenter(
          focusedNode.position.x + 60,
          focusedNode.position.y + 20,
          { zoom: 0.9, duration: 800 },
        );
      }, 500);
    }
  }, [focusLabel, nodes, reactFlowInstance]);

  // Collect all PACS entries for the "View All PACS" button
  const allPacsEntries = useMemo(() => manifest.filter((e) => e.accession_number), [manifest]);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <ReactFlow
        nodes={nodes} edges={edges}
        onNodesChange={onNodesChange}
        onNodeClick={handleNodeClick}
        nodeTypes={nodeTypes}
        fitView fitViewOptions={{ padding: 0.4, maxZoom: 1.0 }}
        minZoom={0.15} maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="rgba(255,255,255,0.03)" gap={32} />
        <Controls showInteractive={false}
          style={{ background: "#1a1a2e", borderColor: "rgba(255,255,255,0.1)" }} />
        <MiniMap
          nodeColor={(n) => {
            const data = n.data as GraphNodeData;
            return COLORS[data.category]?.border || "#6b7280";
          }}
          style={{ background: "#0a0a0f", borderColor: "rgba(255,255,255,0.05)" }}
          maskColor="rgba(0,0,0,0.7)"
        />
      </ReactFlow>

      {/* PACS quick access panel */}
      {allPacsEntries.length > 0 && (
        <PacsPanel entries={allPacsEntries} pacsAllStudies={pacsAllStudies} onOpenPacs={onOpenPacs} />
      )}
    </div>
  );
}

export function ReportsKnowledgeGraph(props: ReportsKnowledgeGraphProps) {
  return (
    <ReactFlowProvider>
      <ReportsKnowledgeGraphInner {...props} />
    </ReactFlowProvider>
  );
}

