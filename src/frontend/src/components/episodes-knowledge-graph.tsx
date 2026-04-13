"use client";

import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeTypes,
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

export interface EpisodeEntry {
  episode_id: string;
  date: string;
  service_text: string;
  service_id?: string;
  facility_text: string;
  facility_id?: string;
  doctor_name: string;
  doctor_code?: string;
  is_hospitalization: boolean;
  old_complaint_id?: string;
  diagnoses: { icd_code: string; name: string; type?: string }[];
  complaints: { title: string; text: string; date: string }[];
  output_file: string;
  cross_match?: {
    date: string;
    facility_id: string;
    service_id: string;
    episode_id: string;
  };
  yatis_bilgisi?: {
    yatis_tarihi: string;
    taburcu_tarihi: string;
    yatis_sebebi: string;
    yatis_tanisi: string;
  };
}

interface EpisodesKnowledgeGraphProps {
  episodes: EpisodeEntry[];
  protocolId?: string;
  onClose: () => void;
  onOpenEpisode?: (entry: EpisodeEntry) => void;
  focusLabel?: string;
}

type EpCategory =
  | "patient"
  | "hospitalization"
  | "poliklinik"
  | "department"
  | "doctor"
  | "facility"
  | "diagnosis"
  | "timeline";

interface EpNodeData {
  label: string;
  subtitle?: string;
  category: EpCategory;
  meta?: Record<string, string>;
  episodeCount?: number;
  detailList?: string[];
  clickable?: boolean;
  episodeEntry?: EpisodeEntry;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/*  Color palette                                                      */
/* ------------------------------------------------------------------ */

const COLORS: Record<EpCategory, { bg: string; bgEnd: string; border: string; text: string; glow: string; icon: string }> = {
  patient:         { bg: "#312e81", bgEnd: "#1e1b4b", border: "#818cf8", text: "#e0e7ff", glow: "rgba(129,140,248,0.4)", icon: "\u2764\uFE0F" },
  hospitalization: { bg: "#7f1d1d", bgEnd: "#450a0a", border: "#f87171", text: "#fecaca", glow: "rgba(248,113,113,0.35)", icon: "\u{1F3E5}" },
  poliklinik:      { bg: "#064e3b", bgEnd: "#022c22", border: "#34d399", text: "#d1fae5", glow: "rgba(52,211,153,0.3)", icon: "\u{1FA7A}" },
  department:      { bg: "#1e3a5f", bgEnd: "#0c1a3d", border: "#60a5fa", text: "#dbeafe", glow: "rgba(96,165,250,0.25)", icon: "\u{1F3EC}" },
  doctor:          { bg: "#422006", bgEnd: "#27150a", border: "#fbbf24", text: "#fef3c7", glow: "rgba(251,191,36,0.25)", icon: "\u{1F468}\u200D\u2695\uFE0F" },
  facility:        { bg: "#0c4a6e", bgEnd: "#082f49", border: "#22d3ee", text: "#cffafe", glow: "rgba(34,211,238,0.25)", icon: "\u{1F3E2}" },
  diagnosis:       { bg: "#2e1065", bgEnd: "#1e0a44", border: "#c4b5fd", text: "#ede9fe", glow: "rgba(196,181,253,0.3)", icon: "\u{1F9EC}" },
  timeline:        { bg: "#1f2937", bgEnd: "#111827", border: "#9ca3af", text: "#e5e7eb", glow: "rgba(156,163,175,0.15)", icon: "\u{1F4C5}" },
};

/* ------------------------------------------------------------------ */
/*  Custom node                                                        */
/* ------------------------------------------------------------------ */

function EpGraphNode({ data }: { data: EpNodeData }) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const nodeRef = useRef<HTMLDivElement>(null);
  const cat = data.category;
  const palette = COLORS[cat];
  const isCenter = cat === "patient";

