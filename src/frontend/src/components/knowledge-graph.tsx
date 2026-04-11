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
  type ReactFlowInstance,
  applyNodeChanges,
  Handle,
  Position,
} from "@xyflow/react";
import { ReportsKnowledgeGraph, type ManifestEntry } from "./reports-knowledge-graph";
import { EpisodesKnowledgeGraph, type EpisodeEntry } from "./episodes-knowledge-graph";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface KnowledgeGraphProps {
  patientData: Record<string, unknown>;
  onClose: () => void;
  focusLabel?: string;
  reportManifest?: ManifestEntry[];
  protocolId?: string;
  pacsAllStudies?: string;
  onOpenReport?: (entry: ManifestEntry) => void;
  onOpenPacs?: (entry: ManifestEntry) => void;
  onOpenTrend?: (testName: string) => void;
  episodeManifest?: EpisodeEntry[];
  onOpenEpisode?: (entry: EpisodeEntry) => void;
}

type NodeCategory =
  | "patient"
  | "department"
  | "episode"
  | "diagnosis"
  | "medication"
  | "allergy"
  | "doctor"
  | "facility";

interface GraphNodeData {
  label: string;
  subtitle?: string;
  category: NodeCategory;
  meta?: Record<string, string>;
  episodeCount?: number;
  detailList?: string[];
  focused?: boolean;
  dimmed?: boolean;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/*  Color palette — richer gradients & glows                           */
/* ------------------------------------------------------------------ */

const COLORS: Record<NodeCategory, { bg: string; bgEnd: string; border: string; text: string; glow: string; icon: string }> = {
  patient:    { bg: "#312e81", bgEnd: "#1e1b4b", border: "#818cf8", text: "#e0e7ff", glow: "rgba(129,140,248,0.4)", icon: "\u2764\uFE0F" },
  department: { bg: "#064e3b", bgEnd: "#022c22", border: "#34d399", text: "#d1fae5", glow: "rgba(52,211,153,0.3)", icon: "\u{1F3E5}" },
  episode:    { bg: "#1f2937", bgEnd: "#111827", border: "#9ca3af", text: "#e5e7eb", glow: "rgba(156,163,175,0.15)", icon: "\u{1F4CB}" },
  diagnosis:  { bg: "#2e1065", bgEnd: "#1e0a44", border: "#c4b5fd", text: "#ede9fe", glow: "rgba(196,181,253,0.3)", icon: "\u{1F9EC}" },
  medication: { bg: "#172554", bgEnd: "#0c1a3d", border: "#60a5fa", text: "#dbeafe", glow: "rgba(96,165,250,0.3)", icon: "\u{1F48A}" },
  allergy:    { bg: "#450a0a", bgEnd: "#2a0505", border: "#fca5a5", text: "#fee2e2", glow: "rgba(252,165,165,0.35)", icon: "\u26A0\uFE0F" },
  doctor:     { bg: "#422006", bgEnd: "#27150a", border: "#fbbf24", text: "#fef3c7", glow: "rgba(251,191,36,0.25)", icon: "\u{1FA7A}" },
  facility:   { bg: "#0c4a6e", bgEnd: "#082f49", border: "#22d3ee", text: "#cffafe", glow: "rgba(34,211,238,0.25)", icon: "\u{1F3E2}" },
};

/* ------------------------------------------------------------------ */
/*  Custom card-style node with hover tooltip                          */
/* ------------------------------------------------------------------ */

const DEFAULT_COLOR = { bg: "#1f2937", bgEnd: "#111827", border: "#9ca3af", text: "#e5e7eb", glow: "rgba(156,163,175,0.15)", icon: "📋" };

function GraphNode({ data }: { data: GraphNodeData }) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const cat = data.category;
  const palette = COLORS[cat] || DEFAULT_COLOR;
  const isCenter = cat === "patient";
  const isFocused = !!data.focused;
  const isDimmed = !!data.dimmed && !hovered;

  const hasDetails = data.detailList && data.detailList.length > 0;
  const hasMeta = data.meta && Object.keys(data.meta).length > 0;
  // Always show tooltip on hover/pin — even if only a label is available (Neo4j nodes may lack meta/details)
  const showTooltip = pinned || hovered;

  // Close tooltip when clicking outside
  const nodeRef = useRef<HTMLDivElement>(null);
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

