"use client";

import React, { useRef, useEffect, useCallback } from "react";

export type ObstacleZone = {
  center: [number, number];
  radius: number;
  label?: string;
};

type TacticalMapProps = {
  launchPoint: [number, number];       // warehouse / takeoff point
  targetPoint: [number, number];       // customer / delivery point
  obstacleZones: ObstacleZone[];       // restricted zones (tall buildings, no-fly areas)
  obstacleRadius: number;
  waypoints?: number[][];
  previousRoutes?: number[][][];
  animating?: boolean;
  animationDone?: boolean;
  onAnimationComplete?: () => void;
  routeColor?: string;
  className?: string;
  label?: string;
  showStats?: boolean;
};

function geoToCanvas(
  lon: number, lat: number,
  bounds: { minLon: number; maxLon: number; minLat: number; maxLat: number },
  w: number, h: number, padding: number
): [number, number] {
  const innerW = w - padding * 2;
  const innerH = h - padding * 2;
  const x = padding + ((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * innerW;
  const y = padding + ((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * innerH;
  return [x, y];
}

function calcPathLength(pts: [number, number][]): { totalLen: number; segLens: number[] } {
  let totalLen = 0;
  const segLens: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dy = pts[i][1] - pts[i - 1][1];
    const len = Math.sqrt(dx * dx + dy * dy);
    segLens.push(len);
    totalLen += len;
  }
  return { totalLen, segLens };
}

function getPointAtLength(pts: [number, number][], segLens: number[], targetLen: number): [number, number] {
  let acc = 0;
  for (let i = 0; i < segLens.length; i++) {
    if (acc + segLens[i] >= targetLen) {
      const ratio = (targetLen - acc) / segLens[i];
      return [
        pts[i][0] + (pts[i + 1][0] - pts[i][0]) * ratio,
        pts[i][1] + (pts[i + 1][1] - pts[i][1]) * ratio,
      ];
    }
    acc += segLens[i];
  }
  return pts[pts.length - 1];
}

export default function TacticalMap({
  launchPoint, targetPoint, obstacleZones, obstacleRadius,
  waypoints, previousRoutes, animating, animationDone,
  onAnimationComplete, routeColor = "#34D399",
  className = "", label, showStats,
}: TacticalMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef(0);
  const animFrameRef = useRef(0);
  const completedRef = useRef(false);

  const draw = useCallback((progress: number) => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    // Compute bounds
    const allLons = [launchPoint[0], targetPoint[0], ...obstacleZones.map(d => d.center[0])];
    const allLats = [launchPoint[1], targetPoint[1], ...obstacleZones.map(d => d.center[1])];
    const allRoutes = [...(previousRoutes || []), ...(waypoints ? [waypoints] : [])];
    allRoutes.forEach(route => route.forEach(wp => { allLons.push(wp[0]); allLats.push(wp[1]); }));
    const lonRange = Math.max(...allLons) - Math.min(...allLons) || 1;
    const latRange = Math.max(...allLats) - Math.min(...allLats) || 1;
    const bounds = {
      minLon: Math.min(...allLons) - lonRange * 0.08,
      maxLon: Math.max(...allLons) + lonRange * 0.08,
      minLat: Math.min(...allLats) - latRange * 0.08,
      maxLat: Math.max(...allLats) + latRange * 0.08,
    };
    const padding = 30;
    const toCanvas = (lon: number, lat: number) => geoToCanvas(lon, lat, bounds, w, h, padding);

    // Background
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, w, h);

    // Grid
    ctx.strokeStyle = "rgba(16, 185, 129, 0.08)";
    ctx.lineWidth = 0.5;
    for (let x = 0; x < w; x += 30) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y < h; y += 30) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

    // Coord labels
    ctx.font = "9px monospace";
    ctx.fillStyle = "rgba(16, 185, 129, 0.3)";
    for (let i = 0; i <= 5; i++) {
      const lon = bounds.minLon + ((bounds.maxLon - bounds.minLon) / 5) * i;
      const [px] = toCanvas(lon, bounds.minLat);
      ctx.fillText(lon.toFixed(2), px - 15, h - 4);
    }
    for (let i = 0; i <= 4; i++) {
      const lat = bounds.minLat + ((bounds.maxLat - bounds.minLat) / 4) * i;
      const [, py] = toCanvas(bounds.minLon, lat);
      ctx.fillText(lat.toFixed(2), 2, py + 3);
    }

    // Restricted / obstacle zones (tall buildings, no-fly areas)
    obstacleZones.forEach(def => {
      const [cx, cy] = toCanvas(def.center[0], def.center[1]);
      const radiusDeg = obstacleRadius / 111000;
      const radiusPx = (radiusDeg / (bounds.maxLat - bounds.minLat)) * (h - padding * 2);

      // Pulsing danger zone
      const pulse = 1 + Math.sin(Date.now() / 800) * 0.03;
      const r = radiusPx * pulse;

      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, "rgba(239, 68, 68, 0.12)");
      grad.addColorStop(0.6, "rgba(245, 158, 11, 0.08)");
      grad.addColorStop(1, "rgba(245, 158, 11, 0.01)");
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();

      // Rotating scan line
      const angle = (Date.now() / 2000) * Math.PI;
      ctx.strokeStyle = "rgba(245, 158, 11, 0.2)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
      ctx.stroke();

      // Border
      ctx.strokeStyle = "rgba(245, 158, 11, 0.5)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.arc(cx, cy, radiusPx, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);

      // Center
      ctx.fillStyle = "#EF4444";
      ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(239, 68, 68, 0.3)";
      ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.fill();

      if (def.label) {
        ctx.font = "bold 10px sans-serif";
        ctx.fillStyle = "#FBBF24";
        ctx.fillText(def.label, cx + 10, cy - 10);
      }
    });

    // Warehouse (takeoff)
    const [lx, ly] = toCanvas(launchPoint[0], launchPoint[1]);
    ctx.fillStyle = "#22C55E";
    ctx.beginPath(); ctx.arc(lx, ly, 6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(34, 197, 94, 0.35)";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(lx, ly, 11, 0, Math.PI * 2); ctx.stroke();
    ctx.font = "bold 10px sans-serif";
    ctx.fillStyle = "#4ADE80";
    ctx.fillText("仓库", lx + 14, ly + 4);

    // Customer / delivery point
    const [tx, ty] = toCanvas(targetPoint[0], targetPoint[1]);
    ctx.fillStyle = "#0EA5E9";
    ctx.beginPath(); ctx.arc(tx, ty, 6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(14, 165, 233, 0.35)";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(tx, ty, 11, 0, Math.PI * 2); ctx.stroke();
    // Location pin marker
    ctx.strokeStyle = "rgba(14, 165, 233, 0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(tx - 18, ty); ctx.lineTo(tx + 18, ty); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(tx, ty - 18); ctx.lineTo(tx, ty + 18); ctx.stroke();
    ctx.font = "bold 10px sans-serif";
    ctx.fillStyle = "#38BDF8";
    ctx.fillText("客户", tx + 14, ty + 4);

    // Ghost routes (previous rounds)
    if (previousRoutes && previousRoutes.length > 0) {
      previousRoutes.forEach((route, ri) => {
        if (route.length < 2) return;
        const pts = route.map(wp => toCanvas(wp[0], wp[1]));
        const opacity = Math.max(0.08, 0.25 - ri * 0.05);
        ctx.strokeStyle = `rgba(148, 163, 184, ${opacity})`;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 5]);
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        pts.forEach(p => ctx.lineTo(p[0], p[1]));
        ctx.stroke();
        ctx.setLineDash([]);
        // Round label
        ctx.fillStyle = `rgba(148, 163, 184, ${opacity + 0.1})`;
        ctx.font = "9px sans-serif";
        const mid = pts[Math.floor(pts.length / 2)];
        ctx.fillText(`R${ri + 1}`, mid[0] + 4, mid[1] - 4);
      });
    }

    // Current route
    if (waypoints && waypoints.length >= 2) {
      const pts: [number, number][] = waypoints.map(wp => toCanvas(wp[0], wp[1]));
      const { totalLen, segLens } = calcPathLength(pts);
      const drawProgress = animationDone ? 1 : progress;
      const drawLen = totalLen * drawProgress;

      if (drawProgress > 0 || animationDone) {
        // Full planned route (dashed, dim) — always show the full path ahead
        if (drawProgress < 1 && !animationDone) {
          ctx.strokeStyle = `${routeColor}30`;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 6]);
          ctx.beginPath();
          ctx.moveTo(pts[0][0], pts[0][1]);
          pts.forEach(p => ctx.lineTo(p[0], p[1]));
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Flown trail (solid, bright, glow)
        ctx.save();
        ctx.shadowColor = `${routeColor}AA`;
        ctx.shadowBlur = 14;
        ctx.strokeStyle = routeColor;
        ctx.lineWidth = 3.5;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        let acc = 0;
        for (let i = 0; i < segLens.length; i++) {
          if (acc + segLens[i] <= drawLen) {
            ctx.lineTo(pts[i + 1][0], pts[i + 1][1]);
            acc += segLens[i];
          } else {
            const ratio = (drawLen - acc) / segLens[i];
            ctx.lineTo(
              pts[i][0] + (pts[i + 1][0] - pts[i][0]) * ratio,
              pts[i][1] + (pts[i + 1][1] - pts[i][1]) * ratio,
            );
            break;
          }
        }
        ctx.stroke();
        ctx.restore();

        // Waypoint markers (larger, with index)
        let wpAcc = 0;
        for (let i = 0; i < pts.length; i++) {
          if (wpAcc <= drawLen) {
            // Outer ring
            ctx.strokeStyle = `${routeColor}60`;
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.arc(pts[i][0], pts[i][1], 5, 0, Math.PI * 2); ctx.stroke();
            // Inner dot
            ctx.fillStyle = `${routeColor}CC`;
            ctx.beginPath(); ctx.arc(pts[i][0], pts[i][1], 2.5, 0, Math.PI * 2); ctx.fill();
          } else {
            // Unvisited waypoint (dim)
            ctx.fillStyle = `${routeColor}25`;
            ctx.beginPath(); ctx.arc(pts[i][0], pts[i][1], 2, 0, Math.PI * 2); ctx.fill();
          }
          if (i < segLens.length) wpAcc += segLens[i];
        }

        // Drone / missile icon at head of route
        const headPt = getPointAtLength(pts, segLens, drawLen);
        // Calculate heading angle from recent path
        const lookBackLen = Math.max(0, drawLen - 5);
        const behindPt = getPointAtLength(pts, segLens, lookBackLen);
        const heading = Math.atan2(headPt[1] - behindPt[1], headPt[0] - behindPt[0]);

        ctx.save();
        ctx.translate(headPt[0], headPt[1]);
        ctx.rotate(heading);

        // Glow halo
        ctx.shadowColor = routeColor;
        ctx.shadowBlur = 18;

        // === Small airplane silhouette (nose pointing +X along direction of motion) ===
        const sz = 9;

        // Wings (two perpendicular deltas, white)
        ctx.fillStyle = "#FFFFFF";
        ctx.beginPath();
        ctx.moveTo(sz * 0.45, -sz * 0.2);
        ctx.lineTo(sz * 0.2, -sz * 1.15);
        ctx.lineTo(-sz * 0.4, -sz * 1.15);
        ctx.lineTo(-sz * 0.45, -sz * 0.2);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(sz * 0.45, sz * 0.2);
        ctx.lineTo(sz * 0.2, sz * 1.15);
        ctx.lineTo(-sz * 0.4, sz * 1.15);
        ctx.lineTo(-sz * 0.45, sz * 0.2);
        ctx.closePath();
        ctx.fill();

        // Fuselage (tapered white body)
        ctx.beginPath();
        ctx.moveTo(sz * 1.55, 0);
        ctx.lineTo(sz * 0.55, -sz * 0.28);
        ctx.lineTo(-sz * 0.85, -sz * 0.22);
        ctx.lineTo(-sz * 1.25, 0);
        ctx.lineTo(-sz * 0.85, sz * 0.22);
        ctx.lineTo(sz * 0.55, sz * 0.28);
        ctx.closePath();
        ctx.fill();

        // Tail fin (two small deltas at rear, white)
        ctx.beginPath();
        ctx.moveTo(-sz * 0.7, -sz * 0.22);
        ctx.lineTo(-sz * 0.95, -sz * 0.65);
        ctx.lineTo(-sz * 1.2, -sz * 0.65);
        ctx.lineTo(-sz * 1.15, -sz * 0.1);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(-sz * 0.7, sz * 0.22);
        ctx.lineTo(-sz * 0.95, sz * 0.65);
        ctx.lineTo(-sz * 1.2, sz * 0.65);
        ctx.lineTo(-sz * 1.15, sz * 0.1);
        ctx.closePath();
        ctx.fill();

        // Colored accent stripe inside fuselage (brand color)
        ctx.shadowBlur = 0;
        ctx.fillStyle = routeColor;
        ctx.beginPath();
        ctx.moveTo(sz * 1.35, 0);
        ctx.lineTo(sz * 0.55, -sz * 0.19);
        ctx.lineTo(-sz * 0.85, -sz * 0.13);
        ctx.lineTo(-sz * 1.05, 0);
        ctx.lineTo(-sz * 0.85, sz * 0.13);
        ctx.lineTo(sz * 0.55, sz * 0.19);
        ctx.closePath();
        ctx.fill();

        // Cockpit highlight (small darker dot near nose)
        ctx.fillStyle = "rgba(15, 23, 42, 0.5)";
        ctx.beginPath();
        ctx.ellipse(sz * 0.85, 0, sz * 0.18, sz * 0.12, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();

        // Exhaust trail particles (behind drone)
        if (drawProgress < 1) {
          for (let t = 1; t <= 5; t++) {
            const trailLen = Math.max(0, drawLen - t * 6);
            const tp = getPointAtLength(pts, segLens, trailLen);
            const alpha = 0.4 - t * 0.07;
            ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
            ctx.beginPath();
            ctx.arc(tp[0], tp[1], 2.5 - t * 0.3, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        // Check if route endpoint is near the target
        if (drawProgress >= 1) {
          const lastWp = pts[pts.length - 1];
          const distToTarget = Math.sqrt((lastWp[0] - tx) ** 2 + (lastWp[1] - ty) ** 2);
          const isHit = distToTarget < 30; // pixels

          if (isHit) {
            // Delivery success pulse (green/cyan instead of explosion)
            const t = Date.now() / 300;
            const flash1 = (Math.sin(t) + 1) * 0.2;
            const flash2 = (Math.sin(t * 1.7) + 1) * 0.12;
            ctx.strokeStyle = `rgba(34, 197, 94, ${flash1 + 0.1})`;
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(tx, ty, 22 + Math.sin(t) * 3, 0, Math.PI * 2); ctx.stroke();
            ctx.fillStyle = `rgba(74, 222, 128, ${flash2})`;
            ctx.beginPath(); ctx.arc(tx, ty, 14, 0, Math.PI * 2); ctx.fill();
            ctx.font = "bold 12px sans-serif";
            ctx.fillStyle = `rgba(134, 239, 172, ${0.7 + flash1})`;
            ctx.fillText("✓ 送达", tx + 18, ty - 14);
          } else {
            // Miss indicator — show where the drone actually ended up
            ctx.font = "bold 10px sans-serif";
            ctx.fillStyle = "rgba(239, 68, 68, 0.8)";
            ctx.fillText("未送达", lastWp[0] - 20, lastWp[1] - 12);
            // Dashed line from endpoint to target showing remaining distance
            ctx.strokeStyle = "rgba(239, 68, 68, 0.4)";
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(lastWp[0], lastWp[1]);
            ctx.lineTo(tx, ty);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
      }

      // Route stats
      if (showStats && drawProgress >= 1) {
        // Calculate route distance in km (crude approximation)
        let distKm = 0;
        for (let i = 1; i < waypoints.length; i++) {
          const dLon = (waypoints[i][0] - waypoints[i - 1][0]) * 111 * Math.cos(waypoints[i][1] * Math.PI / 180);
          const dLat = (waypoints[i][1] - waypoints[i - 1][1]) * 111;
          distKm += Math.sqrt(dLon * dLon + dLat * dLat);
        }
        // Check if reached target
        const lastWpGeo = waypoints[waypoints.length - 1];
        const endDist = Math.sqrt((lastWpGeo[0] - targetPoint[0]) ** 2 + (lastWpGeo[1] - targetPoint[1]) ** 2);
        const reached = endDist < 0.05;

        ctx.fillStyle = "rgba(15, 23, 42, 0.8)";
        const boxW = 140, boxH = 54;
        ctx.beginPath();
        ctx.roundRect(w - boxW - 8, h - boxH - 8, boxW, boxH, 6);
        ctx.fill();
        ctx.font = "bold 9px monospace";
        ctx.fillStyle = "#94A3B8";
        ctx.fillText(`航程: ${distKm.toFixed(1)} km | ${waypoints.length} 航点`, w - boxW, h - boxH + 14);
        ctx.fillStyle = reached ? "#4ADE80" : "#F87171";
        ctx.fillText(reached ? "结果: 送达成功" : `结果: 偏离 ${(endDist * 111).toFixed(1)}km`, w - boxW, h - boxH + 30);
        ctx.fillStyle = "#64748B";
        ctx.fillText(`终点: [${lastWpGeo[0].toFixed(2)},${lastWpGeo[1].toFixed(2)}]`, w - boxW, h - boxH + 44);
      }
    }

    // Label
    if (label) {
      ctx.font = "bold 11px sans-serif";
      ctx.fillStyle = "rgba(16, 185, 129, 0.5)";
      ctx.fillText(label, w - ctx.measureText(label).width - 10, 16);
    }
  }, [launchPoint, targetPoint, obstacleZones, obstacleRadius, waypoints, previousRoutes, routeColor, label, showStats, animationDone]);

  // Animation loop
  useEffect(() => {
    if (animating && waypoints && waypoints.length >= 2) {
      progressRef.current = 0;
      completedRef.current = false;
      const startTime = Date.now();
      const duration = 3000; // 3 seconds flight

      const tick = () => {
        const elapsed = Date.now() - startTime;
        const p = Math.min(elapsed / duration, 1);
        // Easing: ease-in-out
        const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        progressRef.current = eased;
        draw(eased);

        if (p < 1) {
          animFrameRef.current = requestAnimationFrame(tick);
        } else if (!completedRef.current) {
          completedRef.current = true;
          onAnimationComplete?.();
          // Keep drawing for hit flash effect
          const flashTick = () => {
            draw(1);
            animFrameRef.current = requestAnimationFrame(flashTick);
          };
          animFrameRef.current = requestAnimationFrame(flashTick);
        }
      };
      animFrameRef.current = requestAnimationFrame(tick);
    } else if (animationDone) {
      // Static draw with pulsing effects
      const tick = () => {
        draw(1);
        animFrameRef.current = requestAnimationFrame(tick);
      };
      animFrameRef.current = requestAnimationFrame(tick);
    } else {
      // Draw static (no route)
      draw(0);
      // Still animate radar sweep
      const tick = () => {
        draw(0);
        animFrameRef.current = requestAnimationFrame(tick);
      };
      animFrameRef.current = requestAnimationFrame(tick);
    }

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [animating, animationDone, waypoints, draw]);

  return (
    <div ref={containerRef} className={`relative w-full h-full min-h-[300px] rounded-lg overflow-hidden ${className}`}>
      <canvas ref={canvasRef} className="absolute inset-0" />
    </div>
  );
}
