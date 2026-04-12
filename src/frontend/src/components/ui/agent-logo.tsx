"use client";

import React from "react";
import { motion } from "framer-motion";

/**
 * Circular AI agent face — only facial features inside a glowing ring.
 * Clean, friendly profile avatar with no body/shoulders.
 */
export function AgentLogo({ size = 80 }: { size?: number }) {
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

      <svg
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="absolute inset-0 w-full h-full"
      >
        <defs>
          <clipPath id="agentCircle">
            <circle cx="50" cy="50" r="46" />
          </clipPath>
          <linearGradient id="agentBg" x1="50" y1="4" x2="50" y2="96" gradientUnits="userSpaceOnUse">
            <stop stopColor="#1e1b4b" />
            <stop offset="1" stopColor="#0f0a1e" />
          </linearGradient>
          <linearGradient id="skinGrad" x1="50" y1="15" x2="50" y2="85" gradientUnits="userSpaceOnUse">
            <stop stopColor="#c4b5fd" />
            <stop offset="1" stopColor="#8b5cf6" />
          </linearGradient>
        </defs>

        {/* Background circle */}
        <circle cx="50" cy="50" r="46" fill="url(#agentBg)" />

        <g clipPath="url(#agentCircle)">
          {/* Face — fills the circle */}
          <circle cx="50" cy="50" r="34" fill="url(#skinGrad)" />

          {/* Hair / top arc */}
          <path
            d="M18 44 Q22 18 50 14 Q78 18 82 44 Q78 30 50 26 Q22 30 18 44Z"
            fill="#312e81"
          />

          {/* Eyebrows — subtle arcs */}
          <path d="M34 38 Q38 35 44 37" stroke="#4338ca" strokeWidth="1.2" fill="none" strokeLinecap="round" />
          <path d="M56 37 Q62 35 66 38" stroke="#4338ca" strokeWidth="1.2" fill="none" strokeLinecap="round" />

          {/* Eyes — large, expressive */}
          <ellipse cx="40" cy="46" rx="5.5" ry="6" fill="#e0e7ff" />
          <ellipse cx="60" cy="46" rx="5.5" ry="6" fill="#e0e7ff" />
          {/* Irises */}
          <circle cx="41.5" cy="46" r="3.5" fill="#1e1b4b" />
          <circle cx="61.5" cy="46" r="3.5" fill="#1e1b4b" />
          {/* Catch-lights */}
          <circle cx="43" cy="44" r="1.2" fill="white" opacity="0.9" />
          <circle cx="63" cy="44" r="1.2" fill="white" opacity="0.9" />
          <circle cx="40" cy="47.5" r="0.6" fill="white" opacity="0.4" />
          <circle cx="60" cy="47.5" r="0.6" fill="white" opacity="0.4" />

          {/* Nose — minimal hint */}
          <path d="M48 52 Q50 55 52 52" stroke="#a78bfa" strokeWidth="0.8" fill="none" opacity="0.5" />

          {/* Friendly smile */}
          <path
            d="M40 58 Q50 66 60 58"
            stroke="#e0e7ff"
            strokeWidth="1.8"
            strokeLinecap="round"
            fill="none"
          />

          {/* Subtle blush */}
          <circle cx="32" cy="54" r="4" fill="#a78bfa" opacity="0.15" />
          <circle cx="68" cy="54" r="4" fill="#a78bfa" opacity="0.15" />
        </g>

        {/* Border ring */}
        <circle cx="50" cy="50" r="46" stroke="#6366f1" strokeWidth="1.5" fill="none" opacity="0.4" />
      </svg>

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