      {/* Card node — compact sizing for dense graphs */}
      <div
        style={{
          background: isCenter
            ? `linear-gradient(135deg, ${palette.bg}, ${palette.bgEnd})`
            : `linear-gradient(180deg, ${palette.bg}, ${palette.bgEnd})`,
          border: `${isFocused ? "2px" : "1px"} solid ${isFocused ? palette.border : `${palette.border}${hovered ? "" : isDimmed ? "30" : "80"}`}`,
          borderRadius: isCenter ? 14 : 8,
          padding: isCenter ? "8px 12px" : "4px 8px",
          minWidth: isCenter ? 100 : 60,
          maxWidth: isCenter ? 140 : 120,
          boxShadow: isFocused
            ? `0 0 20px ${palette.glow}, 0 0 40px ${palette.glow}, 0 2px 10px rgba(0,0,0,0.5)`
            : hovered
              ? `0 0 14px ${palette.glow}, 0 2px 12px rgba(0,0,0,0.5)`
              : isDimmed
                ? `0 1px 3px rgba(0,0,0,0.2)`
                : `0 0 6px ${palette.glow}, 0 1px 4px rgba(0,0,0,0.3)`,
          transition: "all 0.3s ease",
          transform: isFocused ? "scale(1.1)" : hovered ? "scale(1.04)" : isDimmed ? "scale(0.9)" : "scale(1)",
          opacity: isDimmed ? 0.2 : 1,
          filter: isDimmed ? "grayscale(0.7)" : "none",
          animation: isFocused ? "pulse-focus 1.5s ease-in-out infinite" : undefined,
          cursor: "grab",
          position: "relative",
        }}
      >
        {/* Icon + Label row */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: isCenter ? "center" : "flex-start" }}>
          <span style={{ fontSize: isCenter ? 14 : 10, lineHeight: 1 }}>
            {palette.icon}
          </span>
          <div style={{ flex: 1, minWidth: 0, textAlign: isCenter ? "center" : "left" }}>
            <div
              style={{
                fontSize: isCenter ? 11 : 9,
                fontWeight: isCenter ? 800 : 600,
                color: palette.text,
                lineHeight: 1.2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: isCenter ? "normal" : "nowrap",
                letterSpacing: isCenter ? 0.2 : 0,
              }}
            >
              {data.label}
            </div>
            {data.subtitle && (
              <div
                style={{
                  fontSize: 7,
                  color: `${palette.border}cc`,
                  marginTop: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontWeight: 500,
                }}
              >
                {data.subtitle}
              </div>
            )}
          </div>
        </div>

        {/* Episode count badge */}
        {data.episodeCount && data.episodeCount > 0 && (
          <div
            style={{
              position: "absolute",
              top: -6,
              right: -5,
              background: `linear-gradient(135deg, ${palette.border}, ${palette.bg})`,
              color: "#fff",
              fontSize: 7,
              fontWeight: 700,
              borderRadius: 8,
              padding: "1px 5px",
              minWidth: 14,
              textAlign: "center",
              boxShadow: `0 1px 4px ${palette.glow}`,
              border: `1px solid ${palette.border}`,
            }}
          >
            {data.episodeCount}
          </div>
        )}

        {/* Bottom accent line for non-patient nodes */}
        {!isCenter && (
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 6,
              right: 6,
              height: 1,
              borderRadius: 1,
              background: `linear-gradient(90deg, transparent, ${palette.border}60, transparent)`,
            }}
          />
        )}
      </div>

      {/* Hover tooltip */}
      {showTooltip && (
        <div
          onClick={(ev) => ev.stopPropagation()}
          onMouseDown={(ev) => ev.stopPropagation()}
          style={{
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
            maxWidth: "min(340px, 40vw)",
            maxHeight: "min(280px, 45vh)",
            overflowY: "auto",
            zIndex: 100,
            textAlign: "left",
            boxShadow: `0 12px 40px rgba(0,0,0,0.7), 0 0 20px ${palette.glow}`,
            pointerEvents: "all" as const,
          }}
        >
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, paddingBottom: 6, borderBottom: `1px solid ${palette.border}20` }}>
            <span style={{ fontSize: 14 }}>{palette.icon}</span>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: palette.text }}>{data.label}</div>
              {data.subtitle && (
                <div style={{ fontSize: 10, color: `${palette.border}cc`, marginTop: 1 }}>{data.subtitle}</div>
              )}
            </div>
          </div>

          {/* Meta info */}
          {hasMeta && (
            <div style={{ marginBottom: 8 }}>
              {Object.entries(data.meta!).map(([k, v]) => (
                <div key={k} style={{ fontSize: 10, color: "#9ca3af", lineHeight: 1.6 }}>
                  <span style={{ color: "#d1d5db", fontWeight: 600 }}>{k}:</span> {v}
                </div>
              ))}
            </div>
          )}

          {/* Detail list */}
          {hasDetails && (
            <div>
              <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4, fontWeight: 600 }}>
                Details ({data.detailList!.length})
              </div>
              {data.detailList!.map((item, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: 10,
                    color: "#d1d5db",
                    lineHeight: 1.6,
                    borderBottom: i < data.detailList!.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none",
                    paddingBottom: 3,
                    marginBottom: 3,
                    paddingLeft: 6,
                    borderLeft: `2px solid ${palette.border}40`,
                  }}
                >
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
  graphNode: GraphNode,
};

/* ------------------------------------------------------------------ */
/*  Layout helpers                                                     */
/* ------------------------------------------------------------------ */

function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angleDeg: number,
): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
}

/* ------------------------------------------------------------------ */
/*  ICD code descriptions (common codes)                               */
/* ------------------------------------------------------------------ */

const ICD_DESCRIPTIONS: Record<string, string> = {
  "J45": "Asthma",
  "J45.0": "Predominantly allergic asthma",
  "J45.1": "Nonallergic asthma",
  "J45.9": "Asthma, unspecified",
  "H40": "Glaucoma",
  "H40.1": "Primary open-angle glaucoma",
  "H40.9": "Glaucoma, unspecified",
  "M45": "Ankylosing spondylitis",
  "M46": "Other inflammatory spondylopathies",
  "M54": "Dorsalgia",
  "M54.5": "Low back pain",
  "B18": "Chronic viral hepatitis",
  "B18.1": "Chronic viral hepatitis B",
  "K21": "Gastro-esophageal reflux disease",
  "K21.0": "GERD with esophagitis",
  "E11": "Type 2 diabetes mellitus",
  "I10": "Essential hypertension",
  "I25": "Chronic ischemic heart disease",
  "J44": "COPD",
  "N18": "Chronic kidney disease",
  "Z96": "Presence of functional implants",
};

function getIcdDescription(icd: string): string {
  if (!icd) return "";
  if (ICD_DESCRIPTIONS[icd]) return ICD_DESCRIPTIONS[icd];
  const parent = icd.split(".")[0];
  if (ICD_DESCRIPTIONS[parent]) return ICD_DESCRIPTIONS[parent];
  return "";
}

/* ------------------------------------------------------------------ */
/*  Graph builder                                                      */
/* ------------------------------------------------------------------ */

