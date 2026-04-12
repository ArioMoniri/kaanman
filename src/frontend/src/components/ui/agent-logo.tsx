"use client";

import React from "react";
import { motion } from "framer-motion";

/**
 * Circular humanoid AI agent profile picture.
 * Clean, friendly face with glowing accent ring — like a profile avatar.
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
        {/* Circle clip background */}
        <defs>
          <clipPath id="agentCircle">
            <circle cx="50" cy="50" r="46" />
          </clipPath>
          <linearGradient id="agentBg" x1="50" y1="4" x2="50" y2="96" gradientUnits="userSpaceOnUse">
            <stop stopColor="#1e1b4b" />
            <stop offset="1" stopColor="#0f0a1e" />
          </linearGradient>
          <linearGradient id="skinGrad" x1="50" y1="20" x2="50" y2="70" gradientUnits="userSpaceOnUse">
            <stop stopColor="#c4b5fd" />
            <stop offset="1" stopColor="#8b5cf6" />
          </linearGradient>
          <linearGradient id="bodyGrad" x1="50" y1="62" x2="50" y2="96" gradientUnits="userSpaceOnUse">
            <stop stopColor="#4338ca" />
            <stop offset="1" stopColor="#1e1b4b" />
          </linearGradient>
        </defs>

        {/* Background circle */}
        <circle cx="50" cy="50" r="46" fill="url(#agentBg)" />

        <g clipPath="url(#agentCircle)">
          {/* Body/shoulders */}
          <ellipse cx="50" cy="90" rx="30" ry="22" fill="url(#bodyGrad)" />
          {/* Collar accent line */}
          <path d="M32 76 Q50 82 68 76" stroke="#6366f1" strokeWidth="1" fill="none" opacity="0.6" />

          {/* Head */}
          <circle cx="50" cy="42" r="20" fill="url(#skinGrad)" />

          {/* Hair/top */}
          <path
            d="M30 38 Q32 22 50 20 Q68 22 70 38 Q68 30 50 28 Q32 30 30 38Z"
            fill="#312e81"
          />

          {/* Eyes — expressive, slightly large */}
          <ellipse cx="42" cy="42" rx="4" ry="4.5" fill="#e0e7ff" />
          <ellipse cx="58" cy="42" rx="4" ry="4.5" fill="#e0e7ff" />
          {/* Pupils with catch-light */}
          <circle cx="43.5" cy="42" r="2.5" fill="#1e1b4b" />
          <circle cx="59.5" cy="42" r="2.5" fill="#1e1b4b" />
          <circle cx="44.5" cy="40.5" r="0.8" fill="white" opacity="0.9" />
          <circle cx="60.5" cy="40.5" r="0.8" fill="white" opacity="0.9" />

          {/* Friendly smile */}
          <path
            d="M44 50 Q50 55 56 50"
            stroke="#e0e7ff"
            strokeWidth="1.5"
            strokeLinecap="round"
            fill="none"
          />

          {/* Subtle blush marks */}
          <circle cx="37" cy="47" r="3" fill="#a78bfa" opacity="0.2" />
          <circle cx="63" cy="47" r="3" fill="#a78bfa" opacity="0.2" />
        </g>

        {/* Border ring */}
        <circle cx="50" cy="50" r="46" stroke="#6366f1" strokeWidth="1.5" fill="none" opacity="0.4" />
      </svg>

      {/* Status indicator dot — pulsing */}
      <motion.div
        animate={{ scale: [1, 1.3, 1], opacity: [0.7, 1, 0.7] }}
        transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-green-400 border-2 border-[#131316] z-10"
        style={{ width: size * 0.15, height: size * 0.15 }}
      />
    </motion.div>
  );
}
