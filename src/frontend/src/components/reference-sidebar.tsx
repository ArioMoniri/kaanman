"use client";

import React, { useState, useEffect, useCallback } from "react";

interface Citation {
  index: number;
  title: string;
  source: string;
  country: string;
  year?: number;
  url?: string;
  quote: string;
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

/** Embedded browser with iframe load-error detection */
function EmbeddedBrowser({ url, title, onCopy, onShare, copied }: {
  url: string; title: string; onCopy: () => void; onShare: () => void; copied: boolean;
}) {
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const iframeRef = React.useRef<HTMLIFrameElement>(null);

  // Reset state when URL changes — check for known-blocked domains immediately
  useEffect(() => {
    if (isBlockedDomain(url)) {
      setLoadFailed(true);
      setLoading(false);
    } else {
      setLoadFailed(false);
      setLoading(true);
    }
  }, [url]);

  // Timeout: if iframe hasn't signalled load in 5s, assume blocked
  useEffect(() => {
    if (isBlockedDomain(url)) return;
    setLoading(true);
    const timer = setTimeout(() => {
      // If still loading after 5s, the site likely blocked framing
      setLoading(false);
      setLoadFailed(true);
    }, 5000);
    return () => clearTimeout(timer);
  }, [url]);

  const handleIframeLoad = useCallback(() => {
    // iframe fired load — could still be blocked (some browsers fire load anyway)
    // but at least something happened, give it the benefit of the doubt
    setLoading(false);
  }, []);

  const handleIframeError = useCallback(() => {
    setLoadFailed(true);
    setLoading(false);
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-surface border-b border-border/20">
        <span className="text-[10px] text-gray-400 truncate flex-1">{url}</span>
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

      {loadFailed ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <div className="w-12 h-12 rounded-full bg-surface flex items-center justify-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
            </svg>
          </div>
          <div>
            <p className="text-sm text-gray-300 font-medium">This site cannot be embedded</p>
            <p className="text-xs text-gray-500 mt-1">The website blocked inline preview (X-Frame-Options)</p>
          </div>
          <a href={url} target="_blank" rel="noopener noreferrer" className="px-4 py-2 rounded-lg bg-accent/90 hover:bg-accent text-white text-sm font-medium transition-colors">
            Open in new tab &nearr;
          </a>
          <p className="text-[10px] text-gray-600 mt-1">{title}</p>
        </div>
      ) : (
        <div className="flex-1 relative">
          {loading && (
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
    })),
    ...guidelines.filter((g) => g.url).map((g) => ({
      url: g.url!, label: g.source, title: g.title,
      country: g.country, year: g.year,
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
            <div className="flex items-center gap-1.5">
              <span className="px-1 py-0 rounded bg-accent/10 text-accent/70 text-[9px] font-semibold shrink-0">
                {COUNTRY_LABELS[ref.country] || ref.country}
              </span>
              <span className="text-[11px] text-gray-300 font-medium truncate">
                {ref.label}
              </span>
              {ref.year && (
                <span className="text-[10px] text-gray-500 shrink-0">{ref.year}</span>
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
