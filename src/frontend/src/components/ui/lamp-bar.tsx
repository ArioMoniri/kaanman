"use client";

import React from "react";
import { motion, AnimatePresence } from "framer-motion";

export function LampBar({ visible }: { visible: boolean }) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.3 } }}
          className="relative w-full h-[2px] overflow-visible"
        >
          {/* Base glow line */}
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-purple-500/60 to-transparent" />

          {/* Animated flicker pulse */}
          <motion.div
            animate={{
              opacity: [0.3, 0.8, 0.5, 1, 0.4, 0.7, 0.3],
              scaleX: [0.8, 1.05, 0.95, 1.1, 0.9, 1, 0.8],
            }}
            transition={{
              duration: 4,
              repeat: Infinity,
              ease: "easeInOut",
            }}
            className="absolute inset-0 bg-gradient-to-r from-transparent via-purple-400 to-transparent"
          />

          {/* Soft bloom behind the line */}
          <motion.div
            animate={{
              opacity: [0.15, 0.35, 0.2, 0.4, 0.15],
            }}
            transition={{
              duration: 3,
              repeat: Infinity,
              ease: "easeInOut",
            }}
            className="absolute -top-3 left-[10%] right-[10%] h-8 bg-purple-500/30 blur-xl rounded-full"
          />

          {/* Moving highlight spark */}
          <motion.div
            animate={{
              x: ["-100%", "200%"],
              opacity: [0, 1, 1, 0],
            }}
            transition={{
              duration: 3,
              repeat: Infinity,
              ease: "linear",
              repeatDelay: 2,
            }}
            className="absolute top-0 w-16 h-[2px] bg-gradient-to-r from-transparent via-purple-300 to-transparent"
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
