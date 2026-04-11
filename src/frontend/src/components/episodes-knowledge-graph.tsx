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
      zIndex: 10,
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

function EpStatsBar({ episodes }: { episodes: EpisodeEntry[] }) {
  const yatisCount = episodes.filter((e) => e.is_hospitalization).length;
  const poliCount = episodes.length - yatisCount;
  const deptCount = new Set(episodes.map((e) => e.service_text).filter(Boolean)).size;
  const docCount = new Set(episodes.map((e) => e.doctor_name).filter(Boolean)).size;

  const stats = [
    { label: "Yatış", value: yatisCount, color: COLORS.hospitalization.border },
    { label: "Poliklinik", value: poliCount, color: COLORS.poliklinik.border },
    { label: "Departments", value: deptCount, color: COLORS.department.border },
    { label: "Doctors", value: docCount, color: COLORS.doctor.border },
  ];

  return (
    <div style={{
      position: "absolute", top: 12, right: 12, display: "flex", gap: 2,
      background: "rgba(10,10,14,0.9)", backdropFilter: "blur(12px)",
      borderRadius: 12, padding: "6px 4px", border: "1px solid rgba(255,255,255,0.08)",
      zIndex: 10,
    }}>
      {stats.map(({ label, value, color }) => (
        <div key={label} style={{ textAlign: "center", padding: "4px 14px", borderRadius: 8 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color, lineHeight: 1.2 }}>{value}</div>
          <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>{label}</div>
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
  const reactFlowInstance = useReactFlow();

  const toggleCategory = useCallback((cat: EpCategory) => {
    setHiddenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  const filteredNodes = useMemo(() => {
    if (hiddenCategories.size === 0) return graph.nodes;
    return graph.nodes.filter((n) => !hiddenCategories.has((n.data as EpNodeData).category));
  }, [graph.nodes, hiddenCategories]);

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

  // Auto-zoom to focused node (from deep links)
  useEffect(() => {
    if (!focusLabel || !reactFlowInstance) return;
    const target = focusLabel.toLowerCase();
    const focusedNode = nodes.find((n) => {
      const d = n.data as EpNodeData;
      return d.label.toLowerCase().includes(target) ||
        (d.subtitle && d.subtitle.toLowerCase().includes(target)) ||
        (d.meta && Object.values(d.meta).some(v => v.toLowerCase().includes(target)));
    });
    if (focusedNode) {
      setTimeout(() => {
        reactFlowInstance.fitView({
          nodes: [{ id: focusedNode.id }],
          duration: 800,
          padding: 3,
        });
      }, 400);
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
      <EpStatsBar episodes={episodes} />
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
