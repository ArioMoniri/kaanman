"use client";

import React, { useState, useEffect, useCallback } from "react";

/**
 * Generate a random seed string for DiceBear avatar.
 * Each call produces a different face from the lorelei-neutral style.
 */
function randomSeed(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  const len = 6 + Math.floor(Math.random() * 8); // 6-13 chars
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** Session-stable seed key — same avatar within a browser tab, new one on refresh/new chat */
const SEED_KEY = "cerebralink_avatar_seed";

function getOrCreateSeed(): string {
  if (typeof window === "undefined") return "link";
  let seed = sessionStorage.getItem(SEED_KEY);
  if (!seed) {
    seed = randomSeed();
    sessionStorage.setItem(SEED_KEY, seed);
  }
  return seed;
}

function buildAvatarUrl(seed: string): string {
  return `https://api.dicebear.com/8.x/lorelei-neutral/svg?seed=${seed}&backgroundColor=b6e3f4&backgroundType=solid&scale=85`;
}

/* Glow gradient presets that rotate */
const GLOW_GRADIENTS = [
  "conic-gradient(from 0deg, #7c3aed, #6366f1, #818cf8, #a78bfa, #7c3aed)",
  "conic-gradient(from 90deg, #6366f1, #ec4899, #f59e0b, #10b981, #6366f1)",
  "conic-gradient(from 180deg, #3b82f6, #8b5cf6, #ec4899, #f97316, #3b82f6)",
  "conic-gradient(from 270deg, #14b8a6, #6366f1, #a855f7, #f43f5e, #14b8a6)",
];

const HOVER_GLOW = "conic-gradient(from 0deg, #f97316, #ec4899, #8b5cf6, #3b82f6, #10b981, #f97316)";

/**
 * Link's profile avatar — DiceBear lorelei-neutral with random seed per session.
 * Each new chat or page refresh generates a different face.
 * Features animated glow ring that cycles gradients and intensifies on hover.
 */
export function AgentLogo({ size = 80 }: { size?: number }) {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [glowIdx, setGlowIdx] = useState(0);

  useEffect(() => {
    const seed = getOrCreateSeed();
    setAvatarUrl(buildAvatarUrl(seed));
  }, []);

  /* Cycle glow gradient every 4s */
  useEffect(() => {
    const timer = setInterval(() => {
      setGlowIdx((i) => (i + 1) % GLOW_GRADIENTS.length);
    }, 4000);
    return () => clearInterval(timer);
  }, []);

  const handleLoad = useCallback(() => setLoaded(true), []);

  const border = Math.max(2, Math.round(size * 0.04));
  const innerSize = size - border * 2;
  const glowBg = hovered ? HOVER_GLOW : GLOW_GRADIENTS[glowIdx];

  return (
    <div
      style={{ width: size, height: size, position: "relative" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Glow ring — animated gradient border */}
      <div
        style={{
          position: "absolute",
          inset: -2,
          borderRadius: "50%",
          background: glowBg,
          opacity: hovered ? 1 : 0.6,
          filter: hovered ? `blur(${Math.round(size * 0.06)}px) brightness(1.3)` : `blur(${Math.round(size * 0.03)}px)`,
          transition: "all 0.5s ease, background 1s ease",
          animation: "spin-glow 6s linear infinite",
        }}
      />

      {/* Solid gradient ring */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          background: glowBg,
          transition: "background 1s ease",
          transform: hovered ? "scale(1.05)" : "scale(1)",
        }}
      />

      {/* Inner circle — clips the avatar */}
      <div
        style={{
          position: "absolute",
          top: border,
          left: border,
          width: innerSize,
          height: innerSize,
          borderRadius: "50%",
          overflow: "hidden",
          background: "#b6e3f4",
        }}
      >
        {/* Placeholder while loading */}
        {!loaded && (
          <div
            style={{
              width: "100%",
              height: "100%",
              background: "linear-gradient(135deg, #b6e3f4 0%, #c0aede 50%, #d1d4f9 100%)",
              animation: "shimmer-avatar 1.5s ease-in-out infinite",
            }}
          />
        )}

        {avatarUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt="Link"
            width={innerSize}
            height={innerSize}
            onLoad={handleLoad}
            style={{
              width: innerSize,
              height: innerSize,
              display: loaded ? "block" : "none",
              objectFit: "cover",
            }}
            draggable={false}
          />
        )}
      </div>

      {/* Status indicator dot */}
      <div
        style={{
          position: "absolute",
          bottom: Math.round(size * 0.02),
          right: Math.round(size * 0.02),
          width: Math.max(8, Math.round(size * 0.16)),
          height: Math.max(8, Math.round(size * 0.16)),
          borderRadius: "50%",
          background: "#4ade80",
          border: `2px solid #131316`,
          zIndex: 5,
          animation: "pulse-dot 2s ease-in-out infinite",
        }}
      />

      {/* Inject keyframes */}
      <style jsx>{`
        @keyframes spin-glow {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes pulse-dot {
          0%, 100% { transform: scale(1); opacity: 0.8; }
          50% { transform: scale(1.3); opacity: 1; }
        }
        @keyframes shimmer-avatar {
          0%, 100% { opacity: 0.6; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}

/** Reset the avatar seed — call this when starting a new chat session */
export function resetAvatarSeed(): void {
  if (typeof window !== "undefined") {
    sessionStorage.removeItem(SEED_KEY);
  }
}
