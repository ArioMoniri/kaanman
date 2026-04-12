"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

interface Citation {
  index: number;
  title: string;
  source: string;
  country: string;
  year?: number;
  url?: string;
  quote: string;
  importance?: "high" | "medium" | "low";
  effect_size?: "large" | "moderate" | "small" | "none";
  evidence_level?: string;
}

interface Guideline {
  title: string;
  source: string;
  country: string;
  year?: number;
  url?: string;
}

interface ReferenceSidebarProps {
  citations: Citation[];
  guidelines: Guideline[];
  onClose: () => void;
  initialUrl?: string;
  initialTitle?: string;
}

const COUNTRY_LABELS: Record<string, string> = {
  USA: "USA", UK: "UK", Europe: "EU", Turkey: "TR", WHO: "WHO",
};

/** Domains known to block iframe embedding via X-Frame-Options / CSP */
const BLOCKED_DOMAINS = [
  "ahajournals.org", "nejm.org", "thelancet.com", "bmj.com",
  "jamanetwork.com", "nature.com", "springer.com", "wiley.com",
  "elsevier.com", "sciencedirect.com", "academic.oup.com",
  "journals.lww.com", "pubmed.ncbi.nlm.nih.gov", "doi.org",
  "cochranelibrary.com", "uptodate.com", "medscape.com",
  "mayoclinic.org", "webmd.com", "nice.org.uk", "who.int",
  "acc.org", "escardio.org", "heart.org",
];

function isBlockedDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return BLOCKED_DOMAINS.some((d) => hostname === d || hostname.endsWith("." + d));
  } catch {
    return false;
  }
}

/** Reader-mode article data from backend proxy */
interface ReaderArticle {
  title: string;
  author: string | null;
  date: string | null;
  description: string | null;
  content: string;
  word_count: number;
  domain: string;
  url: string;
}

