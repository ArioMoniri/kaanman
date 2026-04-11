"use client";

import React, { useRef, useCallback } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
} from "@xyflow/react";

interface DecisionTreeNode {
  id: string;
  type?: string;
  data: { label?: string };
  position: { x?: number; y?: number };
}

interface DecisionTreeEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

interface DecisionTreeViewerProps {
  title: string;
  nodes: DecisionTreeNode[];
  edges: DecisionTreeEdge[];
  onClose: () => void;
}

const NODE_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  input: { bg: "#6366F1", border: "none", text: "#fff" },
  output: { bg: "#1a2e1a", border: "1px solid #22C55E", text: "#86EFAC" },
  default: { bg: "#2A2A2E", border: "1px solid #444", text: "#E5E7EB" },
};

function buildFlowNodes(nodes: DecisionTreeNode[]): Node[] {
  return nodes.map((n) => {
    const colors = NODE_COLORS[n.type || "default"] || NODE_COLORS.default;
    return {
      id: n.id,
      type: n.type === "output" ? "output" : n.type === "input" ? "input" : "default",
      data: { label: n.data?.label || n.id },
      position: { x: n.position?.x || 0, y: n.position?.y || 0 },
      style: {
        background: colors.bg,
        color: colors.text,
        border: colors.border,
        borderRadius: 10,
        fontSize: 12,
        fontWeight: 500,
        padding: "8px 14px",
        whiteSpace: "pre-line" as const,
        maxWidth: 220,
      },
    };
  });
}

function buildFlowEdges(edges: DecisionTreeEdge[]): Edge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label || undefined,
    style: { stroke: "#555" },
    labelStyle: { fill: "#aaa", fontSize: 10 },
    labelBgStyle: { fill: "#1F2023", fillOpacity: 0.9 },
    labelBgPadding: [4, 2] as [number, number],
    labelBgBorderRadius: 4,
  }));
}

export function DecisionTreeViewer({ title, nodes, edges, onClose }: DecisionTreeViewerProps) {
  const flowNodes = buildFlowNodes(nodes);
  const flowEdges = buildFlowEdges(edges);
  const backdropRef = useRef<HTMLDivElement>(null);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === backdropRef.current) onClose();
    },
    [onClose],
  );

  return (
    <div ref={backdropRef} className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6" onClick={handleBackdropClick}>
      <div className="w-full h-full max-w-6xl max-h-[85vh] bg-[#131316] rounded-2xl border border-border/30 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
          <div className="flex items-center gap-2">
            <span className="text-accent text-sm">&#9670;</span>
            <h2 className="text-sm font-semibold text-gray-200">{title || "Clinical Decision Tree"}</h2>
          </div>
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
            nodes={flowNodes}
            edges={flowEdges}
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
