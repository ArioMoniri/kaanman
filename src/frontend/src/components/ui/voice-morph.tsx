"use client";

import { useEffect, useRef, useCallback } from "react";
import { animate, svg, utils } from "animejs";

interface VoiceMorphProps {
  /** Audio level 0-1 from microphone analyser */
  audioLevel: number;
  /** Whether the mic is actively listening */
  isActive: boolean;
  className?: string;
}

/**
 * Animated morphing shape that responds to voice volume.
 * Higher audio level → more vertices, larger radius, faster morph.
 * Idle → gentle slow morph. Speaking loudly → spiky fast morph.
 */
export function VoiceMorph({ audioLevel, isActive, className }: VoiceMorphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const path1Ref = useRef<SVGPolygonElement>(null);
  const path2Ref = useRef<SVGPolygonElement>(null);
  const animFrameRef = useRef<number>(0);
  const levelRef = useRef(0);

  // Keep level ref in sync without re-triggering effect
  useEffect(() => {
    levelRef.current = audioLevel;
  }, [audioLevel]);

  const generatePoints = useCallback(() => {
    const level = levelRef.current;
    // More points when louder (4-6 idle, up to 48 loud)
    const total = Math.max(4, Math.round(utils.random(4, 8) + level * 40));
    // Inner radius shrinks when loud → more spiky
    const r1 = Math.max(4, Math.round(56 - level * 44));
    const r2 = 56;
    const isOdd = (n: number): boolean => n % 2 === 1;
    const count = isOdd(total) ? total + 1 : total;
    let points = "";

    for (let i = 0; i < count; i++) {
      // Add slight random jitter proportional to volume
      const jitter = level * utils.random(-6, 6);
      const r = (isOdd(i) ? r1 : r2) + jitter;
      const a = (2 * Math.PI * i) / count - Math.PI / 2;
      const x = 152 + utils.round(r * Math.cos(a), 0);
      const y = 56 + utils.round(r * Math.sin(a), 0);
      points += `${x},${y} `;
    }
    return points;
  }, []);

  useEffect(() => {
    if (!isActive || !svgRef.current || !path1Ref.current || !path2Ref.current) return;

    const $path1 = path1Ref.current;
    const $path2 = path2Ref.current;
    let cancelled = false;

    function animateLoop() {
      if (cancelled) return;
      const level = levelRef.current;
      const newPoints = generatePoints();
      $path2.setAttribute("points", newPoints);

      // Duration: fast when loud (150ms), slow when quiet (600ms)
      const duration = Math.max(150, 600 - level * 450);

      animate($path1, {
        points: svg.morphTo($path2),
        ease: "inOutCirc",
        duration,
        onComplete: () => {
          if (!cancelled) animateLoop();
        },
      });
    }

    animateLoop();

    return () => {
      cancelled = true;
    };
  }, [isActive, generatePoints]);

  if (!isActive) return null;

  // Color intensity based on volume
  const glowOpacity = 0.3 + audioLevel * 0.5;
  const strokeColor = audioLevel > 0.5
    ? `rgba(239, 68, 68, ${0.6 + audioLevel * 0.4})`   // red when loud
    : `rgba(168, 85, 247, ${0.5 + audioLevel * 0.5})`; // purple when quiet
  const fillColor = audioLevel > 0.5
    ? `rgba(239, 68, 68, ${audioLevel * 0.12})`
    : `rgba(168, 85, 247, ${0.05 + audioLevel * 0.08})`;

  return (
    <div className={className} style={{ position: "relative" }}>
      {/* Ambient glow */}
      <div
        className="absolute inset-0 rounded-full blur-2xl transition-opacity duration-200"
        style={{
          background: audioLevel > 0.5
            ? `radial-gradient(circle, rgba(239,68,68,${glowOpacity}) 0%, transparent 70%)`
            : `radial-gradient(circle, rgba(168,85,247,${glowOpacity}) 0%, transparent 70%)`,
        }}
      />
      <svg ref={svgRef} viewBox="0 0 304 112" className="relative z-10 w-full h-full">
        <g
          strokeWidth={1.5 + audioLevel * 1.5}
          stroke={strokeColor}
          strokeLinejoin="round"
          fill={fillColor}
          fillRule="evenodd"
        >
          <polygon
            ref={path1Ref}
            points="152,4 170,38 204,56 170,74 152,108 134,74 100,56 134,38"
          />
          <polygon
            ref={path2Ref}
            style={{ opacity: 0 }}
            points="152,4 170,38 204,56 170,74 152,108 134,74 100,56 134,38"
          />
        </g>
      </svg>
    </div>
  );
}
