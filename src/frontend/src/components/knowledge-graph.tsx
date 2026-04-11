"use client";

import React, { useState, useMemo, useCallback, useRef } from "react";
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
} from "@xyflow/react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface KnowledgeGraphProps {
  patientData: Record<string, unknown>;
  onClose: () => void;
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
  /** Full list of items for hover tooltip (e.g. all episodes in a department) */
  detailList?: string[];
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/*  Color palette                                                      */
/* ------------------------------------------------------------------ */

const COLORS: Record<NodeCategory, { bg: string; border: string; text: string; glow: string }> = {
  patient:    { bg: "#312e81", border: "#6366f1", text: "#e0e7ff", glow: "rgba(99,102,241,0.35)" },
  department: { bg: "#064e3b", border: "#10b981", text: "#d1fae5", glow: "rgba(16,185,129,0.25)" },
  episode:    { bg: "#1f2937", border: "#6b7280", text: "#e5e7eb", glow: "rgba(107,114,128,0.15)" },
  diagnosis:  { bg: "#2e1065", border: "#a78bfa", text: "#ede9fe", glow: "rgba(167,139,250,0.25)" },
  medication: { bg: "#172554", border: "#3b82f6", text: "#dbeafe", glow: "rgba(59,130,246,0.25)" },
  allergy:    { bg: "#450a0a", border: "#ef4444", text: "#fee2e2", glow: "rgba(239,68,68,0.30)" },
  doctor:     { bg: "#1c1917", border: "#f59e0b", text: "#fef3c7", glow: "rgba(245,158,11,0.20)" },
  facility:   { bg: "#0c4a6e", border: "#06b6d4", text: "#cffafe", glow: "rgba(6,182,212,0.20)" },
};

const CATEGORY_ICONS: Record<NodeCategory, string> = {
  patient: "\u2764",
  department: "\u2316",
  episode: "\u25CB",
  diagnosis: "\u26A0",
  medication: "\u2695",
  allergy: "\u2622",
  doctor: "\u2640",
  facility: "\u2302",
};

/* ------------------------------------------------------------------ */
/*  Custom node component with hover tooltip                           */
/* ------------------------------------------------------------------ */

