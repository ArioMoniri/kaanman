"use client";

import React, { useMemo, useCallback } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeTypes,
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
  patient: "\u2764",      // heart
  department: "\u2316",   // position indicator
  episode: "\u25CB",      // circle
  diagnosis: "\u26A0",    // warning
  medication: "\u2695",   // caduceus
  allergy: "\u2622",      // biohazard
  doctor: "\u2640",       // person
  facility: "\u2302",     // house
};

/* ------------------------------------------------------------------ */
/*  Custom node component                                              */
/* ------------------------------------------------------------------ */

function GraphNode({ data }: { data: GraphNodeData }) {
  const cat = data.category;
  const palette = COLORS[cat];
  const isCenter = cat === "patient";
  const size = isCenter ? 120 : cat === "department" ? 56 : 44;

  return (
    <div
      style={{
        width: isCenter ? 160 : undefined,
        minWidth: isCenter ? undefined : 100,
        maxWidth: isCenter ? 160 : 180,
        textAlign: "center",
        position: "relative",
      }}
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
          boxShadow: `0 0 ${isCenter ? 24 : 12}px ${palette.glow}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: isCenter ? 28 : cat === "department" ? 18 : 14,
          color: palette.text,
          fontWeight: 700,
          transition: "box-shadow 0.2s",
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

      {/* Episode count badge for departments */}
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
/*  Graph builder                                                      */
/* ------------------------------------------------------------------ */

function buildGraph(data: Record<string, unknown>): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let nid = 0;
  const nextId = () => `n${nid++}`;

  const patientInfo = (data.patient as Record<string, unknown>) || data;
  const episodes = (data.episodes as Record<string, unknown>[]) || [];
  const summary = (data.summary as Record<string, unknown>) || {};

  /* ---- center coords for radial layout ---- */
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
    data: {
      label: patientName,
      subtitle: [patientPid && `ID: ${patientPid}`, patientBirth].filter(Boolean).join(" | "),
      category: "patient" as NodeCategory,
    } satisfies GraphNodeData,
  });

  /* ============ 2. Build maps for dedup ============ */

  // Department -> episodes
  const deptEpisodes = new Map<string, string[]>();
  // Diagnosis key -> { name, icd, episodeIds }
  const diagMap = new Map<string, { name: string; icd: string; episodeNodeIds: string[] }>();
  // Doctor -> episodes
  const doctorEpisodes = new Map<string, string[]>();
  // Facility -> episodes
  const facilityEpisodes = new Map<string, string[]>();

  // Episode node IDs indexed by episode index
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
      if (!deptEpisodes.has(service)) deptEpisodes.set(service, []);
      deptEpisodes.get(service)!.push(epNodeId);
    }

    // Collect doctor
    if (doctor) {
      if (!doctorEpisodes.has(doctor)) doctorEpisodes.set(doctor, []);
      doctorEpisodes.get(doctor)!.push(epNodeId);
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
      if (!diagMap.has(key)) diagMap.set(key, { name: dxName, icd, episodeNodeIds: [] });
      diagMap.get(key)!.episodeNodeIds.push(epNodeId);
    });

    // Episode node (positioned later)
    nodes.push({
      id: epNodeId,
      type: "graphNode",
      position: { x: 0, y: 0 }, // placeholder
      data: {
        label: `${date || "No date"}`,
        subtitle: service,
        category: "episode" as NodeCategory,
        meta: {
          ...(episodeId && { id: episodeId }),
          ...(doctor && { doctor }),
        },
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

    nodes.push({
      id: deptId,
      type: "graphNode",
      position: { x: pos.x - 50, y: pos.y - 28 },
      data: {
        label: dept,
        category: "department" as NodeCategory,
        episodeCount: deptEpisodes.get(dept)!.length,
      } satisfies GraphNodeData,
    });

    // Edge: patient -> department
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
  // Group episodes by department for layout
  departments.forEach((dept, deptIdx) => {
    const epIds = deptEpisodes.get(dept)!;
    const deptAngle = (360 / departments.length) * deptIdx - 90;
    const deptPos = polarToCartesian(CX, CY, DEPT_RADIUS, deptAngle);
    const deptNodeId = deptNodeIds.get(dept)!;

    // Spread episodes in a fan around the department node
    const fanSpread = Math.min(120, epIds.length * 18);
    const startAngle = deptAngle - fanSpread / 2;

    epIds.forEach((epId, epIdx) => {
      const angle =
        epIds.length === 1
          ? deptAngle
          : startAngle + (fanSpread / (epIds.length - 1)) * epIdx;
      const pos = polarToCartesian(deptPos.x, deptPos.y, EPISODE_RADIUS, angle);

      // Update the position of the episode node
      const epNode = nodes.find((n) => n.id === epId);
      if (epNode) {
        epNode.position = { x: pos.x - 50, y: pos.y - 22 };
      }

      // Edge: department -> episode
      edges.push({
        id: `e-dept-ep-${deptNodeId}-${epId}`,
        source: deptNodeId,
        target: epId,
        style: { stroke: COLORS.episode.border, strokeWidth: 1 },
      });
    });
  });

  /* ============ 6. Diagnosis nodes (outer ring, deduplicated) ============ */
  const DIAG_RADIUS = 180;
  const diagEntries = Array.from(diagMap.entries());

  // Place diagnoses near the centroid of their connected episodes
  diagEntries.forEach(([key, { name, icd, episodeNodeIds: epIds }]) => {
    const diagId = nextId();

    // Compute centroid of connected episode nodes
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

    // Push outward from center
    const dx = avgX - CX;
    const dy = avgY - CY;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const px = avgX + (dx / dist) * DIAG_RADIUS;
    const py = avgY + (dy / dist) * DIAG_RADIUS;

    const displayName = name || key;
    const label = icd ? `${displayName}\n(${icd})` : displayName;

    nodes.push({
      id: diagId,
      type: "graphNode",
      position: { x: px - 50, y: py - 22 },
      data: {
        label: displayName.length > 30 ? displayName.slice(0, 28) + "..." : displayName,
        subtitle: icd || undefined,
        category: "diagnosis" as NodeCategory,
        episodeCount: epIds.length > 1 ? epIds.length : undefined,
      } satisfies GraphNodeData,
    });

    // Edges: episode -> diagnosis
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
        data: {
          label: medName.length > 28 ? medName.slice(0, 26) + "..." : medName,
          subtitle: dosage || undefined,
          category: "medication" as NodeCategory,
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
      data: {
        label: allergyLabel,
        subtitle: allergyDetail,
        category: "allergy" as NodeCategory,
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

  /* ============ 9. Doctor nodes (deduplicated) ============ */
  const doctors = Array.from(doctorEpisodes.keys());
  if (doctors.length > 0 && doctors.length <= 30) {
    const DOC_RADIUS = 250;
    const DOC_START = 140;
    const docSpread = Math.min(160, doctors.length * 18);

    doctors.forEach((doc, i) => {
      const docId = nextId();
      const angle =
        doctors.length === 1
          ? DOC_START
          : DOC_START - docSpread / 2 + (docSpread / (doctors.length - 1)) * i;
      const pos = polarToCartesian(CX, CY, DOC_RADIUS, angle);

      nodes.push({
        id: docId,
        type: "graphNode",
        position: { x: pos.x - 50, y: pos.y - 22 },
        data: {
          label: doc.length > 24 ? doc.slice(0, 22) + "..." : doc,
          category: "doctor" as NodeCategory,
          episodeCount: doctorEpisodes.get(doc)!.length,
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
/*  Stats bar                                                          */
/* ------------------------------------------------------------------ */

function StatsBar({ data }: { data: Record<string, unknown> }) {
  const episodes = (data.episodes as Record<string, unknown>[]) || [];
  const summary = (data.summary as Record<string, unknown>) || {};
  const departments = (summary.departments as string[]) || [];
  const doctors = (summary.doctors as string[]) || [];

  // Count unique diagnoses
  const diagSet = new Set<string>();
  episodes.forEach((ep) => {
    const dxs = (ep.diagnosis as Record<string, unknown>[]) || [];
    dxs.forEach((d) => {
      const key = (d.ICDCode as string) || (d.DiagnosisName as string) || "";
      if (key) diagSet.add(key);
    });
  });

  const stats = [
    { label: "Episodes", value: episodes.length },
    { label: "Departments", value: departments.length || new Set(episodes.map((e) => e.service_name)).size },
    { label: "Diagnoses", value: diagSet.size },
    { label: "Doctors", value: doctors.length || new Set(episodes.map((e) => e.doctor_name).filter(Boolean)).size },
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
      {stats.map(({ label, value }) => (
        <div key={label} style={{ textAlign: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#e5e7eb" }}>{value}</div>
          <div style={{ fontSize: 9, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5 }}>
            {label}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function KnowledgeGraph({ patientData, onClose }: KnowledgeGraphProps) {
  const { nodes, edges } = useMemo(() => buildGraph(patientData), [patientData]);

  const minimapNodeColor = useCallback((node: Node) => {
    const cat = (node.data as GraphNodeData)?.category;
    return cat ? COLORS[cat]?.border || "#6b7280" : "#6b7280";
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
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
            nodeTypes={nodeTypes}
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
