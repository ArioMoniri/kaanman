"use client";

import React from "react";
import { motion } from "framer-motion";

/** Minimalist humanoid agent avatar — friendly, clean, dark-theme */
export function AgentLogo({ size = 80 }: { size?: number }) {
  const s = size;
  return (
    <motion.div
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      style={{ width: s, height: s }}
      className="relative"
    >
      <svg
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full drop-shadow-lg"
      >
        {/* Head circle with gradient */}
        <defs>
          <linearGradient id="agentHead" x1="50" y1="10" x2="50" y2="65" gradientUnits="userSpaceOnUse">
            <stop stopColor="#818CF8" />
            <stop offset="1" stopColor="#4338CA" />
          </linearGradient>
          <linearGradient id="agentBody" x1="50" y1="60" x2="50" y2="95" gradientUnits="userSpaceOnUse">
            <stop stopColor="#6366F1" stopOpacity="0.8" />
            <stop offset="1" stopColor="#312E81" stopOpacity="0.6" />
          </linearGradient>
          <radialGradient id="agentGlow" cx="50" cy="50" r="50">
            <stop stopColor="#6366F1" stopOpacity="0.15" />
            <stop offset="1" stopColor="#6366F1" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Ambient glow */}
        <circle cx="50" cy="50" r="48" fill="url(#agentGlow)" />

        {/* Body/torso */}
        <path
          d="M30 85 C30 70 38 62 50 62 C62 62 70 70 70 85"
          fill="url(#agentBody)"
          stroke="#818CF8"
          strokeWidth="1.5"
          strokeLinecap="round"
        />

        {/* Head */}
        <circle cx="50" cy="38" r="22" fill="url(#agentHead)" stroke="#A5B4FC" strokeWidth="1.5" />

        {/* Eyes — friendly, slightly large */}
        <circle cx="42" cy="36" r="3" fill="#E0E7FF" />
        <circle cx="58" cy="36" r="3" fill="#E0E7FF" />

        {/* Eye pupils */}
        <circle cx="43" cy="36" r="1.5" fill="#1E1B4B" />
        <circle cx="59" cy="36" r="1.5" fill="#1E1B4B" />

        {/* Smile */}
        <path
          d="M43 45 Q50 50 57 45"
          stroke="#E0E7FF"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />

        {/* Antenna / neural link indicator */}
        <motion.circle
          cx="50"
          cy="13"
          r="3"
          fill="#A78BFA"
          animate={{ opacity: [0.4, 1, 0.4], scale: [0.9, 1.1, 0.9] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        />
        <line x1="50" y1="16" x2="50" y2="16" stroke="#A78BFA" strokeWidth="1.5" />
      </svg>
    </motion.div>
  );
}
