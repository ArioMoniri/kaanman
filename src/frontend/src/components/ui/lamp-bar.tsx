"use client";

import React from "react";
import { motion, AnimatePresence } from "framer-motion";

/**
 * Aceternity-style lamp bar — conic gradient light cones meeting at center
 * with a glowing line and bloom effect. Compact form factor for header use.
 */
export function LampBar({ visible }: { visible: boolean }) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.3 } }}
          className="relative w-full h-8 overflow-hidden"
        >
          {/* Dark background base */}
          <div className="absolute inset-0 bg-[#131316]" />

          {/* Left conic gradient cone */}
          <motion.div
            initial={{ opacity: 0.5, width: "30%" }}
            animate={{ opacity: 1, width: "50%" }}
            transition={{ delay: 0.2, duration: 0.8, ease: "easeInOut" }}
            style={{
              backgroundImage:
                "conic-gradient(from 70deg at center top, #7c3aed, transparent, transparent)",
            }}
            className="absolute inset-auto right-1/2 h-full overflow-visible"
          >
            <div className="absolute w-full left-0 bg-[#131316] h-3 bottom-0 z-20 [mask-image:linear-gradient(to_top,white,transparent)]" />
            <div className="absolute w-8 h-full left-0 bg-[#131316] bottom-0 z-20 [mask-image:linear-gradient(to_right,white,transparent)]" />
          </motion.div>

          {/* Right conic gradient cone */}
          <motion.div
            initial={{ opacity: 0.5, width: "30%" }}
            animate={{ opacity: 1, width: "50%" }}
            transition={{ delay: 0.2, duration: 0.8, ease: "easeInOut" }}
            style={{
              backgroundImage:
                "conic-gradient(from 290deg at center top, transparent, transparent, #7c3aed)",
            }}
            className="absolute inset-auto left-1/2 h-full overflow-visible"
          >
            <div className="absolute w-8 h-full right-0 bg-[#131316] bottom-0 z-20 [mask-image:linear-gradient(to_left,white,transparent)]" />
            <div className="absolute w-full right-0 bg-[#131316] h-3 bottom-0 z-20 [mask-image:linear-gradient(to_top,white,transparent)]" />
          </motion.div>

          {/* Top cover to darken the upper portion */}
          <div className="absolute top-0 h-4 w-full bg-[#131316] z-30" />

          {/* Center blur glow — the "lamp" bloom */}
          <motion.div
            animate={{
              opacity: [0.4, 0.7, 0.5, 0.8, 0.4],
            }}
            transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
            className="absolute z-40 h-6 w-48 left-1/2 -translate-x-1/2 bottom-0 rounded-full bg-purple-500 opacity-50 blur-2xl"
          />

          {/* Inner glow orb */}
          <motion.div
            animate={{
              opacity: [0.3, 0.6, 0.4, 0.7, 0.3],
              scale: [0.9, 1.1, 0.95, 1.05, 0.9],
            }}
            transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
            className="absolute z-30 h-5 w-32 left-1/2 -translate-x-1/2 bottom-0 rounded-full bg-violet-400 blur-xl"
          />

          {/* Bright center line — the sharp lamp edge */}
          <motion.div
            initial={{ width: "20%" }}
            animate={{ width: "50%" }}
            transition={{ delay: 0.2, duration: 0.8, ease: "easeInOut" }}
            className="absolute z-50 h-[1.5px] left-1/2 -translate-x-1/2 bottom-[6px] bg-violet-400"
          />

          {/* Flickering spark traveling along the line */}
          <motion.div
            animate={{
              x: ["-120%", "120%"],
              opacity: [0, 1, 1, 0],
            }}
            transition={{
              duration: 2.5,
              repeat: Infinity,
              ease: "linear",
              repeatDelay: 3,
            }}
            className="absolute z-50 w-12 h-[1.5px] left-1/2 -translate-x-1/2 bottom-[6px] bg-gradient-to-r from-transparent via-white to-transparent"
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
