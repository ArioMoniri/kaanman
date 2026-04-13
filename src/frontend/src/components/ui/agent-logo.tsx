"use client";

import React, { useState, useEffect, useCallback } from "react";

/**
 * Generate a random seed string for DiceBear avatar.
 */
function randomSeed(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  const len = 6 + Math.floor(Math.random() * 8);
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

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

/*
 * Monochromatic color palettes — each entry is a base hue with
 * light/mid/dark tones. The glow cycles through these one-at-a-time.
 */
const MONO_PALETTES = [
  // Purple tones
  { light: "#c4b5fd", mid: "#8b5cf6", dark: "#6d28d9", glow: "#7c3aed" },
  // Blue tones
  { light: "#93c5fd", mid: "#3b82f6", dark: "#1d4ed8", glow: "#2563eb" },
  // Teal tones
  { light: "#5eead4", mid: "#14b8a6", dark: "#0d9488", glow: "#0f766e" },
  // Rose/Red tones
  { light: "#fda4af", mid: "#f43f5e", dark: "#be123c", glow: "#e11d48" },
  // Amber tones
  { light: "#fcd34d", mid: "#f59e0b", dark: "#d97706", glow: "#b45309" },
  // Pink tones
  { light: "#f9a8d4", mid: "#ec4899", dark: "#be185d", glow: "#db2777" },
  // Indigo tones
  { light: "#a5b4fc", mid: "#6366f1", dark: "#4338ca", glow: "#4f46e5" },
  // Emerald tones
  { light: "#6ee7b7", mid: "#10b981", dark: "#047857", glow: "#059669" },
];

const HOVER_PALETTE = { light: "#fbbf24", mid: "#f59e0b", dark: "#d97706", glow: "#b45309" };

/**
 * Link's profile avatar — DiceBear lorelei-neutral with random seed per session.
 * Irregular organic glow that cycles monochromatic palettes.
 */
export function AgentLogo({ size = 80 }: { size?: number }) {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [paletteIdx, setPaletteIdx] = useState(0);

  useEffect(() => {
    const seed = getOrCreateSeed();
    setAvatarUrl(buildAvatarUrl(seed));
  }, []);

  /* Cycle color palette every 3.5s */
  useEffect(() => {
    const timer = setInterval(() => {
      setPaletteIdx((i) => (i + 1) % MONO_PALETTES.length);
    }, 3500);
    return () => clearInterval(timer);
  }, []);

  const handleLoad = useCallback(() => setLoaded(true), []);

  const pal = hovered ? HOVER_PALETTE : MONO_PALETTES[paletteIdx];
  const spread = Math.round(size * 0.25); // wide glow spread
  const border = Math.max(3, Math.round(size * 0.045));
  const innerSize = size - border * 2;

  /* Unique ID for SVG filter per instance */
  const filterId = `glow-warp-${size}`;

  return (
    <div
      style={{ width: size + spread * 2, height: size + spread * 2, position: "relative" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* SVG filter for organic irregular distortion */}
      <svg width="0" height="0" style={{ position: "absolute" }}>
        <defs>
          <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.015"
              numOctaves="3"
              seed="5"
              result="noise"
            >
              <animate
                attributeName="baseFrequency"
                values="0.015;0.025;0.018;0.022;0.015"
                dur="8s"
                repeatCount="indefinite"
              />
            </feTurbulence>
            <feDisplacementMap
              in="SourceGraphic"
              in2="noise"
              scale={hovered ? 18 : 12}
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </defs>
      </svg>

      {/* Outer irregular glow blobs — 3 offset layers for organic shape */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          filter: `url(#${filterId})`,
          transition: "filter 0.5s ease",
        }}
      >
        {/* Blob 1 — large diffuse */}
        <div
          style={{
            position: "absolute",
            width: size + spread * 1.2,
            height: size + spread * 1.2,
            borderRadius: "50%",
            background: `radial-gradient(ellipse at 30% 40%, ${pal.light}90, ${pal.mid}50, transparent 70%)`,
            opacity: hovered ? 0.9 : 0.55,
            filter: `blur(${Math.round(size * 0.12)}px)`,
            transition: "all 0.6s ease, background 1.2s ease",
            animation: "blob-rotate 10s ease-in-out infinite",
          }}
        />
        {/* Blob 2 — mid offset */}
        <div
          style={{
            position: "absolute",
            width: size + spread * 0.8,
            height: size + spread * 1.0,
            borderRadius: "45% 55% 50% 50% / 55% 45% 55% 45%",
            background: `radial-gradient(ellipse at 70% 60%, ${pal.mid}80, ${pal.dark}40, transparent 70%)`,
            opacity: hovered ? 0.85 : 0.5,
            filter: `blur(${Math.round(size * 0.08)}px)`,
            transition: "all 0.6s ease, background 1.2s ease",
            animation: "blob-rotate 8s ease-in-out infinite reverse",
          }}
        />
        {/* Blob 3 — sharp accent */}
        <div
          style={{
            position: "absolute",
            width: size + spread * 0.5,
            height: size + spread * 0.6,
            borderRadius: "55% 45% 48% 52% / 45% 55% 45% 55%",
            background: `radial-gradient(ellipse at 50% 50%, ${pal.glow}70, ${pal.dark}30, transparent 65%)`,
            opacity: hovered ? 1 : 0.6,
            filter: `blur(${Math.round(size * 0.05)}px)`,
            transition: "all 0.6s ease, background 1.2s ease",
            animation: "blob-morph 7s ease-in-out infinite",
          }}
        />
      </div>

      {/* Solid border ring — monochromatic gradient */}
      <div
        style={{
          position: "absolute",
          left: spread,
          top: spread,
          width: size,
          height: size,
          borderRadius: "50%",
          background: `conic-gradient(from 0deg, ${pal.light}, ${pal.mid}, ${pal.dark}, ${pal.mid}, ${pal.light})`,
          transition: "background 1.2s ease, transform 0.3s ease",
          transform: hovered ? "scale(1.04)" : "scale(1)",
        }}
      />

      {/* Inner circle — clips the avatar */}
      <div
        style={{
          position: "absolute",
          left: spread + border,
          top: spread + border,
          width: innerSize,
          height: innerSize,
          borderRadius: "50%",
          overflow: "hidden",
          background: "#b6e3f4",
          zIndex: 2,
        }}
      >
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
          bottom: spread + Math.round(size * 0.02),
          right: spread + Math.round(size * 0.02),
          width: Math.max(8, Math.round(size * 0.16)),
          height: Math.max(8, Math.round(size * 0.16)),
          borderRadius: "50%",
          background: "#4ade80",
          border: "2px solid #131316",
          zIndex: 5,
          animation: "pulse-dot 2s ease-in-out infinite",
        }}
      />

      <style>{`
        @keyframes blob-rotate {
          0%, 100% { transform: rotate(0deg) scale(1); }
          25% { transform: rotate(5deg) scale(1.03); }
          50% { transform: rotate(-3deg) scale(0.97); }
          75% { transform: rotate(4deg) scale(1.02); }
        }
        @keyframes blob-morph {
          0%, 100% { border-radius: 55% 45% 48% 52% / 45% 55% 45% 55%; transform: rotate(0deg); }
          33% { border-radius: 48% 52% 55% 45% / 52% 48% 55% 45%; transform: rotate(4deg); }
          66% { border-radius: 52% 48% 45% 55% / 48% 52% 48% 52%; transform: rotate(-3deg); }
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
