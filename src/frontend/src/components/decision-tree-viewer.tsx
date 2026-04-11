"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
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

  // Resizable width — default to ~1/3 of screen
  const defaultWidth = typeof window !== "undefined" ? Math.round(window.innerWidth / 3) : 420;
  const [width, setWidth] = useState(defaultWidth);
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(defaultWidth);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    startX.current = e.clientX;
    startW.current = width;
    e.preventDefault();
  }, [width]);

  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      if (!isDragging.current) return;
      const delta = e.clientX - startX.current;
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
      className="fixed top-0 left-0 h-screen z-40 bg-[#131316] flex"
      style={{ width }}
    >
      {/* Panel content */}
      <div className="flex-1 min-w-0 h-full flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
          <div className="flex items-center gap-2">
            <span className="text-accent text-sm">&#9670;</span>
            <h2 className="text-sm font-semibold text-gray-200">{title || "Clinical Decision Tree"}</h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 text-lg px-2 py-1 rounded hover:bg-white/5"
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

      {/* Drag handle on right edge — visible grip dots */}
      <div
        onMouseDown={handleMouseDown}
        className="w-4 h-full cursor-col-resize bg-[#1a1a1e] hover:bg-accent/20 active:bg-accent/40 transition-colors border-r border-border/40 shrink-0 flex items-center justify-center group"
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
    </div>
  );
}
