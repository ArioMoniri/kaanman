"use client";

import React, { useState, useEffect } from "react";
import { motion } from "framer-motion";

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

/**
 * Link's profile avatar — DiceBear lorelei-neutral with random seed per session.
 * Each new chat or page refresh generates a different face.
 */
export function AgentLogo({ size = 80 }: { size?: number }) {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  useEffect(() => {
    const seed = getOrCreateSeed();
    setAvatarUrl(`https://api.dicebear.com/8.x/lorelei-neutral/svg?seed=${seed}`);
  }, []);

  return (
    <motion.div
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      style={{ width: size, height: size }}
      className="relative"
    >
      {/* Outer glow ring */}
      <motion.div
        animate={{ opacity: [0.4, 0.7, 0.4] }}
        transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
        className="absolute inset-0 rounded-full"
        style={{
          background:
            "conic-gradient(from 0deg, #7c3aed, #6366f1, #818cf8, #a78bfa, #7c3aed)",
          padding: 2,
        }}
      >
        <div className="w-full h-full rounded-full bg-[#131316]" />
      </motion.div>

      {/* Avatar image — rendered via <img> with external DiceBear SVG */}
      {avatarUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt="Link"
          width={size}
          height={size}
          className="absolute inset-0 rounded-full"
          style={{
            width: size,
            height: size,
            padding: 3,
            background: "linear-gradient(180deg, #1e1b4b, #0f0a1e)",
            borderRadius: "50%",
            objectFit: "cover",
          }}
          draggable={false}
        />
      )}

      {/* Status indicator dot */}
      <motion.div
        animate={{ scale: [1, 1.3, 1], opacity: [0.7, 1, 0.7] }}
        transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-green-400 border-2 border-[#131316] z-10"
        style={{ width: size * 0.15, height: size * 0.15 }}
      />
    </motion.div>
  );
}

/** Reset the avatar seed — call this when starting a new chat session */
export function resetAvatarSeed(): void {
  if (typeof window !== "undefined") {
    sessionStorage.removeItem(SEED_KEY);
  }
}
