"use client";

import React, { useEffect, useRef } from "react";

export type RegionState = {
  id: string;
  label: string;          // e.g. "A 区 · 高新开发区"
  count: number;          // drones currently deployed
  heat?: number;          // 0~1, optional heat score
  priority?: "low" | "normal" | "high" | "critical";
  rationale?: string;     // LLM's reason for this deployment
  col: number;            // grid column (0..)
  row: number;            // grid row (0..)
};

type RegionGridProps = {
  regions: RegionState[];
  previousRegions?: RegionState[];   // for diff / transfer animation
  columns: number;                    // grid columns
  rows: number;                        // grid rows
  className?: string;
  showHeat?: boolean;
  totalDrones?: number;                // summary label
  animating?: boolean;                 // pulse effect while animating
};

const PRIORITY_COLORS: Record<string, string> = {
  low: "#94A3B8",
  normal: "#0EA5E9",
  high: "#F59E0B",
  critical: "#EF4444",
};

export default function RegionGrid({
  regions, previousRegions, columns, rows, className = "",
  showHeat = true, totalDrones: _totalDrones, animating,
}: RegionGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = React.useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setSize({ w: rect.width, h: rect.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const PADDING = 16;
  const innerW = Math.max(0, size.w - PADDING * 2);
  const innerH = Math.max(0, size.h - PADDING * 2);
  const cellW = columns > 0 ? innerW / columns : 0;
  const cellH = rows > 0 ? innerH / rows : 0;

  // Compute transfers: any region whose count changed
  const prevById = new Map((previousRegions || []).map(r => [r.id, r]));

  const cellCenter = (col: number, row: number) => ({
    x: PADDING + col * cellW + cellW / 2,
    y: PADDING + row * cellH + cellH / 2,
  });

  return (
    <div ref={containerRef} className={`relative w-full h-full min-h-[280px] bg-slate-50 rounded-xl overflow-hidden border border-slate-200 ${className}`}>
      {size.w > 0 && (
        <svg width={size.w} height={size.h} className="absolute inset-0">
          <defs>
            <pattern id="grid-bg" width="20" height="20" patternUnits="userSpaceOnUse">
              <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#E2E8F0" strokeWidth="0.5" />
            </pattern>
            <filter id="pulse-glow">
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          <rect width={size.w} height={size.h} fill="url(#grid-bg)" />

          {/* Cells */}
          {regions.map(r => {
            const { x, y } = cellCenter(r.col, r.row);
            const w = cellW - 12;
            const h = cellH - 12;
            const heat = r.heat ?? 0;
            const heatFill = showHeat && heat > 0
              ? `rgba(239, 68, 68, ${Math.min(0.25, heat * 0.3)})`
              : "rgba(255,255,255,0.6)";
            const prev = prevById.get(r.id);
            const delta = prev ? r.count - prev.count : 0;
            const priorityColor = PRIORITY_COLORS[r.priority || "normal"];

            return (
              <g key={r.id}>
                {/* Region tile */}
                <rect
                  x={x - w / 2} y={y - h / 2} width={w} height={h} rx={10}
                  fill={heatFill}
                  stroke={priorityColor}
                  strokeWidth={r.priority === "critical" || r.priority === "high" ? 2 : 1}
                  strokeDasharray={r.priority === "critical" ? "4 3" : undefined}
                />

                {/* Region label */}
                <text
                  x={x} y={y - h / 2 + 16}
                  textAnchor="middle"
                  fontSize="11" fontWeight="600" fill="#475569"
                  className="select-none"
                >
                  {r.label}
                </text>

                {/* Heat badge — placed BETWEEN region label and count (center-horizontal)
                    to avoid collision with the global "总部署" badge in the top-right. */}
                {showHeat && heat > 0 && (() => {
                  const pillW = 52;
                  const pillH = 14;
                  const pillX = x - pillW / 2;
                  const pillY = y - h / 2 + 22;
                  const heatPct = (heat * 100).toFixed(0);
                  return (
                    <g>
                      <rect
                        x={pillX} y={pillY}
                        width={pillW} height={pillH} rx={7}
                        fill="#FEF2F2" stroke="#FCA5A5" strokeWidth={0.8}
                      />
                      <text
                        x={x} y={pillY + 10}
                        textAnchor="middle"
                        fontSize="9" fontWeight="700" fill="#DC2626"
                        className="select-none"
                      >
                        热度 {heatPct}
                      </text>
                    </g>
                  );
                })()}

                {/* Count — big number in center */}
                <text
                  x={x} y={y + 12}
                  textAnchor="middle"
                  fontSize="28" fontWeight="800" fill={priorityColor}
                  className="select-none font-mono"
                  style={{ filter: animating ? "url(#pulse-glow)" : undefined }}
                >
                  {r.count}
                </text>
                <text
                  x={x} y={y + 26}
                  textAnchor="middle"
                  fontSize="9" fill="#94A3B8"
                  className="select-none"
                >
                  架无人机
                </text>

                {/* Delta indicator */}
                {delta !== 0 && (
                  <g>
                    <rect
                      x={x + w / 2 - 28} y={y + h / 2 - 20}
                      width={24} height={14} rx={3}
                      fill={delta > 0 ? "#DCFCE7" : "#FEE2E2"}
                      stroke={delta > 0 ? "#16A34A" : "#DC2626"}
                      strokeWidth={0.8}
                    />
                    <text
                      x={x + w / 2 - 16} y={y + h / 2 - 9}
                      textAnchor="middle"
                      fontSize="9" fontWeight="700"
                      fill={delta > 0 ? "#16A34A" : "#DC2626"}
                      className="select-none font-mono"
                    >
                      {delta > 0 ? `+${delta}` : `${delta}`}
                    </text>
                  </g>
                )}

                {/* Priority tag bottom-left */}
                {r.priority && r.priority !== "normal" && (
                  <g>
                    <rect
                      x={x - w / 2 + 4} y={y + h / 2 - 16}
                      width={r.priority === "critical" ? 36 : 28} height={12} rx={2}
                      fill={priorityColor}
                    />
                    <text
                      x={x - w / 2 + (r.priority === "critical" ? 22 : 18)} y={y + h / 2 - 7}
                      textAnchor="middle"
                      fontSize="8" fontWeight="700" fill="#FFF"
                      className="select-none"
                    >
                      {r.priority === "critical" ? "CRITICAL" : r.priority === "high" ? "HIGH" : "LOW"}
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* Summary badge intentionally removed — total count is rendered in the
              parent component's subtitle so it never overlaps region tile content. */}
        </svg>
      )}
    </div>
  );
}
