"use client";

import React, { useState, useMemo } from "react";

interface LabPoint {
  test_name: string;
  value: number | null;
  unit: string;
  ref_min: number | null;
  ref_max: number | null;
  date: string;
  section: string;
  is_abnormal: boolean;
}

interface TrendMonitorProps {
  protocolId: string;
  trends: Record<string, LabPoint[]>;
  onClose: () => void;
}

/** SVG sparkline for a single lab test */
function Sparkline({
  points,
  refMin,
  refMax,
  width = 180,
  height = 48,
}: {
  points: { value: number; is_abnormal: boolean }[];
  refMin: number | null;
  refMax: number | null;
  width?: number;
  height?: number;
}) {
  if (points.length === 0) return null;

  const values = points.map((p) => p.value);
  const allNums = [...values];
  if (refMin !== null) allNums.push(refMin);
  if (refMax !== null) allNums.push(refMax);
  const yMin = Math.min(...allNums) * 0.9;
  const yMax = Math.max(...allNums) * 1.1;
  const yRange = yMax - yMin || 1;

  const pad = 4;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const xStep = points.length > 1 ? w / (points.length - 1) : 0;

  const linePoints = points
    .map((p, i) => `${pad + i * xStep},${pad + h - ((p.value - yMin) / yRange) * h}`)
    .join(" ");

  const refMinY = refMin !== null ? pad + h - ((refMin - yMin) / yRange) * h : null;
  const refMaxY = refMax !== null ? pad + h - ((refMax - yMin) / yRange) * h : null;

  return (
    <svg width={width} height={height} className="flex-shrink-0">
      {refMinY !== null && refMaxY !== null && (
        <rect
          x={pad} y={Math.min(refMinY, refMaxY)}
          width={w} height={Math.abs(refMaxY - refMinY)}
          fill="rgba(52,211,153,0.08)" rx={2}
        />
      )}
      {refMinY !== null && (
        <line x1={pad} y1={refMinY} x2={pad + w} y2={refMinY}
          stroke="rgba(52,211,153,0.25)" strokeWidth={1} strokeDasharray="3,3" />
      )}
      {refMaxY !== null && (
        <line x1={pad} y1={refMaxY} x2={pad + w} y2={refMaxY}
          stroke="rgba(52,211,153,0.25)" strokeWidth={1} strokeDasharray="3,3" />
      )}
      <polyline points={linePoints} fill="none" stroke="#818cf8"
        strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => (
        <circle key={i}
          cx={pad + i * xStep}
          cy={pad + h - ((p.value - yMin) / yRange) * h}
          r={2.5}
          fill={p.is_abnormal ? "#ef4444" : "#818cf8"}
          stroke={p.is_abnormal ? "#fca5a5" : "#c7d2fe"}
          strokeWidth={1}
        />
      ))}
    </svg>
  );
}

const SECTIONS = [
  "ALL", "HEMATOLOJI", "BIYOKIMYA", "HORMON",
  "IMMUNOLOJI", "KOAGULASYON", "SEROLOJI", "IDRAR TAHLILI",
];