function buildGraph(data: Record<string, unknown>): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let nid = 0;
  const nextId = () => `n${nid++}`;

  const patientInfo = (data.patient as Record<string, unknown>) || data;
  const episodes = (data.episodes as Record<string, unknown>[]) || [];

  const CX = 0;
  const CY = 0;

  /* ============ 1. Patient node (center) ============ */
  const patientId = nextId();
  const patientName =
    (patientInfo.full_name as string) ||
    (patientInfo.page_title as string) ||
    (data.full_name as string) ||
    "Patient";

  const patientBirth = (patientInfo.birth_date as string) || "";
  const patientPid = (patientInfo.patient_id as string) || "";

  nodes.push({
    id: patientId,
    type: "graphNode",
    position: { x: CX - 50, y: CY - 25 },
    draggable: true,
    data: {
      label: patientName,
      subtitle: [patientPid && `ID: ${patientPid}`, patientBirth].filter(Boolean).join(" | "),
      category: "patient" as NodeCategory,
      meta: {
        ...(patientPid && { "Patient ID": patientPid }),
        ...(patientBirth && { "Birth Date": patientBirth }),
        "Total Episodes": String(episodes.length),
      },
    } satisfies GraphNodeData,
  });

  /* ============ 2. Build maps for dedup ============ */
  const deptEpisodes = new Map<string, { nodeIds: string[]; dates: string[] }>();
  const diagMap = new Map<string, { name: string; icd: string; episodeNodeIds: string[]; dates: string[] }>();
  const doctorEpisodes = new Map<string, { nodeIds: string[]; departments: string[] }>();
  const facilityEpisodes = new Map<string, string[]>();

  const episodeNodeIds: string[] = [];

  /* ============ 3. Create episode nodes & collect metadata ============ */
  episodes.forEach((ep) => {
    const epNodeId = nextId();
    episodeNodeIds.push(epNodeId);

    const date = (ep.date as string) || "";
    const service = (ep.service_name as string) || "Visit";
    const doctor = (ep.doctor_name as string) || "";
    const facility = (ep.facility_name as string) || "";
    const episodeId = (ep.episode_id as string) || "";

    if (service) {
      if (!deptEpisodes.has(service)) deptEpisodes.set(service, { nodeIds: [], dates: [] });
      deptEpisodes.get(service)!.nodeIds.push(epNodeId);
      if (date) deptEpisodes.get(service)!.dates.push(date);
    }

    if (doctor) {
      if (!doctorEpisodes.has(doctor)) doctorEpisodes.set(doctor, { nodeIds: [], departments: [] });
      doctorEpisodes.get(doctor)!.nodeIds.push(epNodeId);
      if (service && !doctorEpisodes.get(doctor)!.departments.includes(service)) {
        doctorEpisodes.get(doctor)!.departments.push(service);
      }
    }

    if (facility) {
      if (!facilityEpisodes.has(facility)) facilityEpisodes.set(facility, []);
      facilityEpisodes.get(facility)!.push(epNodeId);
    }

    const diagnoses = (ep.diagnosis as Record<string, unknown>[]) || [];
    diagnoses.forEach((d) => {
      const dxName = (d.DiagnosisName as string) || (d.diagnosis_name as string) || "";
      const icd = (d.ICDCode as string) || (d.icd_code as string) || "";
      const key = icd || dxName;
      if (!key) return;
      if (!diagMap.has(key)) diagMap.set(key, { name: dxName, icd, episodeNodeIds: [], dates: [] });
      diagMap.get(key)!.episodeNodeIds.push(epNodeId);
      if (date) diagMap.get(key)!.dates.push(date);
    });

    const dxSummary = diagnoses.map((d) => {
      const name = (d.DiagnosisName as string) || "";
      const icd = (d.ICDCode as string) || "";
      const desc = getIcdDescription(icd);
      if (icd && desc) return `${name} (${icd} - ${desc})`;
      if (icd) return `${name} (${icd})`;
      return name;
    }).filter(Boolean);

    const examText = ((ep.examination_text as string) || "").slice(0, 200);

    nodes.push({
      id: epNodeId,
      type: "graphNode",
      position: { x: 0, y: 0 },
      draggable: true,
      data: {
        label: `${date || "No date"}`,
        subtitle: service,
        category: "episode" as NodeCategory,
        meta: {
          ...(episodeId && { "Episode ID": episodeId }),
          ...(doctor && { Doctor: doctor }),
          ...(facility && { Facility: facility }),
        },
        detailList: [
          ...dxSummary.map((d) => `Dx: ${d}`),
          ...(examText ? [`Notes: ${examText}`] : []),
        ],
      } satisfies GraphNodeData,
    });
  });

  /* ============ 4. Department nodes (inner ring) ============ */
  const departments = Array.from(deptEpisodes.keys());
  const DEPT_RADIUS = 250;
  const deptNodeIds = new Map<string, string>();

  departments.forEach((dept, i) => {
    const deptId = nextId();
    deptNodeIds.set(dept, deptId);
    const angle = (360 / departments.length) * i - 90;
    const pos = polarToCartesian(CX, CY, DEPT_RADIUS, angle);
    const info = deptEpisodes.get(dept)!;

    nodes.push({
      id: deptId,
      type: "graphNode",
      position: { x: pos.x - 35, y: pos.y - 18 },
      draggable: true,
      data: {
        label: dept,
        category: "department" as NodeCategory,
        episodeCount: info.nodeIds.length,
        detailList: info.dates.map((d, idx) => `${idx + 1}. ${d}`),
      } satisfies GraphNodeData,
    });

    edges.push({
      id: `e-p-dept-${deptId}`,
      source: patientId,
      target: deptId,
      style: { stroke: COLORS.department.border, strokeWidth: 2 },
      animated: true,
    });
  });

  /* ============ 5. Position episode nodes around their department ============ */
  const EPISODE_RADIUS = 150;
  departments.forEach((dept, deptIdx) => {
    const epIds = deptEpisodes.get(dept)!.nodeIds;
    const deptAngle = (360 / departments.length) * deptIdx - 90;
    const deptPos = polarToCartesian(CX, CY, DEPT_RADIUS, deptAngle);
    const deptNodeId = deptNodeIds.get(dept)!;

    const fanSpread = Math.min(120, epIds.length * 18);
    const startAngle = deptAngle - fanSpread / 2;

    epIds.forEach((epId, epIdx) => {
      const angle =
        epIds.length === 1
          ? deptAngle
          : startAngle + (fanSpread / (epIds.length - 1)) * epIdx;
      const pos = polarToCartesian(deptPos.x, deptPos.y, EPISODE_RADIUS, angle);

      const epNode = nodes.find((n) => n.id === epId);
      if (epNode) {
        epNode.position = { x: pos.x - 35, y: pos.y - 14 };
      }

      edges.push({
        id: `e-dept-ep-${deptNodeId}-${epId}`,
        source: deptNodeId,
        target: epId,
        style: { stroke: COLORS.episode.border, strokeWidth: 1 },
      });
    });
  });

  /* ============ 6. Diagnosis nodes ============ */
  const DIAG_RADIUS = 130;
  const diagEntries = Array.from(diagMap.entries());

  diagEntries.forEach(([, { name, icd, episodeNodeIds: epIds, dates }]) => {
    const diagId = nextId();

    let avgX = 0;
    let avgY = 0;
    let count = 0;
    epIds.forEach((eid) => {
      const en = nodes.find((n) => n.id === eid);
      if (en) {
        avgX += en.position.x;
        avgY += en.position.y;
        count++;
      }
    });
    if (count > 0) {
      avgX /= count;
      avgY /= count;
    }

    const dx = avgX - CX;
    const dy = avgY - CY;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const px = avgX + (dx / dist) * DIAG_RADIUS;
    const py = avgY + (dy / dist) * DIAG_RADIUS;

    const displayName = name || icd;
    const icdDesc = getIcdDescription(icd);
    const subtitleParts: string[] = [];
    if (icd) {
      subtitleParts.push(icdDesc ? `${icd} (${icdDesc})` : icd);
    }

    nodes.push({
      id: diagId,
      type: "graphNode",
      position: { x: px - 35, y: py - 14 },
      draggable: true,
      data: {
        label: displayName.length > 24 ? displayName.slice(0, 22) + "..." : displayName,
        subtitle: subtitleParts.join("") || undefined,
        category: "diagnosis" as NodeCategory,
        episodeCount: epIds.length > 1 ? epIds.length : undefined,
        detailList: dates.map((d, i) => `Occurrence ${i + 1}: ${d}`),
      } satisfies GraphNodeData,
    });

    epIds.forEach((eid) => {
      edges.push({
        id: `e-ep-dx-${eid}-${diagId}`,
        source: eid,
        target: diagId,
        style: { stroke: COLORS.diagnosis.border, strokeWidth: 1, strokeDasharray: "4 2" },
      });
    });
  });

  /* ============ 7. Medication nodes ============ */
  const recipes = (patientInfo.previous_recipes as Record<string, unknown>[]) || [];
  if (recipes.length > 0) {
    const MED_ANGLE_START = 200;
    const MED_RADIUS = 220;
    const medSpread = Math.min(100, recipes.length * 15);

    recipes.forEach((med, i) => {
      const medId = nextId();
      const medName =
        (med.name as string) ||
        (med.RecipeName as string) ||
        (med.medicine_name as string) ||
        (med.MedicineName as string) ||
        JSON.stringify(med).slice(0, 40);
      const dosage = (med.dosage as string) || (med.Dosage as string) || "";

      const angle =
        recipes.length === 1
          ? MED_ANGLE_START
          : MED_ANGLE_START - medSpread / 2 + (medSpread / (recipes.length - 1)) * i;
      const pos = polarToCartesian(CX, CY, MED_RADIUS, angle);

      nodes.push({
        id: medId,
        type: "graphNode",
        position: { x: pos.x - 35, y: pos.y - 14 },
        draggable: true,
        data: {
          label: medName.length > 20 ? medName.slice(0, 18) + "..." : medName,
          subtitle: dosage || undefined,
          category: "medication" as NodeCategory,
          meta: {
            "Medication": medName,
            ...(dosage && { Dosage: dosage }),
          },
        } satisfies GraphNodeData,
      });

      edges.push({
        id: `e-p-med-${medId}`,
        source: patientId,
        target: medId,
        style: { stroke: COLORS.medication.border, strokeWidth: 1.5 },
      });
    });
  }

  /* ============ 8. Allergy node ============ */
  const allergy = (patientInfo.allergy || data.allergy) as Record<string, unknown> | undefined;
  if (allergy && typeof allergy === "object") {
    const allergyId = nextId();
    const allergySwc = (allergy.AllergySwc as string) || "";
    const hasAllergy = allergySwc !== "F" && allergySwc !== "";
    const allergyEntries = Object.entries(allergy).filter(([k]) => k !== "AllergySwc");

    let allergyLabel = "No Known Allergies";
    let allergyDetail: string | undefined;
    if (hasAllergy) {
      allergyLabel = "Allergy Alert";
      if (allergyEntries.length > 0) {
        allergyDetail = allergyEntries.map(([k, v]) => `${k}: ${v}`).join(", ");
      }
    }

    const ALLERGY_ANGLE = 30;
    const pos = polarToCartesian(CX, CY, 200, ALLERGY_ANGLE);

    nodes.push({
      id: allergyId,
      type: "graphNode",
      position: { x: pos.x - 35, y: pos.y - 14 },
      draggable: true,
      data: {
        label: allergyLabel,
        subtitle: allergyDetail,
        category: "allergy" as NodeCategory,
        meta: Object.fromEntries(allergyEntries.map(([k, v]) => [k, String(v)])),
      } satisfies GraphNodeData,
    });

    edges.push({
      id: `e-p-allergy`,
      source: patientId,
      target: allergyId,
      style: { stroke: COLORS.allergy.border, strokeWidth: 2, strokeDasharray: hasAllergy ? undefined : "6 3" },
      animated: hasAllergy,
    });
  }

  /* ============ 9. Doctor nodes ============ */
  const doctors = Array.from(doctorEpisodes.keys());
  if (doctors.length > 0 && doctors.length <= 30) {
    const DOC_RADIUS = 200;
    const DOC_START = 140;
    const docSpread = Math.min(160, doctors.length * 18);

    doctors.forEach((doc, i) => {
      const docId = nextId();
      const info = doctorEpisodes.get(doc)!;
      const angle =
        doctors.length === 1
          ? DOC_START
          : DOC_START - docSpread / 2 + (docSpread / (doctors.length - 1)) * i;
      const pos = polarToCartesian(CX, CY, DOC_RADIUS, angle);

      nodes.push({
        id: docId,
        type: "graphNode",
        position: { x: pos.x - 35, y: pos.y - 14 },
        draggable: true,
        data: {
          label: doc.length > 20 ? doc.slice(0, 18) + "..." : doc,
          category: "doctor" as NodeCategory,
          episodeCount: info.nodeIds.length,
          meta: {
            "Full Name": doc,
            "Episodes": String(info.nodeIds.length),
          },
          detailList: info.departments.map((d) => `Dept: ${d}`),
        } satisfies GraphNodeData,
      });

      edges.push({
        id: `e-p-doc-${docId}`,
        source: patientId,
        target: docId,
        style: { stroke: COLORS.doctor.border, strokeWidth: 1 },
      });
    });
  }

  /* ============ 10. Facility nodes ============ */
  const facilities = Array.from(facilityEpisodes.keys());
  if (facilities.length > 0 && facilities.length <= 15) {
    const FAC_RADIUS = 210;
    const FAC_START = -30;
    const facSpread = Math.min(100, facilities.length * 25);

    facilities.forEach((fac, i) => {
      const facId = nextId();
      const angle =
        facilities.length === 1
          ? FAC_START
          : FAC_START - facSpread / 2 + (facSpread / (facilities.length - 1)) * i;
      const pos = polarToCartesian(CX, CY, FAC_RADIUS, angle);

      nodes.push({
        id: facId,
        type: "graphNode",
        position: { x: pos.x - 35, y: pos.y - 14 },
        draggable: true,
        data: {
          label: fac.length > 20 ? fac.slice(0, 18) + "..." : fac,
          category: "facility" as NodeCategory,
          episodeCount: facilityEpisodes.get(fac)!.length,
        } satisfies GraphNodeData,
      });

      edges.push({
        id: `e-p-fac-${facId}`,
        source: patientId,
        target: facId,
        style: { stroke: COLORS.facility.border, strokeWidth: 1 },
      });
    });
  }

  return { nodes, edges };
}

