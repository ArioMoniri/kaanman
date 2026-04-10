"use client";

import React, { useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
} from "@xyflow/react";

interface KnowledgeGraphProps {
  patientData: Record<string, unknown>;
  onClose: () => void;
}

function buildGraph(data: Record<string, unknown>): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let nodeId = 0;

  const patientNode = `n${nodeId++}`;
  const name = (data.full_name as string) || (data.page_title as string) || "Patient";
  nodes.push({
    id: patientNode,
    type: "input",
    data: { label: name },
    position: { x: 400, y: 0 },
    style: { background: "#6366F1", color: "white", fontWeight: 700, borderRadius: 12, border: "none", padding: "8px 16px" },
  });

  // Episodes
  const episodes = (data.episodes as Record<string, unknown>[]) || [];
  const epY = 120;
  const epSpacing = 220;
  const startX = Math.max(0, 400 - (episodes.length * epSpacing) / 2);

  episodes.slice(0, 8).forEach((ep, i) => {
    const epId = `n${nodeId++}`;
    const date = (ep.date as string) || "";
    const service = (ep.service_name as string) || "Visit";
    nodes.push({
      id: epId,
      data: { label: `${date}\n${service}` },
      position: { x: startX + i * epSpacing, y: epY },
      style: { background: "#2A2A2E", color: "#E5E7EB", border: "1px solid #444", borderRadius: 8, fontSize: 11, whiteSpace: "pre-line" as const, padding: "6px 10px" },
    });
    edges.push({ id: `e-p-${epId}`, source: patientNode, target: epId, style: { stroke: "#555" } });

    // Diagnoses per episode
    const diagnoses = (ep.diagnosis as Record<string, unknown>[]) || [];
    diagnoses.slice(0, 4).forEach((d, j) => {
      const dxId = `n${nodeId++}`;
      const dxName = (d.DiagnosisName as string) || (d.diagnosis_name as string) || "Dx";
      const icd = (d.ICDCode as string) || "";
      nodes.push({
        id: dxId,
        data: { label: `${dxName}${icd ? `\n(${icd})` : ""}` },
        position: { x: startX + i * epSpacing + j * 50 - 50, y: epY + 120 + j * 70 },
        style: { background: "#1a1a2e", color: "#C4B5FD", border: "1px solid #6366F1", borderRadius: 8, fontSize: 10, whiteSpace: "pre-line" as const, padding: "4px 8px" },
      });
      edges.push({ id: `e-${epId}-${dxId}`, source: epId, target: dxId, style: { stroke: "#6366F155" } });
    });
  });

  // Allergies
  const allergy = data.allergy as Record<string, unknown> | undefined;
  if (allergy && typeof allergy === "object") {
    const alId = `n${nodeId++}`;
    const allergyText = JSON.stringify(allergy).length > 5 ? "Allergy Data" : "No Allergies";
    nodes.push({
      id: alId,
      data: { label: allergyText },
      position: { x: 50, y: 0 },
      style: { background: "#2A2A2E", color: "#EF4444", border: "1px solid #EF4444", borderRadius: 8, fontSize: 11, padding: "6px 10px" },
    });
    edges.push({ id: `e-p-al`, source: patientNode, target: alId, style: { stroke: "#EF444455" } });
  }

  return { nodes, edges };
}

export function KnowledgeGraph({ patientData, onClose }: KnowledgeGraphProps) {
  const { nodes, edges } = useMemo(() => buildGraph(patientData), [patientData]);

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6">
      <div className="w-full h-full max-w-6xl max-h-[85vh] bg-[#131316] rounded-2xl border border-border/30 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
          <h2 className="text-sm font-semibold text-gray-200">Patient Knowledge Graph</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 text-lg px-2"
          >
            &times;
          </button>
        </div>
        {/* Graph */}
        <div className="flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            fitView
            colorMode="dark"
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#333" gap={20} />
            <Controls />
          </ReactFlow>
        </div>
      </div>
    </div>
  );
}