export function TrendMonitor({ protocolId, trends, onClose }: TrendMonitorProps) {
  const [search, setSearch] = useState("");
  const [section, setSection] = useState("ALL");
  const [showAbnormalOnly, setShowAbnormalOnly] = useState(false);
  const [expandedTest, setExpandedTest] = useState<string | null>(null);

  const testNames = useMemo(() => Object.keys(trends).filter((k) => !k.startsWith("_")), [trends]);

  const abnormalSummary = useMemo(() => (trends._abnormal_summary || []) as LabPoint[], [trends]);

  const filteredTests = useMemo(() => {
    return testNames.filter((name) => {
      const points = trends[name];
      if (!points || points.length === 0) return false;
      if (section !== "ALL") {
        const normalized = section.replace(/\u0130/g, "I").replace(/\u00D6/g, "O").replace(/\u00DC/g, "U");
        const testSection = (points[0]?.section || "").replace(/\u0130/g, "I").replace(/\u00D6/g, "O").replace(/\u00DC/g, "U");
        if (!testSection.includes(normalized)) return false;
      }
      if (showAbnormalOnly) {
        if (!points.some((p: LabPoint) => p.is_abnormal)) return false;
      }
      if (search && !name.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [testNames, trends, section, showAbnormalOnly, search]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(4px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden"
        style={{
          background: "linear-gradient(180deg, #0d0d12, #08080c)",
          borderRadius: 16,
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
        }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 8, height: 8, borderRadius: "50%",
              background: "linear-gradient(135deg, #34d399, #10b981)",
              boxShadow: "0 0 12px rgba(52,211,153,0.5)",
            }} />
            <div>
              <h2 style={{ fontSize: 14, fontWeight: 700, color: "#e5e7eb" }}>Lab Value Trends</h2>
              <span style={{ fontSize: 11, color: "#6b7280" }}>
                {testNames.length} tests tracked &middot; {abnormalSummary.length} currently abnormal
              </span>
            </div>
          </div>
          <button onClick={onClose} style={{
            color: "#6b7280", fontSize: 18, padding: "4px 10px",
            borderRadius: 8, border: "none", background: "transparent", cursor: "pointer",
          }}>&times;</button>
        </div>

        {/* Filters */}
        <div style={{ padding: "10px 20px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
          <input type="text" placeholder="Search tests..." value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 8, padding: "5px 12px", fontSize: 12, color: "#e5e7eb", outline: "none", width: 180,
            }} />
          <button onClick={() => setShowAbnormalOnly(!showAbnormalOnly)}
            style={{
              padding: "4px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, border: "none", cursor: "pointer",
              background: showAbnormalOnly ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.04)",
              color: showAbnormalOnly ? "#fca5a5" : "#9ca3af",
            }}>Abnormal Only</button>
          <div style={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
            {SECTIONS.map((s) => (
              <button key={s} onClick={() => setSection(s)}
                style={{
                  padding: "3px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600,
                  border: "none", cursor: "pointer",
                  background: section === s ? "rgba(129,140,248,0.2)" : "transparent",
                  color: section === s ? "#c7d2fe" : "#6b7280",
                }}>{s}</button>
            ))}
          </div>
        </div>

        {/* Test list */}
        <div style={{ flex: 1, overflow: "auto", padding: "8px 20px" }}>
          {filteredTests.length === 0 ? (
            <div style={{ color: "#6b7280", fontSize: 13, textAlign: "center", padding: 40 }}>
              No matching lab tests found
            </div>
          ) : filteredTests.map((testName) => {
            const points = trends[testName] as LabPoint[];
            const numericPoints = points.filter((p) => p.value !== null) as (LabPoint & { value: number })[];
            const latest = numericPoints[numericPoints.length - 1];
            const isExpanded = expandedTest === testName;
            const isAbnormal = latest?.is_abnormal || false;

            return (
              <div key={testName} onClick={() => setExpandedTest(isExpanded ? null : testName)}
                style={{
                  padding: "10px 12px", marginBottom: 4, borderRadius: 8, cursor: "pointer",
                  background: isExpanded ? "rgba(255,255,255,0.04)" : "transparent",
                  border: `1px solid ${isAbnormal ? "rgba(239,68,68,0.15)" : "rgba(255,255,255,0.03)"}`,
                  transition: "all 0.15s",
                }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: isAbnormal ? "#fca5a5" : "#e5e7eb" }}>
                        {testName}
                      </span>
                      {isAbnormal && (
                        <span style={{ fontSize: 9, color: "#ef4444", background: "rgba(239,68,68,0.15)", padding: "1px 6px", borderRadius: 4 }}>
                          ABNORMAL
                        </span>
                      )}
                    </div>
                    {latest && (
                      <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
                        Latest: <span style={{ color: isAbnormal ? "#fca5a5" : "#d1d5db", fontWeight: 600 }}>{latest.value}</span>
                        {" "}{latest.unit}
                        {latest.ref_min !== null && latest.ref_max !== null && (
                          <span style={{ marginLeft: 6 }}>(ref: {latest.ref_min} - {latest.ref_max})</span>
                        )}
                        <span style={{ marginLeft: 8, color: "#4b5563" }}>{latest.date}</span>
                      </div>
                    )}
                  </div>
                  <Sparkline
                    points={numericPoints.map((p) => ({ value: p.value, is_abnormal: p.is_abnormal }))}
                    refMin={latest?.ref_min ?? null}
                    refMax={latest?.ref_max ?? null}
                  />
                  <span style={{ fontSize: 10, color: "#4b5563", minWidth: 20, textAlign: "right" }}>
                    {numericPoints.length}x
                  </span>
                </div>
                {isExpanded && (
                  <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                    <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 6, fontWeight: 600 }}>
                      {points[0]?.section || "Unknown Section"} &middot; All Values
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 4 }}>
                      {numericPoints.map((p, i) => (
                        <div key={i} style={{
                          fontSize: 11, padding: "4px 8px", borderRadius: 4,
                          background: p.is_abnormal ? "rgba(239,68,68,0.08)" : "rgba(255,255,255,0.02)",
                          color: p.is_abnormal ? "#fca5a5" : "#d1d5db",
                          display: "flex", justifyContent: "space-between",
                        }}>
                          <span style={{ fontWeight: 600 }}>{p.value}</span>
                          <span style={{ color: "#4b5563" }}>{p.date}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