function GraphNode({ data }: { data: GraphNodeData }) {
  const [hovered, setHovered] = useState(false);
  const cat = data.category;
  const palette = COLORS[cat];
  const isCenter = cat === "patient";
  const size = isCenter ? 120 : cat === "department" ? 56 : 44;

  const hasDetails = data.detailList && data.detailList.length > 0;
  const hasMeta = data.meta && Object.keys(data.meta).length > 0;
  const showTooltip = hovered && (hasDetails || hasMeta || data.subtitle);

  return (
    <div
      style={{
        width: isCenter ? 160 : undefined,
        minWidth: isCenter ? undefined : 100,
        maxWidth: isCenter ? 160 : 180,
        textAlign: "center",
        position: "relative",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />

      {/* Glow ring */}
      <div
        style={{
          width: size,
          height: size,
          margin: "0 auto",
          borderRadius: "50%",
          background: palette.bg,
          border: `2px solid ${palette.border}`,
          boxShadow: hovered
            ? `0 0 ${isCenter ? 36 : 20}px ${palette.glow}, 0 0 ${isCenter ? 48 : 28}px ${palette.glow}`
            : `0 0 ${isCenter ? 24 : 12}px ${palette.glow}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: isCenter ? 28 : cat === "department" ? 18 : 14,
          color: palette.text,
          fontWeight: 700,
          transition: "box-shadow 0.2s, transform 0.2s",
          transform: hovered ? "scale(1.08)" : "scale(1)",
          cursor: "grab",
        }}
      >
        {isCenter
          ? data.label
              .split(" ")
              .map((w) => w[0])
              .join("")
              .slice(0, 2)
              .toUpperCase()
          : CATEGORY_ICONS[cat]}
      </div>

      {/* Label */}
      <div
        style={{
          marginTop: 6,
          fontSize: isCenter ? 13 : 10,
          fontWeight: isCenter ? 700 : 500,
          color: palette.text,
          lineHeight: 1.3,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: isCenter ? "normal" : "nowrap",
        }}
      >
        {data.label}
      </div>

      {/* Subtitle */}
      {data.subtitle && (
        <div
          style={{
            fontSize: 9,
            color: palette.border,
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {data.subtitle}
        </div>
      )}

      {/* Episode count badge */}
      {data.episodeCount && data.episodeCount > 0 && (
        <div
          style={{
            position: "absolute",
            top: -4,
            right: cat === "department" ? 10 : -2,
            background: palette.border,
            color: "#000",
            fontSize: 9,
            fontWeight: 700,
            borderRadius: 8,
            padding: "1px 5px",
            minWidth: 16,
            textAlign: "center",
          }}
        >
          {data.episodeCount}
        </div>
      )}

      {/* Hover tooltip */}
      {showTooltip && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: "50%",
            transform: "translateX(-50%)",
            marginTop: 8,
            background: "rgba(17,17,20,0.95)",
            backdropFilter: "blur(12px)",
            border: `1px solid ${palette.border}40`,
            borderRadius: 10,
            padding: "10px 14px",
            minWidth: 180,
            maxWidth: 320,
            maxHeight: 260,
            overflowY: "auto",
            zIndex: 100,
            textAlign: "left",
            boxShadow: `0 8px 32px rgba(0,0,0,0.6), 0 0 12px ${palette.glow}`,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: palette.text, marginBottom: 4 }}>
            {data.label}
          </div>
          {data.subtitle && (
            <div style={{ fontSize: 10, color: palette.border, marginBottom: 6 }}>
              {data.subtitle}
            </div>
          )}
          {hasMeta && (
            <div style={{ marginBottom: 6 }}>
              {Object.entries(data.meta!).map(([k, v]) => (
                <div key={k} style={{ fontSize: 9, color: "#9ca3af", lineHeight: 1.5 }}>
                  <span style={{ color: "#d1d5db", fontWeight: 600 }}>{k}:</span> {v}
                </div>
              ))}
            </div>
          )}
          {hasDetails && (
            <div>
              <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 }}>
                Details ({data.detailList!.length})
              </div>
              {data.detailList!.map((item, i) => (
                <div key={i} style={{ fontSize: 9, color: "#d1d5db", lineHeight: 1.6, borderBottom: "1px solid rgba(255,255,255,0.05)", paddingBottom: 2, marginBottom: 2 }}>
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
  // Exact match
  if (ICD_DESCRIPTIONS[icd]) return ICD_DESCRIPTIONS[icd];
  // Try parent code (e.g., J45.9 -> J45)
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
    position: { x: CX - 80, y: CY - 60 },
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

    // Collect department
    if (service) {
      if (!deptEpisodes.has(service)) deptEpisodes.set(service, { nodeIds: [], dates: [] });
      deptEpisodes.get(service)!.nodeIds.push(epNodeId);
      if (date) deptEpisodes.get(service)!.dates.push(date);
    }

    // Collect doctor
    if (doctor) {
      if (!doctorEpisodes.has(doctor)) doctorEpisodes.set(doctor, { nodeIds: [], departments: [] });
      doctorEpisodes.get(doctor)!.nodeIds.push(epNodeId);
      if (service && !doctorEpisodes.get(doctor)!.departments.includes(service)) {
        doctorEpisodes.get(doctor)!.departments.push(service);
      }
    }

    // Collect facility
    if (facility) {
      if (!facilityEpisodes.has(facility)) facilityEpisodes.set(facility, []);
      facilityEpisodes.get(facility)!.push(epNodeId);
    }

    // Collect diagnoses
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

    // Build episode detail meta
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
  const DEPT_RADIUS = 320;
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
      position: { x: pos.x - 50, y: pos.y - 28 },
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
  const EPISODE_RADIUS = 200;
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
        epNode.position = { x: pos.x - 50, y: pos.y - 22 };
      }

      edges.push({
        id: `e-dept-ep-${deptNodeId}-${epId}`,
        source: deptNodeId,
        target: epId,
        style: { stroke: COLORS.episode.border, strokeWidth: 1 },
      });
    });
  });

  /* ============ 6. Diagnosis nodes (deduplicated, with ICD descriptions) ============ */
  const DIAG_RADIUS = 180;
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
    // Always show ICD with description in subtitle
    const subtitleParts: string[] = [];
    if (icd) {
      subtitleParts.push(icdDesc ? `${icd} (${icdDesc})` : icd);
    }

    nodes.push({
      id: diagId,
      type: "graphNode",
      position: { x: px - 50, y: py - 22 },
      draggable: true,
      data: {
        label: displayName.length > 30 ? displayName.slice(0, 28) + "..." : displayName,
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
    const MED_RADIUS = 280;
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
        position: { x: pos.x - 50, y: pos.y - 22 },
        draggable: true,
        data: {
          label: medName.length > 28 ? medName.slice(0, 26) + "..." : medName,
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
    const pos = polarToCartesian(CX, CY, 260, ALLERGY_ANGLE);

    nodes.push({
      id: allergyId,
      type: "graphNode",
      position: { x: pos.x - 50, y: pos.y - 22 },
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

  /* ============ 9. Doctor nodes (deduplicated, with department lists) ============ */
  const doctors = Array.from(doctorEpisodes.keys());
  if (doctors.length > 0 && doctors.length <= 30) {
    const DOC_RADIUS = 250;
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
        position: { x: pos.x - 50, y: pos.y - 22 },
        draggable: true,
        data: {
          label: doc.length > 24 ? doc.slice(0, 22) + "..." : doc,
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

  /* ============ 10. Facility nodes (deduplicated) ============ */
  const facilities = Array.from(facilityEpisodes.keys());
  if (facilities.length > 0 && facilities.length <= 15) {
    const FAC_RADIUS = 260;
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
        position: { x: pos.x - 50, y: pos.y - 22 },
        draggable: true,
        data: {
          label: fac.length > 28 ? fac.slice(0, 26) + "..." : fac,
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
/*  Legend component                                                    */
/* ------------------------------------------------------------------ */

function Legend() {
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
        flexWrap: "wrap",
        gap: 10,
        background: "rgba(17,17,20,0.85)",
        backdropFilter: "blur(8px)",
        borderRadius: 10,
        padding: "8px 14px",
        border: "1px solid rgba(255,255,255,0.08)",
        zIndex: 10,
      }}
    >
      {items.map(({ category, label }) => (
        <div key={category} style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: COLORS[category].border,
              boxShadow: `0 0 6px ${COLORS[category].glow}`,
            }}
          />
          <span style={{ fontSize: 10, color: "#9ca3af" }}>{label}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Stats bar with hover lists                                         */
/* ------------------------------------------------------------------ */

function StatsBar({ data }: { data: Record<string, unknown> }) {
  const [hoveredStat, setHoveredStat] = useState<string | null>(null);

  const episodes = (data.episodes as Record<string, unknown>[]) || [];

  // Build lists for hover
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

  const stats: { label: string; value: number; list: [string, number][] }[] = [
    { label: "Episodes", value: episodes.length, list: [] },
    { label: "Departments", value: deptSet.size, list: sortedDepts },
    { label: "Diagnoses", value: diagSet.size, list: sortedDiags },
    { label: "Doctors", value: docSet.size, list: sortedDocs },
  ];

  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        display: "flex",
        gap: 16,
        background: "rgba(17,17,20,0.85)",
        backdropFilter: "blur(8px)",
        borderRadius: 10,
        padding: "8px 16px",
        border: "1px solid rgba(255,255,255,0.08)",
        zIndex: 10,
      }}
    >
      {stats.map(({ label, value, list }) => (
        <div
          key={label}
          style={{ textAlign: "center", position: "relative", cursor: list.length > 0 ? "pointer" : "default" }}
          onMouseEnter={() => list.length > 0 && setHoveredStat(label)}
          onMouseLeave={() => setHoveredStat(null)}
        >
          <div style={{ fontSize: 16, fontWeight: 700, color: "#e5e7eb" }}>{value}</div>
          <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5 }}>
            {label}
          </div>

          {/* Hover dropdown list */}
          {hoveredStat === label && list.length > 0 && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                right: 0,
                marginTop: 6,
                background: "rgba(17,17,20,0.95)",
                backdropFilter: "blur(12px)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 10,
                padding: "8px 0",
                minWidth: 240,
                maxWidth: 380,
                maxHeight: 320,
                overflowY: "auto",
                zIndex: 100,
                textAlign: "left",
                boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
              }}
            >
              <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5, padding: "2px 12px 6px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                {label} ({list.length})
              </div>
              {list.map(([name, count], i) => (
                <div
                  key={i}
                  style={{
                    fontSize: 10,
                    color: "#d1d5db",
                    padding: "4px 12px",
                    borderBottom: "1px solid rgba(255,255,255,0.03)",
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
                  <span style={{ color: "#6b7280", flexShrink: 0 }}>{count}x</span>
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

export function KnowledgeGraph({ patientData, onClose }: KnowledgeGraphProps) {
  const initialGraph = useMemo(() => buildGraph(patientData), [patientData]);
  const [nodes, setNodes] = useState<Node[]>(initialGraph.nodes);
  const edges = initialGraph.edges;
  const backdropRef = useRef<HTMLDivElement>(null);

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  );

  const minimapNodeColor = useCallback((node: Node) => {
    const cat = (node.data as GraphNodeData)?.category;
    return cat ? COLORS[cat]?.border || "#6b7280" : "#6b7280";
  }, []);

  // Close on backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === backdropRef.current) {
        onClose();
      }
    },
    [onClose],
  );

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
      onClick={handleBackdropClick}
    >
      <div className="w-full h-full max-w-[95vw] max-h-[92vh] bg-[#0d0d10] rounded-2xl border border-white/10 flex flex-col overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/10 bg-[#111114]">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
            <h2 className="text-sm font-semibold text-gray-200 tracking-wide">
              Patient Knowledge Graph
            </h2>
            <span className="text-xs text-gray-500 ml-2">
              {nodes.length} nodes &middot; {edges.length} relationships
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-200 transition-colors text-lg px-2 py-1 rounded hover:bg-white/5"
            aria-label="Close knowledge graph"
          >
            &times;
          </button>
        </div>

        {/* Graph */}
        <div className="flex-1 relative">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            nodeTypes={nodeTypes}
            nodesDraggable
            fitView
            fitViewOptions={{ padding: 0.15 }}
            colorMode="dark"
            minZoom={0.05}
            maxZoom={2.5}
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{
              type: "default",
              style: { strokeWidth: 1 },
            }}
          >
            <Background color="#1a1a2e" gap={40} size={1} />
            <Controls
              style={{
                bottom: 12,
                right: 12,
                left: "auto",
              }}
            />
            <MiniMap
              nodeColor={minimapNodeColor}
              maskColor="rgba(0,0,0,0.7)"
              style={{
                background: "#111114",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 8,
                height: 100,
                width: 150,
              }}
            />
          </ReactFlow>
          <Legend />
          <StatsBar data={patientData} />
        </div>
      </div>
    </div>
  );
}