/** Embedded browser with iframe → reader-mode fallback */
function EmbeddedBrowser({ url, title, onCopy, onShare, copied }: {
  url: string; title: string; onCopy: () => void; onShare: () => void; copied: boolean;
}) {
  const [mode, setMode] = useState<"iframe" | "reader" | "loading-reader" | "error">("iframe");
  const [iframeLoading, setIframeLoading] = useState(true);
  const [article, setArticle] = useState<ReaderArticle | null>(null);
  const [readerError, setReaderError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const blockedRef = useRef(false);

  // Fetch article via reader proxy
  const fetchReader = useCallback(async (targetUrl: string) => {
    setMode("loading-reader");
    setReaderError(null);
    try {
      const resp = await fetch(`${API_URL}/api/reader?url=${encodeURIComponent(targetUrl)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data: ReaderArticle = await resp.json();
      if (data.word_count < 10) throw new Error("No readable content extracted");
      setArticle(data);
      setMode("reader");
    } catch (err) {
      setReaderError(err instanceof Error ? err.message : "Failed to load article");
      setMode("error");
    }
  }, []);

  // Reset on URL change — blocked domains go straight to reader
  useEffect(() => {
    blockedRef.current = isBlockedDomain(url);
    setArticle(null);
    setReaderError(null);
    if (blockedRef.current) {
      fetchReader(url);
    } else {
      setMode("iframe");
      setIframeLoading(true);
    }
  }, [url, fetchReader]);

  // Timeout: if iframe hasn't loaded in 5s, fall back to reader
  useEffect(() => {
    if (blockedRef.current || mode !== "iframe") return;
    const timer = setTimeout(() => {
      if (iframeLoading) {
        fetchReader(url);
      }
    }, 5000);
    return () => clearTimeout(timer);
  }, [url, mode, iframeLoading, fetchReader]);

  const handleIframeLoad = useCallback(() => {
    setIframeLoading(false);
  }, []);

  const handleIframeError = useCallback(() => {
    fetchReader(url);
  }, [url, fetchReader]);

  // Toolbar (shared across all modes)
  const toolbar = (
    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-surface border-b border-border/20">
      {mode === "reader" && (
        <span className="text-[9px] text-emerald-500/80 font-semibold bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 shrink-0">
          Reader
        </span>
      )}
      <span className="text-[10px] text-gray-400 truncate flex-1">{article?.domain || url}</span>
      <button onClick={onCopy} className="text-[10px] text-gray-500 hover:text-gray-300 shrink-0 px-1.5 py-0.5 rounded border border-border/30 hover:border-border/60 transition-all" title="Copy link">
        {copied ? "Copied!" : "Copy"}
      </button>
      <button onClick={onShare} className="text-[10px] text-gray-500 hover:text-gray-300 shrink-0 px-1.5 py-0.5 rounded border border-border/30 hover:border-border/60 transition-all" title="Share">
        Share
      </button>
      <a href={url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-accent/70 hover:text-accent shrink-0">
        Open &nearr;
      </a>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      {toolbar}

      {/* Reader mode */}
      {mode === "reader" && article && (
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <article className="max-w-none">
            <h1 className="text-lg font-bold text-gray-100 mb-2 leading-tight">{article.title}</h1>
            <div className="flex items-center gap-2 text-[11px] text-gray-500 mb-4 flex-wrap">
              {article.author && <span className="text-gray-400">{article.author}</span>}
              {article.date && <span>{article.date}</span>}
              <span className="text-gray-600">{article.domain}</span>
              <span className="text-gray-600">{article.word_count.toLocaleString()} words</span>
            </div>
            {article.description && (
              <p className="text-sm text-gray-400 italic mb-4 pb-3 border-b border-border/20">{article.description}</p>
            )}
            <div
              className="reader-content text-sm text-gray-300 leading-relaxed space-y-3"
              dangerouslySetInnerHTML={{ __html: article.content }}
            />
          </article>
          <style jsx global>{`
            .reader-content h1 { font-size: 1.25rem; font-weight: 700; color: #e5e7eb; margin-top: 1.5rem; margin-bottom: 0.5rem; }
            .reader-content h2 { font-size: 1.1rem; font-weight: 700; color: #e5e7eb; margin-top: 1.25rem; margin-bottom: 0.5rem; }
            .reader-content h3 { font-size: 1rem; font-weight: 600; color: #d1d5db; margin-top: 1rem; margin-bottom: 0.25rem; }
            .reader-content h4, .reader-content h5, .reader-content h6 { font-size: 0.9rem; font-weight: 600; color: #d1d5db; margin-top: 0.75rem; }
            .reader-content p { margin-bottom: 0.5rem; }
            .reader-content ul, .reader-content ol { padding-left: 1.25rem; margin-bottom: 0.5rem; }
            .reader-content li { margin-bottom: 0.25rem; }
            .reader-content blockquote { border-left: 3px solid rgba(139,92,246,0.4); padding-left: 0.75rem; color: #9ca3af; font-style: italic; margin: 0.5rem 0; }
            .reader-content table { width: 100%; border-collapse: collapse; margin: 0.5rem 0; font-size: 0.8rem; }
            .reader-content th, .reader-content td { border: 1px solid rgba(255,255,255,0.08); padding: 4px 8px; text-align: left; }
            .reader-content th { background: rgba(255,255,255,0.04); font-weight: 600; }
            .reader-content pre { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 8px 12px; overflow-x: auto; font-size: 0.8rem; }
          `}</style>
        </div>
      )}

      {/* Loading reader */}
      {mode === "loading-reader" && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <div className="w-5 h-5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
          <span className="text-xs text-gray-500">Extracting article content...</span>
          <span className="text-[10px] text-gray-600">Reader mode for blocked sites</span>
        </div>
      )}

      {/* Error state */}
      {mode === "error" && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <div className="w-12 h-12 rounded-full bg-surface flex items-center justify-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
            </svg>
          </div>
          <div>
            <p className="text-sm text-gray-300 font-medium">Could not load article</p>
            <p className="text-xs text-gray-500 mt-1">{readerError || "Content extraction failed"}</p>
          </div>
          <a href={url} target="_blank" rel="noopener noreferrer" className="px-4 py-2 rounded-lg bg-accent/90 hover:bg-accent text-white text-sm font-medium transition-colors">
            Open in new tab &nearr;
          </a>
        </div>
      )}

      {/* Iframe mode */}
      {mode === "iframe" && (
        <div className="flex-1 relative">
          {iframeLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#131316] z-10">
              <div className="flex flex-col items-center gap-2">
                <div className="w-5 h-5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
                <span className="text-xs text-gray-500">Loading preview...</span>
              </div>
            </div>
          )}
          <iframe
            ref={iframeRef}
            src={url}
            className="w-full h-full border-none bg-white"
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-top-navigation-by-user-activation"
            title={title}
            onLoad={handleIframeLoad}
            onError={handleIframeError}
          />
        </div>
      )}
    </div>
  );
}

export function ReferenceSidebar({ citations, guidelines, onClose, initialUrl, initialTitle }: ReferenceSidebarProps) {
  const [activeUrl, setActiveUrl] = useState<string | null>(initialUrl || null);
  const [activeTitle, setActiveTitle] = useState(initialTitle || "");
  const [copied, setCopied] = useState(false);

  // Sync with external URL requests
  useEffect(() => {
    if (initialUrl) {
      setActiveUrl(initialUrl);
      setActiveTitle(initialTitle || "");
    }
  }, [initialUrl, initialTitle]);

  const handleCopyLink = async () => {
    if (!activeUrl) return;
    try {
      await navigator.clipboard.writeText(activeUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
      const input = document.createElement("input");
      input.value = activeUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleShare = async () => {
    if (!activeUrl) return;
    if (navigator.share) {
      try {
        await navigator.share({ title: activeTitle, url: activeUrl });
      } catch {
        // user cancelled
      }
    } else {
      handleCopyLink();
    }
  };

  // Collect all unique URLs
  const allRefs = [
    ...citations.filter((c) => c.url).map((c) => ({
      url: c.url!, label: `[${c.index}] ${c.source}`, title: c.title,
      country: c.country, year: c.year,
      importance: c.importance, effect_size: c.effect_size, evidence_level: c.evidence_level,
    })),
    ...guidelines.filter((g) => g.url).map((g) => ({
      url: g.url!, label: g.source, title: g.title,
      country: g.country, year: g.year,
      importance: undefined as "high" | "medium" | "low" | undefined,
      effect_size: undefined as "large" | "moderate" | "small" | "none" | undefined,
      evidence_level: undefined as string | undefined,
    })),
  ];

  // Dedupe by URL
  const seen = new Set<string>();
  const uniqueRefs = allRefs.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  return (
    <div className="flex flex-col h-full bg-[#131316] border-l border-border/30">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/30">
        <h3 className="text-sm font-semibold text-gray-200">References</h3>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-300 text-lg leading-none px-1"
        >
          &times;
        </button>
      </div>

      {/* Reference list */}
      <div className="flex-shrink-0 max-h-[200px] overflow-y-auto border-b border-border/30">
        {uniqueRefs.length === 0 && (
          <p className="px-3 py-4 text-xs text-gray-500 text-center">
            No linkable references available
          </p>
        )}
        {uniqueRefs.map((ref, i) => (
          <button
            key={i}
            onClick={() => {
              setActiveUrl(ref.url);
              setActiveTitle(ref.title);
            }}
            className={`w-full text-left px-3 py-2 border-b border-border/10 hover:bg-surface-light transition-colors ${
              activeUrl === ref.url ? "bg-surface-light border-l-2 border-l-accent" : ""
            }`}
          >
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="px-1 py-0 rounded bg-accent/10 text-accent/70 text-[9px] font-semibold shrink-0">
                {COUNTRY_LABELS[ref.country] || ref.country}
              </span>
              <span className="text-[11px] text-gray-300 font-medium truncate">
                {ref.label}
              </span>
              {ref.year && (
                <span className="text-[10px] text-gray-500 shrink-0">{ref.year}</span>
              )}
              {ref.importance && (
                <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ${
                  ref.importance === "high" ? "bg-green-500/15 text-green-400 border border-green-500/30" :
                  ref.importance === "medium" ? "bg-blue-500/15 text-blue-400 border border-blue-500/30" :
                  "bg-gray-500/15 text-gray-400 border border-gray-500/30"
                }`}>
                  {ref.importance === "high" ? "High impact" : ref.importance === "medium" ? "Moderate" : "Low"}
                </span>
              )}
              {ref.effect_size && ref.effect_size !== "none" && (
                <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ${
                  ref.effect_size === "large" ? "bg-green-500/15 text-green-400 border border-green-500/30" :
                  ref.effect_size === "moderate" ? "bg-blue-500/15 text-blue-400 border border-blue-500/30" :
                  "bg-purple-500/15 text-purple-400 border border-purple-500/30"
                }`}>
                  {ref.effect_size} effect
                </span>
              )}
              {ref.evidence_level && (
                <span className="text-[8px] text-gray-500 font-medium bg-surface/80 px-1.5 py-0.5 rounded shrink-0">
                  {ref.evidence_level}
                </span>
              )}
            </div>
            <p className="text-[10px] text-gray-500 mt-0.5 truncate">{ref.title}</p>
          </button>
        ))}
      </div>

      {/* Embedded browser view */}
      <div className="flex-1 min-h-0">
        {activeUrl ? (
          <EmbeddedBrowser url={activeUrl} title={activeTitle} onCopy={handleCopyLink} onShare={handleShare} copied={copied} />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-600 text-xs">
            Click a reference to preview
          </div>
        )}
      </div>
    </div>
  );
}
