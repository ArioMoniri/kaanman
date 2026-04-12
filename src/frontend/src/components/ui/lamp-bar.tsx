"use client";

import React from "react";
import { motion, AnimatePresence } from "framer-motion";

/**
 * Thin glowing accent line below the header.
 * Subtle purple gradient with a traveling spark animation.
 */
export function LampBar({ visible }: { visible: boolean }) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.3 } }}
          className="relative w-full h-[3px] overflow-hidden"
        >
          {/* Base gradient line */}
          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(90deg, transparent 0%, #6366f1 20%, #a78bfa 50%, #6366f1 80%, transparent 100%)",
            }}
          />

          {/* Soft glow beneath */}
          <div
            className="absolute inset-0 blur-sm"
            style={{
              background:
                "linear-gradient(90deg, transparent 10%, #7c3aed 30%, #818cf8 50%, #7c3aed 70%, transparent 90%)",
              opacity: 0.6,
            }}
          />

          {/* Traveling spark */}
          <motion.div
            animate={{ x: ["-100%", "200%"] }}
            transition={{
              duration: 3,
              repeat: Infinity,
              ease: "linear",
              repeatDelay: 2,
            }}
            className="absolute top-0 w-16 h-full"
            style={{
              background:
                "linear-gradient(90deg, transparent, rgba(255,255,255,0.6), transparent)",
            }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
