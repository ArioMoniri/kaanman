"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

interface ReportViewerProps {
  file: string;
  textFile?: string;
  title: string;
  protocolId: string;
  onClose: () => void;
  highlightText?: string;
  /** Report ID for PACS link lookup */
  reportId?: string;
  /** Accession number for direct PACS access */
  accessionNumber?: string;
  /** Override base URL path for file serving (e.g., "episodes" instead of "reports") */
  fileEndpointType?: "reports" | "episodes";
}

/** Scrolls to and highlights the first occurrence of `text` in the container */
function highlightAndScroll(container: HTMLElement, text: string) {
  if (!text || text.length < 2) return;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const lowerText = text.toLowerCase();
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const idx = (node.textContent || "").toLowerCase().indexOf(lowerText);
    if (idx >= 0) {
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + text.length);
      const mark = document.createElement("mark");
      mark.style.background = "rgba(251,191,36,0.35)";
      mark.style.color = "#fef3c7";
      mark.style.borderRadius = "2px";
      mark.style.padding = "0 2px";
      range.surroundContents(mark);
      mark.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
  }
}

export function ReportViewer({
  file,
  textFile,
  title,
  protocolId,
  onClose,
  highlightText,
  reportId,
  accessionNumber,
  fileEndpointType = "reports",
}: ReportViewerProps) {
  const [mode, setMode] = useState<"pdf" | "txt">("pdf");
  const [pdfFailed, setPdfFailed] = useState(false);
  const [txtContent, setTxtContent] = useState<string | null>(null);
  const [txtLoading, setTxtLoading] = useState(false);
  const [pacsLoading, setPacsLoading] = useState(false);
  const txtRef = useRef<HTMLPreElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const iframeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasPacs = !!accessionNumber;
  const [pacsLinkAge, setPacsLinkAge] = useState<number>(0); // seconds since last refresh
  const [pacsRefreshing, setPacsRefreshing] = useState(false);
  const [pacsLinkReady, setPacsLinkReady] = useState(false);
  const pacsAgeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pacsRefreshTimeRef = useRef<number>(0);

  // PACS link expiry threshold (5 minutes — links use timestamp in SHA1)
  const PACS_EXPIRY_SECONDS = 300;

  // Track link age for expiry indicator
  useEffect(() => {
    if (!hasPacs) return;
    pacsAgeTimerRef.current = setInterval(() => {
      if (pacsRefreshTimeRef.current > 0) {
        setPacsLinkAge(Math.floor((Date.now() - pacsRefreshTimeRef.current) / 1000));
      }
    }, 1000);
    return () => {
      if (pacsAgeTimerRef.current) clearInterval(pacsAgeTimerRef.current);
    };
  }, [hasPacs]);

  /** Refresh the PACS link (re-sign with fresh timestamp) */
  const handleRefreshPacs = useCallback(async () => {
    setPacsRefreshing(true);
    try {
      const resp = await fetch(`${API_URL}/api/reports/${protocolId}/pacs/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          report_id: reportId || null,
          accession_number: accessionNumber || null,
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.url) {
        pacsRefreshTimeRef.current = Date.now();
        setPacsLinkAge(0);
        setPacsLinkReady(true);
      }
    } catch {
      // Refresh failed
    } finally {
      setPacsRefreshing(false);
    }
  }, [protocolId, reportId, accessionNumber]);

  /** Fetch a fresh signed PACS URL and open in new tab */
  const handleOpenPacs = useCallback(async () => {
    setPacsLoading(true);
    try {
      const resp = await fetch(`${API_URL}/api/reports/${protocolId}/pacs/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          report_id: reportId || null,
          accession_number: accessionNumber || null,
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.url) {
        pacsRefreshTimeRef.current = Date.now();
        setPacsLinkAge(0);
        setPacsLinkReady(true);
        window.open(data.url, "_blank", "noopener");
      }
    } catch {
      // If backend fails, try with stored URL as fallback (may be expired)
    } finally {
      setPacsLoading(false);
    }
  }, [protocolId, reportId, accessionNumber]);

  const fileBase = `${API_URL}/api/${fileEndpointType}/${protocolId}/file`;
  const pdfUrl = `${fileBase}/${encodeURIComponent(file)}`;
  const txtUrl = textFile
    ? `${fileBase}/${encodeURIComponent(textFile)}`
    : null;

  const isPdf = file.toLowerCase().endsWith(".pdf");
  const isRtf = file.toLowerCase().endsWith(".rtf");
  const isHtml = file.toLowerCase().endsWith(".html");
  // RTF and BIN can't render in iframe — only PDF and HTML can
  const canRenderInIframe = isPdf || isHtml;

  // Load TXT content when needed
  const loadTxt = useCallback(async () => {
    if (txtContent !== null || !txtUrl) return;
    setTxtLoading(true);
    try {
      const resp = await fetch(txtUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      setTxtContent(text);
    } catch {
      setTxtContent("[Failed to load text content]");
    } finally {
      setTxtLoading(false);
    }
  }, [txtUrl, txtContent]);

  // Switch to TXT if PDF fails
  const handlePdfFail = useCallback(() => {
    if (txtUrl) {
      setPdfFailed(true);
      setMode("txt");
      loadTxt();
    }
  }, [txtUrl, loadTxt]);

  // Timeout for iframe load — if iframe doesn't load in 20s, fall back
  useEffect(() => {
    if (mode === "pdf" && canRenderInIframe) {
      iframeTimerRef.current = setTimeout(() => {
        handlePdfFail();
      }, 20000);
      return () => {
        if (iframeTimerRef.current) clearTimeout(iframeTimerRef.current);
      };
    }
  }, [mode, canRenderInIframe, handlePdfFail]);

  // If not renderable in iframe (RTF, BIN, etc.), go directly to TXT mode
  useEffect(() => {
    if (!canRenderInIframe && txtUrl) {
      setMode("txt");
      loadTxt();
    } else if (!canRenderInIframe && !txtUrl) {
      setMode("txt");
      setTxtContent("[No viewable content available for this file]");
    }
  }, [canRenderInIframe, txtUrl, loadTxt]);

  // Highlight in TXT view
  useEffect(() => {
    if (mode === "txt" && txtContent && highlightText && txtRef.current) {
      const timer = setTimeout(() => {
        if (txtRef.current) highlightAndScroll(txtRef.current, highlightText);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [mode, txtContent, highlightText]);

  const handleBackdrop = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === backdropRef.current) onClose();
    },
    [onClose],
  );

  return (
    <>
    <style>{`
      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    `}</style>
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(4px)" }}
      onClick={handleBackdrop}
    >
      <div
        className="w-full h-full max-w-[90vw] max-h-[92vh] flex flex-col overflow-hidden"
        style={{
          background: "linear-gradient(180deg, #0d0d12, #08080c)",
          borderRadius: 16,
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow:
            "0 24px 80px rgba(0,0,0,0.6), 0 0 1px rgba(255,255,255,0.1)",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 20px",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            background:
              "linear-gradient(180deg, rgba(20,20,28,0.8), transparent)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "linear-gradient(135deg, #818cf8, #6366f1)",
                boxShadow: "0 0 12px rgba(129,140,248,0.5)",
              }}
            />
            <div>
              <h2
                style={{
                  fontSize: 14,
                  fontWeight: 700,
                  color: "#e5e7eb",
                  letterSpacing: 0.3,
                }}
              >
                {title}
              </h2>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                style={{ fontSize: 11, color: "#6b7280" }}
              >
                {file}
              </span>
              {isRtf && (
                <span style={{
                  fontSize: 9, color: "#fbbf24",
                  background: "rgba(251,191,36,0.1)",
                  border: "1px solid rgba(251,191,36,0.2)",
                  padding: "1px 6px", borderRadius: 4, fontWeight: 600,
                }}>RTF</span>
              )}
              {(isRtf || !canRenderInIframe) && (
                <a
                  href={pdfUrl}
                  download={file}
                  style={{
                    fontSize: 10, color: "#818cf8",
                    textDecoration: "underline",
                    cursor: "pointer",
                  }}
                  title="Download original file"
                >
                  Download
                </a>
              )}
            </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* Mode toggle */}
            {canRenderInIframe && txtUrl && (
              <div
                style={{
                  display: "flex",
                  gap: 2,
                  padding: 2,
                  background: "rgba(255,255,255,0.04)",
                  borderRadius: 8,
                }}
              >
                <button
                  onClick={() => setMode("pdf")}
                  disabled={pdfFailed}
                  style={{
                    padding: "4px 12px",
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 600,
                    border: "none",
                    cursor: pdfFailed ? "not-allowed" : "pointer",
                    background:
                      mode === "pdf"
                        ? "rgba(129,140,248,0.2)"
                        : "transparent",
                    color:
                      mode === "pdf"
                        ? "#e0e7ff"
                        : pdfFailed
                          ? "#4b5563"
                          : "#9ca3af",
                    transition: "all 0.2s",
                  }}
                >
                  PDF
                </button>
                <button
                  onClick={() => {
                    setMode("txt");
                    loadTxt();
                  }}
                  style={{
                    padding: "4px 12px",
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 600,
                    border: "none",
                    cursor: "pointer",
                    background:
                      mode === "txt"
                        ? "rgba(129,140,248,0.2)"
                        : "transparent",
                    color: mode === "txt" ? "#e0e7ff" : "#9ca3af",
                    transition: "all 0.2s",
                  }}
                >
                  Text
                </button>
              </div>
            )}

            {/* PACS Viewer section */}
            {hasPacs && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {/* Refresh / Open PACS */}
                <button
                  onClick={handleOpenPacs}
                  disabled={pacsLoading}
                  style={{
                    padding: "4px 12px",
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 600,
                    border: "1px solid rgba(96,165,250,0.3)",
                    cursor: pacsLoading ? "wait" : "pointer",
                    background: "rgba(96,165,250,0.1)",
                    color: "#93c5fd",
                    transition: "all 0.2s",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                  title={`Open in PACS viewer (Acc: ${accessionNumber})`}
                >
                  {pacsLoading ? (
                    <>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: "spin 1s linear infinite" }}>
                        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                      </svg>
                      Opening...
                    </>
                  ) : "Open in PACS"}
                </button>

                {/* Expiry indicator */}
                {pacsLinkReady && (
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <div
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: pacsLinkAge < PACS_EXPIRY_SECONDS * 0.5
                          ? "#34d399"
                          : pacsLinkAge < PACS_EXPIRY_SECONDS
                            ? "#fbbf24"
                            : "#ef4444",
                        boxShadow: pacsLinkAge < PACS_EXPIRY_SECONDS * 0.5
                          ? "0 0 6px rgba(52,211,153,0.5)"
                          : pacsLinkAge < PACS_EXPIRY_SECONDS
                            ? "0 0 6px rgba(251,191,36,0.5)"
                            : "0 0 6px rgba(239,68,68,0.5)",
                        transition: "all 0.3s",
                      }}
                    />
                    <span style={{
                      fontSize: 9,
                      color: pacsLinkAge < PACS_EXPIRY_SECONDS ? "#6b7280" : "#ef4444",
                      fontFamily: "monospace",
                    }}>
                      {pacsLinkAge < 60
                        ? `${pacsLinkAge}s`
                        : `${Math.floor(pacsLinkAge / 60)}m${pacsLinkAge % 60}s`}
                    </span>
                    {pacsLinkAge >= PACS_EXPIRY_SECONDS && (
                      <button
                        onClick={handleRefreshPacs}
                        disabled={pacsRefreshing}
                        style={{
                          padding: "2px 6px",
                          borderRadius: 4,
                          fontSize: 9,
                          fontWeight: 600,
                          border: "1px solid rgba(239,68,68,0.3)",
                          cursor: pacsRefreshing ? "wait" : "pointer",
                          background: "rgba(239,68,68,0.1)",
                          color: "#fca5a5",
                          transition: "all 0.2s",
                          display: "flex",
                          alignItems: "center",
                          gap: 3,
                        }}
                        title="Link expired — click to refresh"
                      >
                        {pacsRefreshing ? (
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: "spin 1s linear infinite" }}>
                            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                          </svg>
                        ) : (
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M1 4v6h6" />
                            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                          </svg>
                        )}
                        Refresh
                      </button>
                    )}
                  </div>
                )}

                {/* Accession number badge */}
                <span style={{ fontSize: 9, color: "#6b7280", fontFamily: "monospace" }}>
                  Acc: {accessionNumber}
                </span>
              </div>
            )}

            {/* Close */}
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
                (e.currentTarget as HTMLButtonElement).style.background =
                  "rgba(255,255,255,0.06)";
                (e.currentTarget as HTMLButtonElement).style.color = "#e5e7eb";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "transparent";
                (e.currentTarget as HTMLButtonElement).style.color = "#6b7280";
              }}
              aria-label="Close report viewer"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Search highlight banner for PDF mode */}
        {mode === "pdf" && highlightText && (
          <div
            style={{
              padding: "8px 20px",
              background: "rgba(251,191,36,0.08)",
              borderBottom: "1px solid rgba(251,191,36,0.15)",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#fbbf24"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <span style={{ fontSize: 12, color: "#fcd34d" }}>
              Search for: &quot;{highlightText}&quot;
            </span>
            <button
              onClick={() => {
                setMode("txt");
                loadTxt();
              }}
              style={{
                marginLeft: "auto",
                fontSize: 11,
                color: "#818cf8",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              Switch to Text view for highlighting
            </button>
          </div>
        )}

        {/* Content */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {mode === "pdf" && canRenderInIframe && (
            <iframe
              src={pdfUrl}
              title={title}
              style={{
                width: "100%",
                height: "100%",
                border: "none",
                background: "#1a1a1e",
              }}
              onLoad={() => {
                if (iframeTimerRef.current)
                  clearTimeout(iframeTimerRef.current);
              }}
              onError={handlePdfFail}
            />
          )}
          {mode === "txt" && (
            <div
              style={{
                width: "100%",
                height: "100%",
                overflow: "auto",
                padding: "20px 24px",
              }}
            >
              {txtLoading && (
                <div
                  style={{
                    color: "#6b7280",
                    fontSize: 13,
                    textAlign: "center",
                    padding: 40,
                  }}
                >
                  Loading text content...
                </div>
              )}
              {!txtLoading && txtContent && (
                <pre
                  ref={txtRef}
                  style={{
                    fontFamily:
                      "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
                    fontSize: 12,
                    lineHeight: 1.7,
                    color: "#d1d5db",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    margin: 0,
                  }}
                >
                  {txtContent}
                </pre>
              )}
              {!txtLoading && !txtContent && !txtUrl && (
                <div
                  style={{
                    color: "#6b7280",
                    fontSize: 13,
                    textAlign: "center",
                    padding: 40,
                  }}
                >
                  No extracted text content available for this report. Use PDF view instead.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
    </>
  );
}