/* ------------------------------------------------------------------ */
/*  Legend component — pill-style with category colors                  */
/* ------------------------------------------------------------------ */

function Legend({ hiddenCategories, onToggleCategory }: {
  hiddenCategories: Set<NodeCategory>;
  onToggleCategory: (cat: NodeCategory) => void;
}) {
  const items: { category: NodeCategory; label: string }[] = [
    { category: "patient", label: "Patient" },
    { category: "department", label: "Department" },
    { category: "episode", label: "Episode" },
    { category: "diagnosis", label: "Diagnosis" },
    { category: "medication", label: "Medication" },
    { category: "allergy", label: "Allergy" },
    { category: "doctor", label: "Doctor" },
    { category: "facility", label: "Facility" },
  ];

  return (
    <div
      style={{
        position: "absolute",
        bottom: 12,
        left: 12,
        display: "flex",
        flexDirection: "column",
        gap: 2,
        background: "linear-gradient(180deg, rgba(13,13,18,0.95), rgba(8,8,12,0.95))",
        backdropFilter: "blur(16px)",
        borderRadius: 10,
        padding: "8px 10px",
        border: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
        zIndex: 30,
        pointerEvents: "all",
      }}
    >
      <div style={{ fontSize: 8, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 700, marginBottom: 1, paddingLeft: 2 }}>
        Filter
      </div>
      {items.map(({ category, label }) => {
        const isHidden = hiddenCategories.has(category);
        return (
          <button
            key={category}
            onClick={() => category !== "patient" && onToggleCategory(category)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "3px 6px",
              borderRadius: 6,
              border: "none",
              cursor: category === "patient" ? "default" : "pointer",
              background: isHidden ? "rgba(255,255,255,0.02)" : `${COLORS[category].border}12`,
              opacity: isHidden ? 0.4 : 1,
              transition: "all 0.2s",
            }}
          >
            <div style={{
              width: 8, height: 8, borderRadius: 2,
              background: isHidden ? "#333" : COLORS[category].border,
              border: `1px solid ${isHidden ? "#444" : COLORS[category].border}`,
              transition: "all 0.2s",
            }} />
            <span style={{ fontSize: 9 }}>{COLORS[category].icon}</span>
            <span style={{ fontSize: 9, color: isHidden ? "#4b5563" : COLORS[category].text, fontWeight: 500 }}>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Stats bar with hover dropdown lists                                */
/* ------------------------------------------------------------------ */

function StatsBar({ data }: { data: Record<string, unknown> }) {
  const [hoveredStat, setHoveredStat] = useState<string | null>(null);
  const statsRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!hoveredStat) return;
    const handler = (e: MouseEvent) => {
      if (statsRef.current && !statsRef.current.contains(e.target as globalThis.Node)) {
        setHoveredStat(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [hoveredStat]);

  const episodes = (data.episodes as Record<string, unknown>[]) || [];

  const deptSet = new Map<string, number>();
  const diagSet = new Map<string, number>();
  const docSet = new Map<string, number>();

  episodes.forEach((ep) => {
    const svc = (ep.service_name as string) || "";
    if (svc) deptSet.set(svc, (deptSet.get(svc) || 0) + 1);

    const doc = (ep.doctor_name as string) || "";
    if (doc) docSet.set(doc, (docSet.get(doc) || 0) + 1);

    const dxs = (ep.diagnosis as Record<string, unknown>[]) || [];
    dxs.forEach((d) => {
      const name = (d.DiagnosisName as string) || "";
      const icd = (d.ICDCode as string) || "";
      const desc = getIcdDescription(icd);
      const label = icd
        ? `${name} (${icd}${desc ? ` - ${desc}` : ""})`
        : name;
      if (label) diagSet.set(label, (diagSet.get(label) || 0) + 1);
    });
  });

  const sortedDepts = Array.from(deptSet.entries()).sort((a, b) => b[1] - a[1]);
  const sortedDiags = Array.from(diagSet.entries()).sort((a, b) => b[1] - a[1]);
  const sortedDocs = Array.from(docSet.entries()).sort((a, b) => b[1] - a[1]);

  const stats: { label: string; value: number; color: string; list: [string, number][] }[] = [
    { label: "Episodes", value: episodes.length, color: COLORS.episode.border, list: [] },
    { label: "Departments", value: deptSet.size, color: COLORS.department.border, list: sortedDepts },
    { label: "Diagnoses", value: diagSet.size, color: COLORS.diagnosis.border, list: sortedDiags },
    { label: "Doctors", value: docSet.size, color: COLORS.doctor.border, list: sortedDocs },
  ];

  return (
    <div
      ref={statsRef}
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        display: "flex",
        gap: 2,
        background: "rgba(10,10,14,0.9)",
        backdropFilter: "blur(12px)",
        borderRadius: 10,
        padding: "4px 3px",
        border: "1px solid rgba(255,255,255,0.08)",
        zIndex: 30,
        pointerEvents: "all",
      }}
    >
      {stats.map(({ label, value, color, list }) => (
        <div
          key={label}
          style={{
            textAlign: "center",
            position: "relative",
            cursor: list.length > 0 ? "pointer" : "default",
            padding: "3px 10px",
            borderRadius: 6,
            background: hoveredStat === label ? "rgba(255,255,255,0.05)" : "transparent",
            transition: "background 0.2s",
          }}
          onClick={() => list.length > 0 && setHoveredStat(hoveredStat === label ? null : label)}
        >
          <div style={{ fontSize: 14, fontWeight: 800, color, lineHeight: 1.2 }}>{value}</div>
          <div style={{ fontSize: 8, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>
            {label}
          </div>

          {/* Hover dropdown list */}
          {hoveredStat === label && list.length > 0 && (
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
                minWidth: 240,
                maxWidth: "min(380px, 45vw)",
                maxHeight: "min(340px, 55vh)",
                overflowY: "auto",
                zIndex: 100,
                textAlign: "left",
                boxShadow: `0 12px 40px rgba(0,0,0,0.7), 0 0 12px ${color}15`,
              }}
            >
              <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.8, padding: "4px 14px 8px", borderBottom: `1px solid ${color}15`, fontWeight: 600 }}>
                {label} ({list.length})
              </div>
              {list.map(([name, count], i) => (
                <div
                  key={i}
                  style={{
                    fontSize: 11,
                    color: "#d1d5db",
                    padding: "6px 14px",
                    borderBottom: i < list.length - 1 ? "1px solid rgba(255,255,255,0.03)" : "none",
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "rgba(255,255,255,0.04)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
                >
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
                  <span style={{
                    color,
                    flexShrink: 0,
                    fontWeight: 600,
                    fontSize: 10,
                    background: `${color}15`,
                    padding: "1px 6px",
                    borderRadius: 6,
                  }}>{count}x</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function KnowledgeGraph({
  patientData,
  onClose,
  focusLabel,
  reportManifest,
  protocolId,
  pacsAllStudies,
  onOpenReport,
  onOpenPacs,
  onOpenTrend,
  episodeManifest,
  onOpenEpisode,
}: KnowledgeGraphProps) {
  const hasReports = reportManifest && reportManifest.length > 0;
  const hasEpisodes = episodeManifest && episodeManifest.length > 0;

  // Auto-switch to the correct tab when focusLabel matches a report type or episode
  const reportTypeNames = ["muayene", "laboratuvar", "radyoloji", "kardiyoloji", "endoskopi", "sgk", "patoloji"];
  const episodeTypeNames = ["yatış", "poliklinik", "episode", "epizod"];
  const focusMatchesReport = focusLabel && hasReports && reportTypeNames.some(rt => focusLabel.toLowerCase().includes(rt));
  const focusMatchesEpisode = focusLabel && hasEpisodes && episodeTypeNames.some(et => focusLabel.toLowerCase().includes(et));
  const initialTab = focusMatchesReport ? "reports" : focusMatchesEpisode ? "episodes" : "patient";
  const [activeTab, setActiveTab] = useState<"patient" | "reports" | "episodes">(initialTab);
  const [graphSource, setGraphSource] = useState<"local" | "neo4j">("local");
  const [hiddenCategories, setHiddenCategories] = useState<Set<NodeCategory>>(new Set());
  const [focusIsolation, setFocusIsolation] = useState(!!focusLabel);

  // Update tab when focusLabel changes (e.g., user clicks a different deep link while KG is open)
  useEffect(() => {
    if (focusMatchesReport) setActiveTab("reports");
    else if (focusMatchesEpisode) setActiveTab("episodes");
    else if (focusLabel) setActiveTab("patient");
    // Re-enable isolation when a new focus label arrives
    if (focusLabel) setFocusIsolation(true);
  }, [focusLabel, focusMatchesReport, focusMatchesEpisode]);

  const toggleCategory = useCallback((cat: NodeCategory) => {
    setHiddenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);
  const inlineGraph = useMemo(() => buildGraph(patientData), [patientData]);

  // Neo4j graph data (fetched async, falls back to inline)
  const [neo4jGraph, setNeo4jGraph] = useState<{ nodes: Node[]; edges: Edge[] } | null>(null);

  useEffect(() => {
    if (!protocolId) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(`${API_URL}/api/graph/${protocolId}/patient`);
        if (!resp.ok) return;
        const data = await resp.json();
        if (cancelled) return;
        if (data.source === "neo4j" && data.nodes && data.nodes.length > 0) {
          // Convert Neo4j nodes: ensure type, enrich properties→meta/subtitle
          const apiNodes: Node[] = data.nodes.map((n: Record<string, unknown>) => {
            const nodeData = (n.data || {}) as Record<string, unknown>;
            const props = (nodeData.properties || {}) as Record<string, string>;

            // Build meta from Neo4j properties
            const meta: Record<string, string> = {};
            const skipKeys = new Set(["updated_at", "patient_id", "created_at"]);
            for (const [k, v] of Object.entries(props)) {
              if (v && v !== "null" && v !== "undefined" && !skipKeys.has(k)) {
                const prettyKey = k.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
                meta[prettyKey] = String(v).length > 120 ? String(v).slice(0, 117) + "..." : String(v);
              }
            }

            // Build subtitle from key fields
            const subtitleParts: string[] = [];
            if (props.date) subtitleParts.push(props.date);
            if (props.service) subtitleParts.push(props.service);
            if (props.icd_code) subtitleParts.push(props.icd_code);
            if (props.dosage) subtitleParts.push(props.dosage);
            if (props.facility) subtitleParts.push(props.facility);
            const subtitle = (nodeData.subtitle as string) || subtitleParts.join(" · ") || undefined;

            return {
              ...n,
              type: (n.type as string) || "graphNode",
              position: (n.position as { x: number; y: number }) || { x: 0, y: 0 },
              draggable: true,
              data: {
                ...nodeData,
                subtitle,
                meta: Object.keys(meta).length > 0 ? meta : (nodeData.meta as Record<string, string>) || undefined,
              },
            };
          });
          const apiEdges: Edge[] = (data.edges || []).map((e: Record<string, unknown>) => {
            const category = (e.label as string) || "";
            const colorKey = category.includes("DIAGNOSIS") ? "diagnosis"
              : category.includes("EPISODE") ? "episode"
              : category.includes("REPORT") ? "report"
              : category.includes("FACILITY") ? "facility"
              : category.includes("DOCTOR") ? "doctor"
              : category.includes("MEDICATION") || category.includes("PRESCRIBED") ? "medication"
              : category.includes("ALLERGY") ? "allergy"
              : "department";
            const color = COLORS[colorKey as NodeCategory]?.border || "#6b7280";
            return {
              ...e,
              style: { stroke: color, strokeWidth: 1 },
            };
          });
          setNeo4jGraph({ nodes: apiNodes, edges: apiEdges });
          setGraphSource("neo4j");
        }
      } catch {
        // Neo4j unavailable — silently use inline graph
      }
    })();
    return () => { cancelled = true; };
  }, [protocolId]);

  // When deep-linked focus is active, stay on inline graph to preserve
  // focus matching — Neo4j node labels may differ from inline, causing
  // focus to fail and the view to revert to unfiltered
  const initialGraph = (focusLabel && focusIsolation) ? inlineGraph : (neo4jGraph || inlineGraph);

  // If focusLabel is provided and isolation is active, mark matching nodes as focused,
  // their neighbors as related, and everything else as dimmed
  const nodesWithFocus = useMemo(() => {
    if (!focusLabel || !focusIsolation) return initialGraph.nodes;
    const target = focusLabel.toLowerCase();

    // Split multi-word targets into individual words for broader matching
    const targetWords = target.split(/\s+/).filter((w) => w.length >= 3);

    // 1. Find all matching (focused) node IDs — try exact substring first, then word-level
    const focusedIds = new Set<string>();
    initialGraph.nodes.forEach((n) => {
      const d = n.data as GraphNodeData;
      const searchTexts = [
        d.label.toLowerCase(),
        d.subtitle?.toLowerCase() || "",
        ...(d.meta ? Object.values(d.meta).map((v) => v.toLowerCase()) : []),
        ...(d.detailList ? d.detailList.map((item) => item.toLowerCase()) : []),
      ].join(" ");

      // Exact substring match
      if (searchTexts.includes(target)) {
        focusedIds.add(n.id);
        return;
      }
      // Word-level match: if any target word matches
      if (targetWords.length > 0 && targetWords.some((w) => searchTexts.includes(w))) {
        focusedIds.add(n.id);
      }
    });

    // If no nodes match the focus label, don't dim anything — just show all normally
    if (focusedIds.size === 0) {
      return initialGraph.nodes;
    }

    // 2. Collect all node IDs reachable within 2 hops from focused nodes
    const relatedIds = new Set<string>(focusedIds);
    // Always include patient center node
    const patientNode = initialGraph.nodes.find((n) => (n.data as GraphNodeData).category === "patient");
    if (patientNode) relatedIds.add(patientNode.id);

    // Hop 1: direct neighbors of focused nodes
    initialGraph.edges.forEach((e) => {
      if (focusedIds.has(e.source)) relatedIds.add(e.target);
      if (focusedIds.has(e.target)) relatedIds.add(e.source);
    });
    // Hop 2: neighbors of neighbors (so connected episodes show their diagnoses, etc.)
    const hop1 = new Set(relatedIds);
    initialGraph.edges.forEach((e) => {
      if (hop1.has(e.source)) relatedIds.add(e.target);
      if (hop1.has(e.target)) relatedIds.add(e.source);
    });

    // 3. Mark nodes: focused, related (normal), or dimmed
    return initialGraph.nodes.map((n) => {
      const d = n.data as GraphNodeData;
      if (focusedIds.has(n.id)) {
        return { ...n, data: { ...d, focused: true, dimmed: false } };
      }
      if (relatedIds.has(n.id)) {
        return { ...n, data: { ...d, focused: false, dimmed: false } };
      }
      return { ...n, data: { ...d, focused: false, dimmed: true } };
    });
  }, [initialGraph.nodes, initialGraph.edges, focusLabel, focusIsolation]);

  // Filter by hidden categories
  const filteredNodes = useMemo(() => {
    if (hiddenCategories.size === 0) return nodesWithFocus;
    return nodesWithFocus.filter((n) => {
      const cat = (n.data as GraphNodeData).category;
      return !hiddenCategories.has(cat);
    });
  }, [nodesWithFocus, hiddenCategories]);

  const filteredNodeIds = useMemo(() => new Set(filteredNodes.map((n) => n.id)), [filteredNodes]);

  // Build a set of dimmed node IDs for edge styling
  const dimmedNodeIds = useMemo(() => {
    const set = new Set<string>();
    filteredNodes.forEach((n) => {
      if ((n.data as GraphNodeData).dimmed) set.add(n.id);
    });
    return set;
  }, [filteredNodes]);

  const filteredEdges = useMemo(() => {
    let edges = initialGraph.edges;
    if (hiddenCategories.size > 0) {
      edges = edges.filter((e) => filteredNodeIds.has(e.source) && filteredNodeIds.has(e.target));
    }
    // Dim edges connected to dimmed nodes
    if (focusLabel && focusIsolation && dimmedNodeIds.size > 0) {
      edges = edges.map((e) => {
        const isDimEdge = dimmedNodeIds.has(e.source) || dimmedNodeIds.has(e.target);
        if (isDimEdge) {
          return {
            ...e,
            style: { ...e.style, opacity: 0.08, strokeWidth: 0.5 },
            animated: false,
          };
        }
        return e;
      });
    }
    return edges;
  }, [initialGraph.edges, hiddenCategories, filteredNodeIds, focusLabel, focusIsolation, dimmedNodeIds]);

  const [nodes, setNodes] = useState<Node[]>(filteredNodes);
  const edges = filteredEdges;

  // Update nodes when graph source or filters change
  useEffect(() => {
    setNodes(filteredNodes);
  }, [filteredNodes]);
  const backdropRef = useRef<HTMLDivElement>(null);
  const rfInstance = useRef<ReactFlowInstance | null>(null);

  // Re-fit view when filters change, tab switches, or graph source changes
  // (but NOT when focus is active — focused zoom should be preserved)
  useEffect(() => {
    if (rfInstance.current && activeTab === "patient" && !(focusLabel && focusIsolation)) {
      setTimeout(() => {
        rfInstance.current?.fitView({ padding: 0.15, duration: 400, maxZoom: 0.85 });
      }, 250);
    }
  }, [hiddenCategories, activeTab, graphSource, focusLabel, focusIsolation]);

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  );

  const minimapNodeColor = useCallback((node: Node) => {
    const cat = (node.data as GraphNodeData)?.category;
    return cat ? COLORS[cat]?.border || "#6b7280" : "#6b7280";
  }, []);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === backdropRef.current) {
        onClose();
      }
    },
    [onClose],
  );

  return (
    <>
    {/* Focus pulse animation */}
    <style>{`
      @keyframes pulse-focus {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.75; }
      }
    `}</style>
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-3"
      style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(4px)" }}
      onClick={handleBackdropClick}
    >
      <div
        className="flex flex-col overflow-hidden"
        style={{
          width: "96vw",
          height: "92vh",
          background: "linear-gradient(180deg, #0d0d12, #08080c)",
          borderRadius: 16,
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow: "0 24px 80px rgba(0,0,0,0.6), 0 0 1px rgba(255,255,255,0.1)",
        }}
      >
        {/* Header — must stay above ReactFlow layers */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "8px 16px",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            background: "linear-gradient(180deg, rgba(20,20,28,0.8), transparent)",
            flexShrink: 0,
            position: "relative",
            zIndex: 20,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, overflow: "hidden", minWidth: 0 }}>
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "linear-gradient(135deg, #818cf8, #6366f1)",
                boxShadow: "0 0 12px rgba(129,140,248,0.5)",
                animation: "pulse 2s infinite",
                flexShrink: 0,
              }}
            />
            {/* Tab switcher */}
            <div style={{ display: "flex", gap: 2, padding: 2, background: "rgba(255,255,255,0.04)", borderRadius: 8 }}>
              <button
                onClick={() => setActiveTab("patient")}
                style={{
                  padding: "4px 14px",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  border: "none",
                  cursor: "pointer",
                  background: activeTab === "patient" ? "rgba(129,140,248,0.2)" : "transparent",
                  color: activeTab === "patient" ? "#e0e7ff" : "#6b7280",
                  transition: "all 0.2s",
                }}
              >
                Patient Data
              </button>
              {hasReports && (
                <button
                  onClick={() => setActiveTab("reports")}
                  style={{
                    padding: "4px 14px",
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 600,
                    border: "none",
                    cursor: "pointer",
                    background: activeTab === "reports" ? "rgba(129,140,248,0.2)" : "transparent",
                    color: activeTab === "reports" ? "#e0e7ff" : "#6b7280",
                    transition: "all 0.2s",
                  }}
                >
                  Reports
                </button>
              )}
              {hasEpisodes && (
                <button
                  onClick={() => setActiveTab("episodes")}
                  style={{
                    padding: "4px 14px",
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 600,
                    border: "none",
                    cursor: "pointer",
                    background: activeTab === "episodes" ? "rgba(248,113,113,0.2)" : "transparent",
                    color: activeTab === "episodes" ? "#fecaca" : "#6b7280",
                    transition: "all 0.2s",
                  }}
                >
                  Episodes
                </button>
              )}
            </div>
            <span style={{ fontSize: 11, color: "#6b7280", marginLeft: 4 }}>
              {activeTab === "patient"
                ? `${nodes.length} nodes \u00B7 ${edges.length} relationships`
                : activeTab === "reports"
                  ? `${reportManifest?.length || 0} reports`
                  : `${episodeManifest?.length || 0} episodes`}
            </span>
            {focusLabel && activeTab === "patient" && (
              <button
                onClick={() => setFocusIsolation(!focusIsolation)}
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  marginLeft: 6,
                  padding: "3px 10px",
                  borderRadius: 6,
                  border: `1px solid ${focusIsolation ? "rgba(129,140,248,0.4)" : "rgba(255,255,255,0.1)"}`,
                  background: focusIsolation ? "rgba(129,140,248,0.15)" : "rgba(255,255,255,0.05)",
                  color: focusIsolation ? "#a5b4fc" : "#9ca3af",
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
                title={focusIsolation ? `Showing: "${focusLabel}" — click to show all` : `Click to isolate "${focusLabel}"`}
              >
                {focusIsolation ? `🔍 ${focusLabel}` : "Show All"}
              </button>
            )}
            {activeTab === "patient" && graphSource === "neo4j" && (
              <span style={{
                fontSize: 9,
                color: "#34d399",
                background: "rgba(52,211,153,0.1)",
                border: "1px solid rgba(52,211,153,0.25)",
                padding: "2px 8px",
                borderRadius: 6,
                fontWeight: 600,
                marginLeft: 6,
              }}>
                Neo4j
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            {/* Lab Trends button */}
            {onOpenTrend && (
              <button
                onClick={() => onOpenTrend("")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "4px 12px",
                  borderRadius: 8,
                  fontSize: 11,
                  fontWeight: 600,
                  border: "1px solid rgba(96,165,250,0.3)",
                  background: "rgba(96,165,250,0.1)",
                  color: "#60a5fa",
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(96,165,250,0.2)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(96,165,250,0.1)";
                }}
                title="Open lab results trend monitor"
              >
                <span>📊</span>
                <span>Lab Trends</span>
              </button>
            )}
            {/* Fit View button */}
            {activeTab === "patient" && (
              <button
                onClick={() => rfInstance.current?.fitView({ padding: 0.15, duration: 400 })}
                style={{
                  padding: "4px 10px",
                  borderRadius: 8,
                  fontSize: 11,
                  fontWeight: 600,
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(255,255,255,0.04)",
                  color: "#9ca3af",
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.08)";
                  (e.currentTarget as HTMLButtonElement).style.color = "#e5e7eb";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.04)";
                  (e.currentTarget as HTMLButtonElement).style.color = "#9ca3af";
                }}
                title="Fit all nodes in view"
              >
                ⊞ Fit
              </button>
            )}
            <button
              onClick={onClose}
            style={{
              color: "#6b7280",
              fontSize: 18,
              padding: "4px 10px",
              borderRadius: 8,
              border: "none",
              background: "transparent",
              cursor: "pointer",
              transition: "all 0.2s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.06)";
              (e.currentTarget as HTMLButtonElement).style.color = "#e5e7eb";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              (e.currentTarget as HTMLButtonElement).style.color = "#6b7280";
            }}
            aria-label="Close knowledge graph"
          >
            &times;
          </button>
          </div>
        </div>

        {/* Graph */}
        <div style={{ flex: 1, position: "relative" }}>
          {activeTab === "patient" ? (
            <>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                nodeTypes={nodeTypes}
                nodesDraggable
                colorMode="dark"
                minZoom={0.02}
                maxZoom={3}
                proOptions={{ hideAttribution: true }}
                defaultEdgeOptions={{
                  type: "smoothstep",
                  style: { strokeWidth: 1.2, strokeOpacity: 0.6 },
                }}
                onInit={(instance) => {
                  rfInstance.current = instance;
                  if (focusLabel && focusIsolation) {
                    // Auto-zoom to the focused cluster
                    const currentNodes = filteredNodes;
                    const focusedNodes = currentNodes.filter((n) => (n.data as GraphNodeData).focused);
                    const relevantNodes = currentNodes.filter((n) => {
                      const d = n.data as GraphNodeData;
                      return d.focused || !d.dimmed;
                    });

                    if (focusedNodes.length > 0) {
                      let cx = 0, cy = 0;
                      focusedNodes.forEach((n) => { cx += n.position.x; cy += n.position.y; });
                      cx /= focusedNodes.length;
                      cy /= focusedNodes.length;

                      let maxDist = 0;
                      relevantNodes.forEach((n) => {
                        const dist = Math.sqrt((n.position.x - cx) ** 2 + (n.position.y - cy) ** 2);
                        if (dist > maxDist) maxDist = dist;
                      });
                      const zoom = maxDist > 500 ? 0.5 : maxDist > 300 ? 0.75 : maxDist > 150 ? 1.0 : 1.2;

                      setTimeout(() => {
                        instance.setCenter(cx + 60, cy + 20, { zoom, duration: 800 });
                      }, 400);
                    } else {
                      setTimeout(() => {
                        instance.fitView({ padding: 0.15, duration: 600, maxZoom: 0.85 });
                      }, 300);
                    }
                  } else {
                    // No focus — fit all nodes with comfortable zoom cap
                    setTimeout(() => {
                      instance.fitView({ padding: 0.15, duration: 600, maxZoom: 0.85 });
                    }, 300);
                  }
                }}
              >
                <Background color="#1e1e30" gap={32} size={0.6} />
                <Controls
                  style={{
                    bottom: 12,
                    right: 12,
                    left: "auto",
                  }}
                />
                <MiniMap
                  nodeColor={minimapNodeColor}
                  maskColor="rgba(0,0,0,0.65)"
                  style={{
                    background: "rgba(13,13,18,0.9)",
                    border: "1px solid rgba(255,255,255,0.06)",
                    borderRadius: 8,
                    height: 80,
                    width: 120,
                    boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
                  }}
                />
              </ReactFlow>
              <Legend hiddenCategories={hiddenCategories} onToggleCategory={toggleCategory} />
              <StatsBar data={patientData} />
            </>
          ) : activeTab === "reports" && hasReports && onOpenReport ? (
            <ReportsKnowledgeGraph
              manifest={reportManifest!}
              protocolId={protocolId}
              pacsAllStudies={pacsAllStudies}
              onClose={onClose}
              onOpenReport={onOpenReport}
              onOpenPacs={onOpenPacs}
              focusLabel={focusLabel}
            />
          ) : activeTab === "episodes" && hasEpisodes ? (
            <EpisodesKnowledgeGraph
              episodes={episodeManifest!}
              protocolId={protocolId}
              onClose={onClose}
              onOpenEpisode={onOpenEpisode}
              focusLabel={focusLabel}
            />
          ) : null}
        </div>
      </div>
    </div>
    </>
  );
}