  const hasDetails = data.detailList && data.detailList.length > 0;
  const hasMeta = data.meta && Object.keys(data.meta).length > 0;
  const showTooltip = (pinned || hovered) && (hasDetails || hasMeta || data.subtitle);

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
      style={{ position: "relative", textAlign: "center" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => { e.stopPropagation(); setPinned(!pinned); }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />

      <div
        style={{
          background: `linear-gradient(${isCenter ? "135deg" : "180deg"}, ${palette.bg}, ${palette.bgEnd})`,
          border: `1.5px solid ${palette.border}${hovered ? "" : "80"}`,
          borderRadius: isCenter ? 20 : 14,
          padding: isCenter ? "16px 20px" : "10px 14px",
          minWidth: isCenter ? 160 : 120,
          maxWidth: isCenter ? 200 : 200,
          boxShadow: hovered
            ? `0 0 24px ${palette.glow}, 0 4px 20px rgba(0,0,0,0.5)`
            : `0 0 12px ${palette.glow}, 0 2px 8px rgba(0,0,0,0.3)`,
          transition: "all 0.25s ease",
          transform: hovered ? "scale(1.06)" : "scale(1)",
          cursor: data.clickable ? "pointer" : "grab",
          position: "relative",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: isCenter ? "center" : "flex-start" }}>
          <span style={{ fontSize: isCenter ? 22 : 14, lineHeight: 1 }}>{palette.icon}</span>
          <div style={{ flex: 1, minWidth: 0, textAlign: isCenter ? "center" : "left" }}>
            <div style={{
              fontSize: isCenter ? 15 : 11,
              fontWeight: isCenter ? 800 : 600,
              color: palette.text,
              lineHeight: 1.3,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: isCenter ? "normal" : "nowrap",
            }}>
              {data.label}
            </div>
            {data.subtitle && (
              <div style={{
                fontSize: 9,
                color: `${palette.border}cc`,
                marginTop: 2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontWeight: 500,
              }}>
                {data.subtitle}
              </div>
            )}
          </div>
        </div>

        {data.episodeCount && data.episodeCount > 0 && (
          <div style={{
            position: "absolute",
            top: -8,
            right: -6,
            background: `linear-gradient(135deg, ${palette.border}, ${palette.bg})`,
            color: "#fff",
            fontSize: 9,
            fontWeight: 700,
            borderRadius: 10,
            padding: "2px 7px",
            minWidth: 18,
            textAlign: "center",
            boxShadow: `0 2px 8px ${palette.glow}`,
            border: `1px solid ${palette.border}`,
          }}>
            {data.episodeCount}
          </div>
        )}
      </div>

      {showTooltip && (
        <div style={{
          position: "absolute",
          top: "100%",
          left: "50%",
          transform: "translateX(-50%)",
          marginTop: 10,
          background: "linear-gradient(180deg, rgba(15,15,20,0.97), rgba(10,10,14,0.97))",
          backdropFilter: "blur(16px)",
          border: `1px solid ${palette.border}40`,
          borderRadius: 12,
          padding: "12px 16px",
          minWidth: 200,
          maxWidth: 360,
          maxHeight: 280,
          overflowY: "auto",
          zIndex: 100,
          textAlign: "left",
          boxShadow: `0 12px 40px rgba(0,0,0,0.7), 0 0 20px ${palette.glow}`,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, paddingBottom: 6, borderBottom: `1px solid ${palette.border}20` }}>
            <span style={{ fontSize: 14 }}>{palette.icon}</span>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: palette.text }}>{data.label}</div>
              {data.subtitle && <div style={{ fontSize: 10, color: `${palette.border}cc`, marginTop: 1 }}>{data.subtitle}</div>}
            </div>
          </div>
          {hasMeta && (
            <div style={{ marginBottom: 8 }}>
              {Object.entries(data.meta!).map(([k, v]) => (
                <div key={k} style={{ fontSize: 10, color: "#9ca3af", lineHeight: 1.6 }}>
                  <span style={{ color: "#d1d5db", fontWeight: 600 }}>{k}:</span> {v}
                </div>
              ))}
            </div>
          )}
          {hasDetails && (
            <div>
              <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4, fontWeight: 600 }}>
                Details ({data.detailList!.length})
              </div>
              {data.detailList!.map((item, i) => (
                <div key={i} style={{
                  fontSize: 10, color: "#d1d5db", lineHeight: 1.6,
                  borderBottom: i < data.detailList!.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none",
                  paddingBottom: 3, marginBottom: 3, paddingLeft: 6,
                  borderLeft: `2px solid ${palette.border}40`,
                }}>
                  {item}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const nodeTypes: NodeTypes = {
  epNode: EpGraphNode,
};

/* ------------------------------------------------------------------ */
/*  Layout helpers                                                     */
/* ------------------------------------------------------------------ */

function polar(cx: number, cy: number, radius: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
}

/* ------------------------------------------------------------------ */
/*  Graph builder                                                      */
/* ------------------------------------------------------------------ */

function buildEpisodesGraph(
  episodes: EpisodeEntry[],
  onOpenEpisode?: (entry: EpisodeEntry) => void,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let nid = 0;
  const nextId = () => `ep${nid++}`;

  const CX = 0;
  const CY = 0;

  // Separate yatış and poliklinik
  const yatisEps = episodes.filter((e) => e.is_hospitalization);
  const poliEps = episodes.filter((e) => !e.is_hospitalization);

  // Patient center
  const patientId = nextId();
  nodes.push({
    id: patientId,
    type: "epNode",
    position: { x: CX - 80, y: CY - 40 },
    draggable: true,
    data: {
      label: "Episode Timeline",
      subtitle: `${yatisEps.length} Yatış + ${poliEps.length} Poliklinik`,
      category: "patient" as EpCategory,
      meta: {
        "Total Episodes": String(episodes.length),
        "Hospitalizations": String(yatisEps.length),
        "Outpatient Visits": String(poliEps.length),
      },
    } satisfies EpNodeData,
  });

  // Track departments and doctors for grouping
  const deptMap = new Map<string, { id: string; yatis: string[]; poli: string[] }>();
  const docMap = new Map<string, { id: string; episodes: string[] }>();
  const facilityMap = new Map<string, { id: string; episodes: string[] }>();
  const diagMap = new Map<string, { name: string; icd: string; episodeIds: string[] }>();

  // Yatış nodes — left/top hemisphere (red zone)
  const YATIS_RADIUS = 400;
  const YATIS_START = -150;
  const yatisSpread = Math.min(120, yatisEps.length * 30);

  yatisEps.forEach((ep, i) => {
    const epId = nextId();
    const angle = yatisEps.length === 1
      ? YATIS_START
      : YATIS_START - yatisSpread / 2 + (yatisSpread / (yatisEps.length - 1)) * i;
    const pos = polar(CX, CY, YATIS_RADIUS, angle);

    const yb = ep.yatis_bilgisi || { yatis_tarihi: "", taburcu_tarihi: "", yatis_sebebi: "", yatis_tanisi: "" };
    const details: string[] = [];
    if (yb.yatis_tarihi) details.push(`Admission: ${yb.yatis_tarihi}`);
    if (yb.taburcu_tarihi) details.push(`Discharge: ${yb.taburcu_tarihi}`);
    if (yb.yatis_sebebi) details.push(`Reason: ${yb.yatis_sebebi}`);
    if (yb.yatis_tanisi) details.push(`Diagnosis: ${yb.yatis_tanisi}`);
    ep.diagnoses.forEach((d) => details.push(`Dx: ${d.name} (${d.icd_code})`));
    ep.complaints.forEach((c) => details.push(`CC: ${c.title}`));

    nodes.push({
      id: epId,
      type: "epNode",
      position: { x: pos.x - 60, y: pos.y - 22 },
      draggable: true,
      data: {
        label: `${ep.date}`,
        subtitle: `${ep.service_text} @ ${ep.facility_text}`,
        category: "hospitalization" as EpCategory,
        meta: {
          "Episode ID": ep.episode_id,
          "Doctor": ep.doctor_name,
          "Facility": ep.facility_text,
          "Admission": yb.yatis_tarihi || ep.date,
          "Discharge": yb.taburcu_tarihi || "N/A",
        },
        detailList: details,
        clickable: true,
        episodeEntry: ep,
      } satisfies EpNodeData,
    });

    edges.push({
      id: `e-p-y-${epId}`,
      source: patientId,
      target: epId,
      style: { stroke: COLORS.hospitalization.border, strokeWidth: 2 },
      animated: true,
      label: "hospitalized",
    });

    // Track dept, doctor, facility, diagnoses
    const dept = ep.service_text;
    if (dept) {
      if (!deptMap.has(dept)) deptMap.set(dept, { id: nextId(), yatis: [], poli: [] });
      deptMap.get(dept)!.yatis.push(epId);
    }
    if (ep.doctor_name) {
      if (!docMap.has(ep.doctor_name)) docMap.set(ep.doctor_name, { id: nextId(), episodes: [] });
      docMap.get(ep.doctor_name)!.episodes.push(epId);
    }
    if (ep.facility_text) {
      if (!facilityMap.has(ep.facility_text)) facilityMap.set(ep.facility_text, { id: nextId(), episodes: [] });
      facilityMap.get(ep.facility_text)!.episodes.push(epId);
    }
    ep.diagnoses.forEach((d) => {
      const key = d.icd_code || d.name;
      if (!key) return;
      if (!diagMap.has(key)) diagMap.set(key, { name: d.name, icd: d.icd_code, episodeIds: [] });
      diagMap.get(key)!.episodeIds.push(epId);
    });
  });

  // Poliklinik nodes — right/bottom hemisphere (green zone)
  const POLI_RADIUS = 400;
  const POLI_START = 30;
  const poliSpread = Math.min(120, Math.max(poliEps.length * 5, 60));

  // Only show recent 20 poli episodes as nodes (rest as department aggregates)
  const displayPoli = poliEps.slice(0, 20);
  displayPoli.forEach((ep, i) => {
    const epId = nextId();
    const angle = displayPoli.length === 1
      ? POLI_START
      : POLI_START - poliSpread / 2 + (poliSpread / (displayPoli.length - 1)) * i;
    const pos = polar(CX, CY, POLI_RADIUS, angle);

    const details: string[] = [];
    ep.diagnoses.forEach((d) => details.push(`Dx: ${d.name} (${d.icd_code})`));
    ep.complaints.forEach((c) => details.push(`CC: ${c.title}`));

    nodes.push({
      id: epId,
      type: "epNode",
      position: { x: pos.x - 60, y: pos.y - 22 },
      draggable: true,
      data: {
        label: `${ep.date}`,
        subtitle: `${ep.service_text}`,
        category: "poliklinik" as EpCategory,
        meta: {
          "Episode ID": ep.episode_id,
          "Doctor": ep.doctor_name,
          "Facility": ep.facility_text,
        },
        detailList: details,
        clickable: true,
        episodeEntry: ep,
      } satisfies EpNodeData,
    });

    edges.push({
      id: `e-p-pk-${epId}`,
      source: patientId,
      target: epId,
      style: { stroke: COLORS.poliklinik.border, strokeWidth: 1 },
    });

    // Track dept, doctor, facility, diagnoses
    const dept = ep.service_text;
    if (dept) {
      if (!deptMap.has(dept)) deptMap.set(dept, { id: nextId(), yatis: [], poli: [] });
      deptMap.get(dept)!.poli.push(epId);
    }
    if (ep.doctor_name) {
      if (!docMap.has(ep.doctor_name)) docMap.set(ep.doctor_name, { id: nextId(), episodes: [] });
      docMap.get(ep.doctor_name)!.episodes.push(epId);
    }
    if (ep.facility_text) {
      if (!facilityMap.has(ep.facility_text)) facilityMap.set(ep.facility_text, { id: nextId(), episodes: [] });
      facilityMap.get(ep.facility_text)!.episodes.push(epId);
    }
    ep.diagnoses.forEach((d) => {
      const key = d.icd_code || d.name;
      if (!key) return;
      if (!diagMap.has(key)) diagMap.set(key, { name: d.name, icd: d.icd_code, episodeIds: [] });
      diagMap.get(key)!.episodeIds.push(epId);
    });
  });

  // Department aggregation nodes
  const depts = Array.from(deptMap.entries());
  const DEPT_RADIUS = 250;
  depts.forEach(([name, info], i) => {
    const angle = (360 / depts.length) * i - 90;
    const pos = polar(CX, CY, DEPT_RADIUS, angle);
    const total = info.yatis.length + info.poli.length;

    nodes.push({
      id: info.id,
      type: "epNode",
      position: { x: pos.x - 55, y: pos.y - 22 },
      draggable: true,
      data: {
        label: name,
        subtitle: `${info.yatis.length} yatış, ${info.poli.length} poli`,
        category: "department" as EpCategory,
        episodeCount: total,
      } satisfies EpNodeData,
    });

    edges.push({
      id: `e-p-dept-${info.id}`,
      source: patientId,
      target: info.id,
      style: { stroke: COLORS.department.border, strokeWidth: 1.5 },
    });

    // Connect episodes to their department
    [...info.yatis, ...info.poli].forEach((epId) => {
      edges.push({
        id: `e-dept-ep-${info.id}-${epId}`,
        source: info.id,
        target: epId,
        style: { stroke: COLORS.department.border + "60", strokeWidth: 1, strokeDasharray: "4 2" },
      });
    });
  });

  // Diagnosis nodes (only show if <= 20)
  const diagEntries = Array.from(diagMap.entries());
  if (diagEntries.length > 0 && diagEntries.length <= 20) {
    const DIAG_RADIUS = 600;
    diagEntries.forEach(([, { name, icd, episodeIds }], i) => {
      const diagId = nextId();
      const angle = (360 / diagEntries.length) * i;
      const pos = polar(CX, CY, DIAG_RADIUS, angle);

      nodes.push({
        id: diagId,
        type: "epNode",
        position: { x: pos.x - 55, y: pos.y - 22 },
        draggable: true,
        data: {
          label: (name || icd).slice(0, 30),
          subtitle: icd || undefined,
          category: "diagnosis" as EpCategory,
          episodeCount: episodeIds.length > 1 ? episodeIds.length : undefined,
        } satisfies EpNodeData,
      });

      episodeIds.forEach((eid) => {
        edges.push({
          id: `e-dx-${diagId}-${eid}`,
          source: eid,
          target: diagId,
          style: { stroke: COLORS.diagnosis.border, strokeWidth: 1, strokeDasharray: "4 2" },
        });
      });
    });
  }

  // Facility nodes
  const facilities = Array.from(facilityMap.entries());
  if (facilities.length > 0 && facilities.length <= 10) {
    const FAC_RADIUS = 300;
    const FAC_START = 180;
    facilities.forEach(([name, info], i) => {
      const angle = FAC_START + (120 / Math.max(facilities.length - 1, 1)) * i;
      const pos = polar(CX, CY, FAC_RADIUS, angle);

      nodes.push({
        id: info.id,
        type: "epNode",
        position: { x: pos.x - 55, y: pos.y - 22 },
        draggable: true,
        data: {
          label: name.slice(0, 24),
          category: "facility" as EpCategory,
          episodeCount: info.episodes.length,
        } satisfies EpNodeData,
      });

      edges.push({
        id: `e-p-fac-${info.id}`,
        source: patientId,
        target: info.id,
        style: { stroke: COLORS.facility.border, strokeWidth: 1 },
      });
    });
  }

  return { nodes, edges };
}

/* ------------------------------------------------------------------ */
/*  Legend                                                              */
/* ------------------------------------------------------------------ */

function EpLegend({ hiddenCategories, onToggleCategory }: {
  hiddenCategories: Set<EpCategory>;
  onToggleCategory: (cat: EpCategory) => void;
}) {
  const items: { category: EpCategory; label: string }[] = [
    { category: "patient", label: "Timeline" },
    { category: "hospitalization", label: "Yatış" },
    { category: "poliklinik", label: "Poliklinik" },
    { category: "department", label: "Department" },
    { category: "diagnosis", label: "Diagnosis" },
    { category: "facility", label: "Facility" },
  ];

  return (
    <div style={{
      position: "absolute", bottom: 12, left: 12, display: "flex",
      flexDirection: "column", gap: 4, background: "linear-gradient(180deg, rgba(13,13,18,0.95), rgba(8,8,12,0.95))",
      backdropFilter: "blur(16px)", borderRadius: 14, padding: "12px 14px",
      border: "1px solid rgba(255,255,255,0.08)", boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
      zIndex: 30, pointerEvents: "all",
    }}>
      <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700, marginBottom: 2, paddingLeft: 2 }}>
        Filter Categories
      </div>
      {items.map(({ category, label }) => {
        const isHidden = hiddenCategories.has(category);
        return (
          <button key={category}
            onClick={() => category !== "patient" && onToggleCategory(category)}
            style={{
              display: "flex", alignItems: "center", gap: 8, padding: "5px 8px",
              borderRadius: 8, border: "none",
              cursor: category === "patient" ? "default" : "pointer",
              background: isHidden ? "rgba(255,255,255,0.02)" : `${COLORS[category].border}12`,
              opacity: isHidden ? 0.4 : 1, transition: "all 0.2s",
            }}>
            <div style={{
              width: 10, height: 10, borderRadius: 3,
              background: isHidden ? "#333" : COLORS[category].border,
              border: `1.5px solid ${isHidden ? "#444" : COLORS[category].border}`,
            }} />
            <span style={{ fontSize: 11 }}>{COLORS[category].icon}</span>
            <span style={{ fontSize: 11, color: isHidden ? "#4b5563" : COLORS[category].text, fontWeight: 500 }}>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Stats bar                                                          */
/* ------------------------------------------------------------------ */

function EpStatsBar({ episodes, onFilterChange }: {
  episodes: EpisodeEntry[];
  onFilterChange?: (filter: { type?: string; department?: string; doctor?: string; search?: string }) => void;
}) {
  const [openStat, setOpenStat] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!openStat) return;
    const handler = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as globalThis.Node)) {
        setOpenStat(null);
        setSearchQuery("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openStat]);

  // Auto-focus search when dropdown opens
  useEffect(() => {
    if (openStat) {
      setSearchQuery("");
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [openStat]);

  const yatisCount = episodes.filter((e) => e.is_hospitalization).length;
  const poliCount = episodes.length - yatisCount;

  // Build lists for each stat
  const deptMap = new Map<string, number>();
  const docMap = new Map<string, number>();
  const diagMap = new Map<string, number>();
  episodes.forEach((ep) => {
    if (ep.service_text) deptMap.set(ep.service_text, (deptMap.get(ep.service_text) || 0) + 1);
    if (ep.doctor_name) docMap.set(ep.doctor_name, (docMap.get(ep.doctor_name) || 0) + 1);
    (ep.diagnoses || []).forEach((d) => {
      const lbl = d.icd_code ? `${d.name} (${d.icd_code})` : d.name;
      if (lbl) diagMap.set(lbl, (diagMap.get(lbl) || 0) + 1);
    });
  });

  const sortedDepts = Array.from(deptMap.entries()).sort((a, b) => b[1] - a[1]);
  const sortedDocs = Array.from(docMap.entries()).sort((a, b) => b[1] - a[1]);
  const sortedDiags = Array.from(diagMap.entries()).sort((a, b) => b[1] - a[1]);

  // Episode list (date + dept)
  const episodeList: [string, number][] = episodes.map((ep) => {
    const label = [ep.date, ep.service_text].filter(Boolean).join(" — ");
    return [label || "Unknown", ep.is_hospitalization ? 1 : 0] as [string, number];
  });

  const stats: { label: string; value: number; color: string; list: [string, number][]; filterKey?: string }[] = [
    { label: "Yatış", value: yatisCount, color: COLORS.hospitalization.border, list: episodeList.filter(([,h]) => h === 1), filterKey: "yatis" },
    { label: "Poliklinik", value: poliCount, color: COLORS.poliklinik.border, list: episodeList.filter(([,h]) => h === 0), filterKey: "poli" },
    { label: "Departments", value: deptMap.size, color: COLORS.department.border, list: sortedDepts, filterKey: "department" },
    { label: "Diagnoses", value: diagMap.size, color: COLORS.diagnosis.border, list: sortedDiags, filterKey: "diagnosis" },
    { label: "Doctors", value: docMap.size, color: COLORS.doctor.border, list: sortedDocs, filterKey: "doctor" },
  ];

  return (
    <div
      ref={barRef}
      style={{
        position: "absolute", top: 12, right: 12, display: "flex", gap: 2,
        background: "rgba(10,10,14,0.9)", backdropFilter: "blur(12px)",
        borderRadius: 12, padding: "6px 4px", border: "1px solid rgba(255,255,255,0.08)",
        zIndex: 30, pointerEvents: "all",
      }}
    >
      {stats.map(({ label, value, color, list, filterKey }) => (
        <div
          key={label}
          style={{
            textAlign: "center",
            position: "relative",
            cursor: list.length > 0 ? "pointer" : "default",
            padding: "4px 12px",
            borderRadius: 8,
            background: openStat === label ? "rgba(255,255,255,0.06)" : activeFilter === filterKey ? `${color}12` : "transparent",
            transition: "background 0.2s",
            borderBottom: activeFilter === filterKey ? `2px solid ${color}` : "2px solid transparent",
          }}
          onClick={() => list.length > 0 && setOpenStat(openStat === label ? null : label)}
        >
          <div style={{ fontSize: 16, fontWeight: 800, color, lineHeight: 1.2 }}>{value}</div>
          <div style={{ fontSize: 8, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>{label}</div>

          {/* Dropdown with search */}
          {openStat === label && list.length > 0 && (() => {
            const q = searchQuery.toLowerCase();
            const filtered = q ? list.filter(([name]) => name.toLowerCase().includes(q)) : list;
            return (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  right: 0,
                  marginTop: 8,
                  background: "linear-gradient(180deg, rgba(15,15,20,0.97), rgba(10,10,14,0.97))",
                  backdropFilter: "blur(16px)",
                  border: `1px solid ${color}30`,
                  borderRadius: 12,
                  padding: "8px 0",
                  minWidth: 260,
                  maxWidth: "min(400px, 45vw)",
                  maxHeight: "min(400px, 60vh)",
                  zIndex: 100,
                  textAlign: "left",
                  boxShadow: `0 12px 40px rgba(0,0,0,0.7), 0 0 12px ${color}15`,
                  display: "flex",
                  flexDirection: "column" as const,
                }}
              >
                <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.8, padding: "4px 14px 6px", fontWeight: 600 }}>
                  {label} ({filtered.length}{q ? ` / ${list.length}` : ""})
                </div>
                {/* Search bar */}
                <div style={{ padding: "0 10px 8px", borderBottom: `1px solid ${color}15` }}>
                  <div style={{ position: "relative" }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                      style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)" }}>
                      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    <input
                      ref={openStat === label ? searchInputRef : undefined}
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      placeholder={`Search ${label.toLowerCase()}...`}
                      style={{
                        width: "100%",
                        padding: "5px 10px 5px 26px",
                        fontSize: 11,
                        color: "#e5e7eb",
                        background: "rgba(255,255,255,0.06)",
                        border: `1px solid ${color}25`,
                        borderRadius: 6,
                        outline: "none",
                      }}
                      onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = `${color}50`; }}
                      onBlur={(e) => { (e.target as HTMLInputElement).style.borderColor = `${color}25`; }}
                    />
                  </div>
                </div>
                {/* Filter all / clear button */}
                {filterKey && onFilterChange && (
                  <div style={{ display: "flex", gap: 4, padding: "4px 10px", borderBottom: `1px solid ${color}10` }}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveFilter(activeFilter === filterKey ? null : filterKey);
                        if (activeFilter !== filterKey) {
                          onFilterChange({ type: filterKey });
                        } else {
                          onFilterChange({});
                        }
                      }}
                      style={{
                        flex: 1, padding: "3px 8px", fontSize: 9, fontWeight: 600,
                        borderRadius: 4, border: `1px solid ${color}30`,
                        background: activeFilter === filterKey ? `${color}25` : "transparent",
                        color: activeFilter === filterKey ? color : "#6b7280",
                        cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5,
                      }}
                    >
                      {activeFilter === filterKey ? "Clear Filter" : `Filter ${label}`}
                    </button>
                  </div>
                )}
                {/* Items */}
                <div style={{ overflowY: "auto", flex: 1 }}>
                  {filtered.length === 0 && (
                    <div style={{ padding: "12px 14px", fontSize: 11, color: "#6b7280", textAlign: "center" }}>
                      No matches found
                    </div>
                  )}
                  {filtered.map(([name, count], i) => (
                    <button
                      key={i}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (onFilterChange && filterKey) {
                          const cleanName = name.replace(/\s*\(.*$/, "").trim();
                          setActiveFilter(filterKey);
                          onFilterChange({ [filterKey === "yatis" || filterKey === "poli" ? "type" : filterKey]: cleanName });
                          setOpenStat(null);
                          setSearchQuery("");
                        }
                      }}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        fontSize: 11,
                        color: "#d1d5db",
                        padding: "6px 14px",
                        borderBottom: i < filtered.length - 1 ? "1px solid rgba(255,255,255,0.03)" : "none",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 10,
                        transition: "background 0.15s",
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = `${color}18`; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                      title={`Focus: ${name}`}
                    >
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                        <span style={{
                          color,
                          fontWeight: 600,
                          fontSize: 10,
                          background: `${color}15`,
                          padding: "1px 6px",
                          borderRadius: 6,
                        }}>
                          {label === "Yatış" || label === "Poliklinik" ? (count === 1 ? "Y" : "P") : `${count}x`}
                        </span>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}>
                          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                        </svg>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

function EpisodesKnowledgeGraphInner({
  episodes,
  protocolId,
  onClose,
  onOpenEpisode,
  focusLabel,
}: EpisodesKnowledgeGraphProps) {
  const graph = useMemo(() => buildEpisodesGraph(episodes, onOpenEpisode), [episodes, onOpenEpisode]);
  const [hiddenCategories, setHiddenCategories] = useState<Set<EpCategory>>(new Set());
  const [statsFilter, setStatsFilter] = useState<Record<string, string>>({});
  const reactFlowInstance = useReactFlow();

  const toggleCategory = useCallback((cat: EpCategory) => {
    setHiddenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  // Handler for stats bar filter changes
  const handleFilterChange = useCallback((filter: Record<string, string>) => {
    setStatsFilter(filter);

    // If a specific item was selected, zoom to matching nodes
    const filterValue = filter.department || filter.doctor || filter.diagnosis || filter.search;
    if (filterValue && reactFlowInstance) {
      const target = filterValue.toLowerCase();
      setTimeout(() => {
        const currentNodes = reactFlowInstance.getNodes();
        const matchingNodes = currentNodes.filter((n) => {
          const d = n.data as EpNodeData;
          const text = [
            d.label, d.subtitle || "",
            ...(d.meta ? Object.values(d.meta) : []),
            ...(d.detailList || []),
          ].join(" ").toLowerCase();
          return text.includes(target);
        });
        if (matchingNodes.length > 0) {
          let cx = 0, cy = 0;
          matchingNodes.forEach((n) => { cx += n.position.x; cy += n.position.y; });
          cx /= matchingNodes.length;
          cy /= matchingNodes.length;
          let maxDist = 0;
          matchingNodes.forEach((n) => {
            const dist = Math.sqrt((n.position.x - cx) ** 2 + (n.position.y - cy) ** 2);
            if (dist > maxDist) maxDist = dist;
          });
          const zoom = maxDist > 500 ? 0.6 : maxDist > 300 ? 0.9 : maxDist > 150 ? 1.5 : 2.2;
          reactFlowInstance.setCenter(cx + 60, cy + 20, { zoom, duration: 800 });
        }
      }, 200);
    }
  }, [reactFlowInstance]);

  const filteredNodes = useMemo(() => {
    let result = graph.nodes;
    if (hiddenCategories.size > 0) {
      result = result.filter((n) => !hiddenCategories.has((n.data as EpNodeData).category));
    }

    // Apply stats filter if active
    if (statsFilter.department || statsFilter.doctor || statsFilter.type) {
      const filterTarget = (statsFilter.department || statsFilter.doctor || "").toLowerCase();
      const filterType = statsFilter.type;

      if (filterTarget || filterType) {
        // Find matching node IDs
        const matchedIds = new Set<string>();
        const patientId = result.find((n) => (n.data as EpNodeData).category === "patient")?.id;
        if (patientId) matchedIds.add(patientId);

        result.forEach((n) => {
          const d = n.data as EpNodeData;
          const text = [d.label, d.subtitle || "", ...(d.meta ? Object.values(d.meta) : []), ...(d.detailList || [])].join(" ").toLowerCase();

          if (filterTarget && text.includes(filterTarget)) {
            matchedIds.add(n.id);
          }
          if (filterType === "yatis" && d.category === "hospitalization") matchedIds.add(n.id);
          if (filterType === "poli" && d.category === "poliklinik") matchedIds.add(n.id);
        });

        // Include neighbors of matched nodes
        const neighborIds = new Set(matchedIds);
        graph.edges.forEach((e) => {
          if (matchedIds.has(e.source)) neighborIds.add(e.target);
          if (matchedIds.has(e.target)) neighborIds.add(e.source);
        });

        // Mark non-matching nodes as dimmed instead of hiding
        result = result.map((n) => {
          if (neighborIds.has(n.id)) return n;
          return { ...n, style: { ...n.style, opacity: 0.15 } };
        });
      }
    }

    return result;
  }, [graph.nodes, graph.edges, hiddenCategories, statsFilter]);

  const filteredNodeIds = useMemo(() => new Set(filteredNodes.map((n) => n.id)), [filteredNodes]);
  const filteredEdges = useMemo(() => {
    if (hiddenCategories.size === 0) return graph.edges;
    return graph.edges.filter((e) => filteredNodeIds.has(e.source) && filteredNodeIds.has(e.target));
  }, [graph.edges, hiddenCategories, filteredNodeIds]);

  const [nodes, setNodes] = useState<Node[]>(filteredNodes);

  useEffect(() => {
    setNodes(filteredNodes);
  }, [filteredNodes]);

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  );

  const minimapNodeColor = useCallback((node: Node) => {
    const cat = (node.data as EpNodeData)?.category;
    return cat ? COLORS[cat]?.border || "#6b7280" : "#6b7280";
  }, []);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const data = node.data as EpNodeData;
      if (data.clickable && data.episodeEntry && onOpenEpisode) {
        onOpenEpisode(data.episodeEntry);
      }
    },
    [onOpenEpisode],
  );

  // Auto-zoom to focused node (from deep links) — zoom inside canvas
  useEffect(() => {
    if (!focusLabel || !reactFlowInstance) return;
    const target = focusLabel.toLowerCase();
    const targetWords = target.split(/\s+/).filter((w) => w.length >= 3);
    const focusedNode = nodes.find((n) => {
      const d = n.data as EpNodeData;
      const text = [
        d.label.toLowerCase(),
        d.subtitle?.toLowerCase() || "",
        ...(d.meta ? Object.values(d.meta).map(v => v.toLowerCase()) : []),
        ...(d.detailList ? d.detailList.map(item => item.toLowerCase()) : []),
      ].join(" ");
      return text.includes(target) || (targetWords.length > 0 && targetWords.some(w => text.includes(w)));
    });
    if (focusedNode) {
      setTimeout(() => {
        reactFlowInstance.setCenter(
          focusedNode.position.x + 60,
          focusedNode.position.y + 20,
          { zoom: 2.2, duration: 800 },
        );
      }, 500);
    }
  }, [focusLabel, nodes, reactFlowInstance]);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <ReactFlow
        nodes={nodes}
        edges={filteredEdges}
        onNodesChange={onNodesChange}
        onNodeClick={handleNodeClick}
        nodeTypes={nodeTypes}
        nodesDraggable
        fitView
        fitViewOptions={{ padding: 0.15 }}
        colorMode="dark"
        minZoom={0.05}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: "smoothstep", style: { strokeWidth: 1.2, strokeOpacity: 0.6 } }}
      >
        <Background color="#1e1e30" gap={32} size={0.6} />
        <Controls style={{ bottom: 12, right: 12, left: "auto" }} />
        <MiniMap
          nodeColor={minimapNodeColor}
          maskColor="rgba(0,0,0,0.65)"
          style={{
            background: "rgba(13,13,18,0.9)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 12,
            height: 110,
            width: 160,
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          }}
        />
      </ReactFlow>
      <EpLegend hiddenCategories={hiddenCategories} onToggleCategory={toggleCategory} />
      <EpStatsBar episodes={episodes} onFilterChange={handleFilterChange} />
    </div>
  );
}

export function EpisodesKnowledgeGraph(props: EpisodesKnowledgeGraphProps) {
  return (
    <ReactFlowProvider>
      <EpisodesKnowledgeGraphInner {...props} />
    </ReactFlowProvider>
  );
}
