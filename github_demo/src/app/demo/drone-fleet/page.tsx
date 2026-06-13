"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Play, Loader2, ChevronDown, Info, Clock, Zap, Plane, MapPin, Share2, Paperclip, X } from "lucide-react";
import { getCachedLatestRecord, saveRecord, type TestRecord } from "@/lib/history";
import { SEED_RECORD } from "./seedRecord";
import HistoryModal from "@/components/HistoryModal";
import WorkloadInfoModal from "@/components/WorkloadInfoModal";
import LegendChips from "@/components/LegendChips";
import TacticalMap from "@/components/TacticalMap";
import type { ObstacleZone } from "@/components/TacticalMap";
import {
  BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";
import { getApiBase } from "@/lib/api";
import { t, useLocale } from "@/lib/i18n";

/* ── Constants ── */
const WAREHOUSE: [number, number] = [106.60, 28.50];
const OBSTACLE_ZONES: ObstacleZone[] = [
  { center: [106.60, 28.80], radius: 15000, label: "No-fly Zone / Skyline" },
];
const OBSTACLE_RADIUS = 15000;

function ExperimentConfigPanel({ workloadLabel }: { workloadLabel: string }) {
  const [locale] = useLocale();
  const isEn = locale === "en";
  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-5 md:p-6 shadow-sm">
      <div className="space-y-5">
        <div>
          <div className="text-xl font-black text-gray-900 tracking-tight">
            {isEn ? `Experiment Setup: ${workloadLabel}` : `实验配置：${workloadLabel}`}
          </div>
          <div className="mt-1 max-w-4xl space-y-1 text-base leading-relaxed text-gray-500">
            <p>{isEn
              ? "Both systems run the same multi-drone route-planning workload on the same local deployment; the only difference is the KV Cache tier."
              : "两套系统在同一套本地化部署上执行同一组多无人机并发航线规划请求，唯一区别在 KV Cache 扩展层："}</p>
            <p>{isEn
              ? "LMCache-DRAM uses a smaller 64GB DRAM, while InfiniKV uses a larger 512GB SSD that can keep more historical KV Cache for revisits."
              : "LMCache-DRAM 采用 64GB DRAM，InfiniKV 采用更大的 512GB SSD，可保留更多历史 KV Cache 以供重访复用。"}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full">
          <div className="relative overflow-hidden rounded-2xl border border-orange-200 bg-white p-4 shadow-sm">
            <div className="absolute left-0 top-0 h-full w-1.5 bg-orange-500" />
            <div className="pl-3">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-orange-500" />
                  <div className="text-base font-black text-orange-700">
                    LMCache-DRAM
                  </div>
                </div>
                <span className="rounded-full border border-orange-200 bg-orange-50 px-2 py-0.5 text-[11px] font-bold text-orange-700">
                  {isEn ? "Baseline" : "基线"}
                </span>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3 rounded-xl bg-orange-50 px-3 py-2">
                  <span className="text-base font-semibold text-orange-700/80">{isEn ? "Offload Medium" : "卸载介质"}</span>
                  <span className="font-mono text-base font-black text-orange-800">64GB DRAM</span>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-xl bg-orange-50 px-3 py-2">
                  <span className="text-base font-semibold text-orange-700/80">{isEn ? "What happens" : "并发后表现"}</span>
                  <span className="whitespace-nowrap text-sm font-bold text-orange-800">{isEn ? "small; early-node KV gets evicted sooner" : "容量小，早期节点 KV 更早被淘汰"}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="relative overflow-hidden rounded-2xl border border-sky-200 bg-white p-4 shadow-sm">
            <div className="absolute left-0 top-0 h-full w-1.5 bg-sky-500" />
            <div className="pl-3">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-sky-500" />
                  <div className="text-base font-black text-sky-700">
                    InfiniKV (SSD)
                  </div>
                </div>
                <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-bold text-sky-700">
                  {isEn ? "Optimized" : "优化方案"}
                </span>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3 rounded-xl bg-sky-50 px-3 py-2">
                  <span className="text-base font-semibold text-sky-700/80">{isEn ? "Offload Medium" : "卸载介质"}</span>
                  <span className="font-mono text-base font-black text-sky-800">512GB SSD</span>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-xl bg-sky-50 px-3 py-2">
                  <span className="text-base font-semibold text-sky-700/80">{isEn ? "What happens" : "并发后表现"}</span>
                  <span className="whitespace-nowrap text-sm font-bold text-sky-800">{isEn ? "large; more node KV stays available to reuse" : "容量大，更多节点 KV 可留存复用"}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CostBenefitPanel() {
  const [locale] = useLocale();
  const isEn = locale === "en";
  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-5 md:p-6 shadow-sm">
      <div className="mb-4">
        <div className="text-xl font-black text-gray-900 tracking-tight">
          {isEn ? "Cost-benefit analysis: KV capacity and server cost for a 1024-drone fleet" : "成本效益分析：支撑 1024 架无人机的 KV 容量与服务器成本"}
        </div>
        <div className="mt-1 max-w-4xl space-y-1 text-base leading-relaxed text-gray-500">
          <p>{isEn
            ? "Each drone keeps about 7GB of historical KV, so a 1024-drone fleet needs roughly 7TB of KV capacity."
            : "每架无人机约保留 7GB 历史 KV，1024 架机群合计约需 7TB KV 容量。"}</p>
          <p>{isEn
            ? "The two backends differ in how this KV capacity is provisioned: DRAM scales out across multiple servers, while SSD is served by a single server."
            : "两种后端的差异在于这部分KV容量的承载方式：DRAM 方案需横向扩展多台服务器，SSD 方案则可由单台服务器承载。"}</p>
        </div>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-black text-slate-800">{isEn ? "1024-drone fleet: KV capacity and server cost" : "1024 架无人机集群：KV 容量与服务器成本"}</div>
          <span className="text-sm font-bold text-slate-600">{isEn ? "Each node ~7GB KV · 1024 nodes ≈ 7TB" : "单节点约 7GB KV · 1024 节点 ≈ 7TB"}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] border-separate border-spacing-0 text-base">
            <thead>
              <tr className="text-left text-sm font-bold text-slate-600">
                <th className="border-b-2 border-slate-200 py-3 pr-3">{isEn ? "KV backend" : "KV 后端"}</th>
                <th className="border-b-2 border-slate-200 px-3 py-3">{isEn ? "Per server" : "单台后端"}</th>
                <th className="border-b-2 border-slate-200 px-3 py-3">{isEn ? "Servers" : "所需服务器"}</th>
                <th className="border-b-2 border-slate-200 px-3 py-3">{isEn ? "Total cost" : "服务器总成本"}</th>
                <th className="border-b-2 border-slate-200 py-3 pl-3">{isEn ? "Cost ratio" : "成本效益"}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="bg-orange-50/60">
                <td className="rounded-l-xl py-4 pr-3 pl-3 text-base font-black text-orange-700">LMCache-DRAM</td>
                <td className="px-3 py-4 font-mono font-semibold text-slate-700">1TB DRAM</td>
                <td className="px-3 py-4 font-mono text-lg font-black text-slate-900">{isEn ? "~7" : "约 7 台"}</td>
                <td className="px-3 py-4 font-mono text-lg font-black text-slate-900">{isEn ? "¥14.7M" : "1470 万"}</td>
                <td className="rounded-r-xl py-4 pl-3 pr-3 font-mono text-lg font-black text-slate-400">1×</td>
              </tr>
              <tr><td className="h-2" /></tr>
              <tr className="bg-sky-50/70 ring-1 ring-sky-100">
                <td className="rounded-l-xl py-4 pr-3 pl-3 text-base font-black text-sky-700">InfiniKV (SSD)</td>
                <td className="px-3 py-4 font-mono font-semibold text-slate-700">8TB SSD</td>
                <td className="px-3 py-4 font-mono text-lg font-black text-slate-900">{isEn ? "1" : "1 台"}</td>
                <td className="px-3 py-4 font-mono text-lg font-black text-slate-900">{isEn ? "¥2.02M" : "202 万"}</td>
                <td className="rounded-r-xl py-4 pl-3 pr-3 font-mono text-xl font-black text-emerald-600">0.14×</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-sm font-semibold leading-relaxed text-emerald-800">
          {isEn
            ? "For the same ~7TB of KV Cache, the SSD backend serves all 1024 drones from a single server instead of seven DRAM servers — about an order-of-magnitude lower cost (0.14x)."
            : "面对同样约 7TB 的 KV 缓存，SSD 后端用 1 台服务器即可承载 1024 架无人机，替代约 7 台 DRAM 服务器，总成本下降约一个数量级（0.14×）。"}
        </div>
      </div>
    </div>
  );
}

function KvTierDiagram() {
  const [locale] = useLocale();
  const isEn = locale === "en";
  const mix = (sky: number, em: number, vi: number) => [
    ...Array(sky).fill("bg-sky-500"),
    ...Array(em).fill("bg-emerald-500"),
    ...Array(vi).fill("bg-violet-500"),
  ];
  const COLS = 16;
  const gridCols = { gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))` };
  const hbmCells = mix(13, 3, 0);       // GPU HBM: one full row of active KV
  const dramKept = mix(24, 8, 0);       // DRAM holds 2 rows
  const dramEvicted = COLS * 2;         // DRAM evicts 2 more rows
  const ssdKept = mix(36, 18, 10);      // SSD holds all 4 rows
  const Legend = ({ tone, label }: { tone: string; label: string }) => (
    <span className="inline-flex items-center gap-1.5"><span className={`h-3 w-3 rounded-[3px] ${tone}`} />{label}</span>
  );
  const Cell = ({ tone }: { tone: string }) => <span className={`aspect-square rounded-[3px] ${tone} shadow-sm`} />;
  const Grid = ({ tones }: { tones: string[] }) => (
    <div className="grid w-full gap-1.5" style={gridCols}>{tones.map((c, i) => <Cell key={i} tone={c} />)}</div>
  );
  const Hbm = () => (
    <div className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between gap-6">
        <span className="text-xs font-black text-slate-600">GPU HBM</span>
        <span className="text-[10px] font-bold text-slate-400">{isEn ? "active KV" : "活跃 KV"}</span>
      </div>
      <Grid tones={hbmCells} />
    </div>
  );
  const Arrow = ({ tone }: { tone: string }) => (
    <div className="my-1.5 flex justify-center"><ChevronDown className={`h-7 w-7 ${tone}`} strokeWidth={3.5} /></div>
  );
  return (
    <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 md:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-black text-slate-700">
          {isEn ? "The same KV Cache, two backends" : "同样的 KV Cache，两种后端的不同存放方式"}
        </div>
        <div className="flex flex-wrap gap-3 text-[11px] font-semibold text-slate-500">
          <Legend tone="bg-sky-500" label={isEn ? "active KV" : "活跃 KV"} />
          <Legend tone="bg-emerald-500" label={isEn ? "recent KV" : "近期 KV"} />
          <Legend tone="bg-violet-500" label={isEn ? "older KV" : "较早 KV"} />
          <Legend tone="bg-red-100" label={isEn ? "evicted" : "已淘汰"} />
        </div>
      </div>

      <div className="relative grid grid-cols-1 gap-5 md:grid-cols-2 md:gap-0">
        {/* LEFT — DRAM path */}
        <div className="md:pr-6">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm font-black text-orange-700">LMCache-DRAM</span>
            <span className="rounded-full border border-orange-200 bg-orange-50 px-2 py-0.5 text-[11px] font-bold text-orange-700">{isEn ? "capacity tight" : "容量吃紧"}</span>
          </div>
          <Hbm />
          <Arrow tone="text-orange-500" />
          <div className="w-full rounded-xl border border-orange-200 bg-orange-50/50 p-3">
            <div className="mb-2 text-xs font-black text-orange-700">{isEn ? "DRAM · retained" : "DRAM · 可容纳"}</div>
            <Grid tones={dramKept} />
          </div>
          <div className="mt-2 w-full rounded-xl border border-dashed border-red-300 bg-red-50/60 p-3">
            <div className="mb-2 text-xs font-black text-red-600">{isEn ? "evicted (overflow)" : "已淘汰（超出容量）"}</div>
            <div className="grid w-full gap-1.5" style={gridCols}>
              {Array.from({ length: dramEvicted }).map((_, i) => (
                <span key={i} className="flex aspect-square items-center justify-center rounded-[3px] border border-red-400 bg-red-50 text-[10px] font-black leading-none text-red-500">✕</span>
              ))}
            </div>
          </div>
          <div className="mt-2 text-xs font-semibold leading-snug text-orange-700">
            {isEn ? "Overflow KV is evicted → those drones re-prefill on revisit" : "无法容纳的 KV 被淘汰 → 这些无人机重访时需重新预填充"}
          </div>
        </div>

        {/* center divider */}
        <div className="pointer-events-none absolute inset-y-0 left-1/2 hidden -translate-x-1/2 md:block">
          <div className="h-full w-px bg-slate-200" />
        </div>

        {/* RIGHT — SSD path */}
        <div className="md:pl-6">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm font-black text-sky-700">InfiniKV (SSD)</span>
            <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-bold text-sky-700">{isEn ? "ample capacity" : "容量充裕"}</span>
          </div>
          <Hbm />
          <Arrow tone="text-sky-500" />
          <div className="w-full rounded-xl border border-sky-200 bg-sky-50/50 p-3">
            <div className="mb-2 text-xs font-black text-sky-700">{isEn ? "SSD · all retained" : "SSD · 全部容纳"}</div>
            <Grid tones={ssdKept} />
          </div>
          <div className="mt-2 text-xs font-semibold leading-snug text-sky-700">
            {isEn ? "All KV stays on SSD → revisits reuse cache, no re-prefill" : "KV 全部留在 SSD → 重访直接复用，无需重新预填充"}
          </div>
        </div>
      </div>
    </div>
  );
}

function PlanningTransitionPanel() {
  const [locale] = useLocale();
  const isEn = locale === "en";
  const columns = isEn
    ? [
      {
        title: "Rule-based planning",
        tag: "Before LLM",
        icon: MapPin,
        tone: "border-slate-200 bg-slate-50 text-slate-700",
        body: "Works for small, stable tasks; once weather, no-fly zones and battery state keep changing, it takes many human operators to fix routes by hand.",
      },
      {
        title: "LLM-assisted planning",
        tag: "Problem exposed",
        icon: Plane,
        tone: "border-orange-200 bg-orange-50 text-orange-700",
        body: "Each concurrent node holds its own KV Cache. Once DRAM fills up, old KV is evicted and revisits must prefill again.",
      },
      {
        title: "Tutti / InfiniKV backend",
        tag: "This demo",
        icon: Zap,
        tone: "border-sky-200 bg-sky-50 text-sky-700",
        body: "InfiniKV uses a much larger SSD to keep far more historical KV Cache; even when DRAM is full, it can be reused directly, so revisits stay fast and stable.",
      },
    ]
    : [
      {
        title: "基于规则规划",
        tag: "未使用 LLM",
        icon: MapPin,
        tone: "border-slate-200 bg-slate-50 text-slate-700",
        body: "适合约束明确、变化少的任务；一旦天气、禁飞区、电量等动态变化，就需要大量人工逐一修正航线。",
      },
      {
        title: "LLM 辅助决策",
        tag: "问题显现",
        icon: Plane,
        tone: "border-orange-200 bg-orange-50 text-orange-700",
        body: "每个并发节点各自占用一份 KV Cache；DRAM 容量不足时旧 KV 被淘汰，重访需重新预填充。",
      },
      {
        title: "InfiniKV 后端",
        tag: "本方案",
        icon: Zap,
        tone: "border-sky-200 bg-sky-50 text-sky-700",
        body: "InfiniKV 用更大的 SSD 容量保存更多历史 KV Cache，重访更稳定。",
      },
    ];

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 md:p-6 shadow-sm">
      <div className="mb-5">
        <h3 className="text-xl md:text-2xl font-black tracking-tight text-slate-900">
          {isEn
            ? "Workload analysis: from rule-based to LLM-assisted planning, the bottleneck shifts to KV Cache capacity"
            : "负载解析：从「规则规划」到「LLM 辅助决策」，瓶颈转移到 KV Cache 承载能力"}
        </h3>
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {columns.map(({ title, tag, icon: Icon, tone, body }) => (
          <div key={title} className={`rounded-xl border p-4 ${tone}`}>
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <div className="rounded-lg bg-white p-2 shadow-sm">
                  <Icon className="h-4 w-4" />
                </div>
                <h4 className="text-base font-black text-slate-900">{title}</h4>
              </div>
              <span className="rounded-full border border-white/70 bg-white px-2 py-0.5 text-[11px] font-black">
                {tag}
              </span>
            </div>
            <p className="text-sm font-semibold leading-relaxed text-slate-600">{body}</p>
          </div>
        ))}
      </div>
      <KvTierDiagram />
    </div>
  );
}


type MetricsSide = {
  label: string;
  avgTtft: number;
  totalTtft: number;
  qps: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  accent: "orange" | "sky";
};

function fmtSeconds(v: number, digits = 3) {
  return v > 0 ? `${v.toFixed(digits)}s` : "--";
}

function fmtQps(v: number) {
  return v > 0 ? v.toFixed(2) : "--";
}

function fmtTokens(v: number) {
  return v > 0 ? `${Math.round(v).toLocaleString()} tk` : "--";
}

function fmtCompactTokens(v: number) {
  return v > 0 ? `${Math.round(v / 1000)}K` : "--";
}

function GainBadge({
  label,
  value,
  helper,
}: {
  label: string;
  value: number;
  helper: string;
}) {
  const ready = Number.isFinite(value) && value > 0;
  return (
    <div className="relative overflow-hidden rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4 shadow-sm">
      <div className="absolute inset-y-0 left-0 w-1 bg-emerald-500" />
      <div className="pl-2">
        <div className="flex items-center justify-between gap-3 mb-1">
          <div className="text-xs font-black text-emerald-700 tracking-widest uppercase">
            {label}
          </div>
          <div className="flex items-center gap-1.5" aria-hidden="true">
            <span className="w-2.5 h-2.5 rounded-full bg-orange-500" />
            <span className="text-[10px] font-black text-emerald-600">→</span>
            <span className="w-2.5 h-2.5 rounded-full bg-sky-500" />
          </div>
        </div>
        <div className="flex items-end gap-1.5">
          <span className="text-4xl md:text-5xl font-black text-emerald-700 leading-none">
            {ready ? value.toFixed(2) : "--"}
          </span>
          <span className="text-2xl font-black text-emerald-700 mb-1">x</span>
        </div>
        <div className="text-xs text-emerald-700/80 mt-2 font-semibold">
          {helper}
        </div>
      </div>
    </div>
  );
}

function MetricCell({
  label,
  value,
  sub,
  highlight = false,
  accent = "gray",
  children,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
  accent?: "orange" | "sky" | "gray";
  children?: React.ReactNode;
}) {
  const baseClass = "bg-white border-slate-200 text-slate-900";
  const highlightClass =
    accent === "sky"
      ? "bg-sky-50 border-sky-200 text-sky-950 ring-1 ring-sky-100 shadow-sm"
      : accent === "orange"
        ? "bg-orange-50 border-orange-200 text-orange-950 ring-1 ring-orange-100 shadow-sm"
        : "bg-slate-50 border-slate-200 text-slate-900";

  const labelClass =
    accent === "sky"
      ? "text-sky-700"
      : accent === "orange"
        ? "text-orange-700"
        : "text-slate-500";

  const valueClass = highlight
    ? accent === "sky"
      ? "text-sky-900"
      : accent === "orange"
        ? "text-orange-900"
        : "text-slate-900"
    : "text-slate-900";

  return (
    <div
      className={`rounded-xl border p-4 min-h-[104px] ${highlight ? highlightClass : baseClass}`}
    >
      <div className={`text-xs font-bold mb-1 ${labelClass}`}>{label}</div>
      <div
        className={`text-2xl md:text-3xl font-black font-mono tracking-tight ${valueClass}`}
      >
        {value}
      </div>
      {sub && (
        <div className="text-xs text-slate-500 mt-1 font-medium">{sub}</div>
      )}
      {children}
    </div>
  );
}

function ModelMetricsPanel({
  title,
  model,
  lm,
  ik,
  qpsGainPct,
}: {
  title: string;
  model: string;
  lm: MetricsSide;
  ik: MetricsSide;
  qpsGainPct: number;
}) {
  const [locale] = useLocale();
  const isEn = locale === "en";
  const ttftSpeedup =
    lm.avgTtft > 0 && ik.avgTtft > 0 ? lm.avgTtft / ik.avgTtft : 0;
  const qpsSpeedup = lm.qps > 0 && ik.qps > 0 ? ik.qps / lm.qps : 0;
  const qpsGainText =
    lm.qps > 0 && ik.qps > 0
      ? `${qpsGainPct >= 0 ? "+" : ""}${qpsGainPct.toFixed(1)}%`
      : "--";

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-6 md:p-7 shadow-sm space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-5">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <h3 className="text-2xl font-black text-slate-900 tracking-tight">
              {title}
            </h3>
            <span className="text-xs font-mono font-semibold px-2.5 py-1 rounded-md bg-slate-100 text-slate-600 border border-slate-200">
              {isEn ? "Model" : "模型"} {model}
            </span>
          </div>
          <p className="text-sm text-slate-500 leading-relaxed">
            {isEn
              ? "The table below compares the DRAM baseline against the SSD extension tier under multi-drone concurrent route planning. Average TTFT measures each drone's first-token response time; QPS measures a single server's concurrent throughput. By retaining more node KV on SSD and avoiding repeated prefill on revisit, InfiniKV lowers average TTFT by about 1.89x and raises throughput by about 1.32x over the DRAM baseline."
              : "下表对比 DRAM 基线与 SSD 扩展层在多无人机并发航线规划下的关键指标。平均 TTFT 衡量每架无人机的首字响应速度，估算 QPS 衡量单台服务器的并发处理能力。InfiniKV 在 SSD 层保留更多节点 KV、避免重访时重复预填充，相比 DRAM 基线平均 TTFT 降低约 1.89×、吞吐提升约 1.32×。"}
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 min-w-0 lg:min-w-[420px]">
          <GainBadge
            label={isEn ? "TTFT Speedup" : "TTFT 性能优化"}
            value={ttftSpeedup}
            helper={isEn ? "Formula: LM avg TTFT / InfiniKV avg TTFT" : "计算：LM 平均 TTFT ÷ InfiniKV 平均 TTFT"}
          />
          <GainBadge
            label={isEn ? "QPS Speedup" : "QPS 性能提升"}
            value={qpsSpeedup}
            helper={isEn ? `Formula: InfiniKV QPS / LM QPS` : `计算：InfiniKV QPS ÷ LM QPS`}
          />
        </div>
      </div>

      <div className="space-y-4">
        <div className="rounded-2xl border border-orange-200 bg-orange-50/30 p-3 md:p-4 shadow-sm">
          <div className="grid grid-cols-1 xl:grid-cols-[170px_repeat(4,minmax(0,1fr))] gap-3 items-stretch">
            <div className="flex xl:flex-col items-center xl:items-start justify-between xl:justify-center gap-2 rounded-xl bg-white border border-slate-200 border-l-4 border-l-orange-500 px-4 py-4 shadow-sm">
              <div>
                <div className="inline-flex items-center rounded-full border border-orange-200 bg-orange-50 px-2 py-0.5 text-[11px] font-black text-orange-700 mb-2">
                  {isEn ? "Baseline" : "基线"}
                </div>
                <div className="text-lg font-black text-slate-900">
                  {lm.label}
                </div>
              </div>
              <div className="w-3 h-3 rounded-full bg-orange-500" />
            </div>
            <MetricCell
              label={isEn ? "Avg TTFT" : "平均 TTFT"}
              value={fmtSeconds(lm.avgTtft)}
              sub={isEn ? "Lower is better" : "首字延迟，越低越好"}
              highlight
              accent="orange"
            />
            <MetricCell
              label={isEn ? "Estimated QPS" : "估算 QPS"}
              value={fmtQps(lm.qps)}
              sub={isEn ? "drone plans / sec · higher is better" : "每秒完成的无人机规划数 · 越高越好"}
              highlight
              accent="orange"
            />
            <MetricCell
              label={isEn ? "Avg Input" : "平均输入"}
              value={fmtTokens(lm.avgInputTokens)}
              sub={isEn ? "prompt tokens per node" : "每个节点 prompt token"}
              accent="orange"
            />
            <MetricCell
              label={isEn ? "Avg Output" : "平均输出"}
              value={fmtTokens(lm.avgOutputTokens)}
              sub={isEn ? "completion tokens per node" : "每个节点 completion token"}
              accent="orange"
            />
          </div>
        </div>

        <div className="rounded-2xl border border-sky-200 bg-sky-50/30 p-3 md:p-4 shadow-sm">
          <div className="grid grid-cols-1 xl:grid-cols-[170px_repeat(4,minmax(0,1fr))] gap-3 items-stretch">
            <div className="flex xl:flex-col items-center xl:items-start justify-between xl:justify-center gap-2 rounded-xl bg-white border border-slate-200 border-l-4 border-l-sky-500 px-4 py-4 shadow-sm">
              <div>
                <div className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-black text-sky-700 mb-2">
                  {isEn ? "Optimized" : "优化方案"}
                </div>
                <div className="text-lg font-black text-slate-900">
                  {ik.label}
                </div>
              </div>
              <div className="w-3 h-3 rounded-full bg-sky-500" />
            </div>
            <MetricCell
              label={isEn ? "Avg TTFT" : "平均 TTFT"}
              value={fmtSeconds(ik.avgTtft)}
              sub={isEn ? "Lower is better" : "越低越好"}
              highlight
              accent="sky"
            >
              {ttftSpeedup > 0 && (
                <div className="mt-2 inline-flex items-center rounded-full border border-sky-200 bg-white px-2.5 py-1 text-xs font-black text-sky-700 shadow-sm">
                  {isEn ? "TTFT speedup" : "TTFT 优化"} {ttftSpeedup.toFixed(2)}x
                </div>
              )}
            </MetricCell>
            <MetricCell
              label={isEn ? "Estimated QPS" : "估算 QPS"}
              value={fmtQps(ik.qps)}
              sub={isEn ? "drone plans / sec · higher is better" : "每秒完成的无人机规划数 · 越高越好"}
              highlight
              accent="sky"
            >
              {qpsSpeedup > 0 && (
                <div className="mt-2 inline-flex items-center rounded-full border border-sky-200 bg-white px-2.5 py-1 text-xs font-black text-sky-700 shadow-sm">
                  {isEn ? "QPS speedup" : "QPS 提升"} {qpsSpeedup.toFixed(2)}x
                </div>
              )}
            </MetricCell>
            <MetricCell
              label={isEn ? "Avg Input" : "平均输入"}
              value={fmtTokens(ik.avgInputTokens)}
              sub={isEn ? "prompt tokens per node" : "每个节点 prompt token"}
              accent="sky"
            />
            <MetricCell
              label={isEn ? "Avg Output" : "平均输出"}
              value={fmtTokens(ik.avgOutputTokens)}
              sub={isEn ? "completion tokens per node" : "每个节点 completion token"}
              accent="sky"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricDefinitionPanel() {
  const [locale] = useLocale();
  const isEn = locale === "en";
  const items = isEn
    ? [
      {
        title: "TTFT — first-token latency",
        body: "The wait from sending a request to the first token — it directly shapes how responsive the dispatcher feels the system is.",
        formula: "TTFT_avg = ( Σ_{i=1..N} TTFT_i ) / N",
        read: "Lower is better — InfiniKV reuses cached KV, so revisiting nodes start sooner.",
      },
      {
        title: "QPS — throughput",
        body: "How many drone planning requests the backend finishes per second. It reflects how many drones one server can serve at once.",
        formula: "QPS = N / T_total   (N completed nodes, T = Σ batch time)",
        read: "Higher is better — keeping more KV on SSD lets the backend carry more concurrent drones.",
      },
    ]
    : [
      {
        title: "TTFT · 首字延迟",
        body: "从发出请求到返回第一个 token 的等待时间，直接影响方案响应的速度。",
        formula: "TTFT_平均 = ( Σ_{i=1..N} TTFT_i ) / N",
        read: "越低越好——InfiniKV 复用已缓存的 KV，重访节点能更快开始响应。",
      },
      {
        title: "QPS · 吞吐",
        body: "后端每秒能完成多少架无人机的规划请求，反映服务器的承载能力。",
        formula: "QPS = N / T_总   （N 为完成节点数，T = Σ 批次耗时）",
        read: "越高越好——更多 KV 留在 SSD，后端就能并发承载更多无人机。",
      },
    ];
  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-6 md:p-7 shadow-sm">
      <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Info className="w-5 h-5 text-sky-500" />
          <h3 className="text-xl font-black text-gray-900 tracking-tight">
            {isEn ? "Metric Definitions and Formulas" : "指标含义与计算方式"}
          </h3>
        </div>
        <span className="text-xs font-bold text-slate-500">
          {isEn ? "All metrics on this page follow the definitions below" : "本页所有指标均按以下定义计算"}
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {items.map(item => (
          <div key={item.title} className="rounded-xl border border-gray-200 bg-gray-50/70 p-4">
            <div className="text-sm font-black text-gray-900 mb-1">{item.title}</div>
            <p className="text-sm text-gray-600 leading-relaxed">{item.body}</p>
            <div className="mt-3 rounded-lg border border-white bg-white px-3 py-2">
              <div className="text-[11px] font-black uppercase tracking-wide text-slate-400">
                {isEn ? "Formula" : "计算方式"}
              </div>
              <div className="mt-0.5 text-xs font-mono font-semibold text-gray-500">{item.formula}</div>
            </div>
            <div className="mt-2 text-xs font-bold text-sky-700">{item.read}</div>
          </div>
        ))}
      </div>
    </div>
  );
}


/* Each mission: one drone, one customer, same warehouse, same obstacle — need to curve around */
const DELIVERY_MISSIONS = [
  { id: 1, targetEn: "Node A · Residential", target: "客户 A · 居民区", desc: "规划航线到北侧居民区客户，绕开高楼群（从西侧绕行）", coords: "[106.60, 29.10]", targetPt: [106.60, 29.10] as [number, number] },
  { id: 2, targetEn: "Node B · CBD", target: "客户 B · 商圈", desc: "规划航线到东北商圈客户，绕开高楼群（从东侧绕行）", coords: "[106.80, 29.05]", targetPt: [106.80, 29.05] as [number, number] },
  { id: 3, targetEn: "Node C · Hospital", target: "客户 C · 医院", desc: "规划航线到西北医院急件，绕开高楼群（从西侧绕行）", coords: "[106.40, 29.00]", targetPt: [106.40, 29.00] as [number, number] },
  { id: 4, targetEn: "Node D · School", target: "客户 D · 学校", desc: "规划航线到正北学校，绕开高楼群（选择最短路线）", coords: "[106.55, 29.15]", targetPt: [106.55, 29.15] as [number, number] },
  { id: 5, targetEn: "Node E · Corporate", target: "客户 E · 写字楼", desc: "规划航线到东侧写字楼，绕开高楼群（从东侧绕行）", coords: "[106.75, 28.95]", targetPt: [106.75, 28.95] as [number, number] },
  { id: 6, targetEn: "Node F · Logistics", target: "客户 F · 物流点", desc: "规划航线到西侧物流中转点，绕开高楼群（从西侧绕行）", coords: "[106.38, 28.95]", targetPt: [106.38, 28.95] as [number, number] },
  { id: 7, targetEn: "Node G · Park", target: "客户 G · 园区", desc: "规划航线到北方产业园区，绕开高楼群（选择最短路线）", coords: "[106.65, 29.20]", targetPt: [106.65, 29.20] as [number, number] },
  { id: 8, targetEn: "Node H · Community", target: "客户 H · 社区", desc: "规划航线到西北社区配送点，绕开高楼群（从西侧绕行）", coords: "[106.45, 29.10]", targetPt: [106.45, 29.10] as [number, number] },
  { id: 9, targetEn: "Node I · Stadium", target: "客户 I · 体育馆", desc: "规划航线到东北体育馆，绕开高楼群（从东侧绕行）", coords: "[106.78, 29.18]", targetPt: [106.78, 29.18] as [number, number] },
  { id: 10, targetEn: "Node J · Library", target: "客户 J · 图书馆", desc: "规划航线到西北图书馆分馆，绕开高楼群（从西侧绕行）", coords: "[106.42, 29.20]", targetPt: [106.42, 29.20] as [number, number] },
  { id: 11, targetEn: "Node K · Airport Transfer", target: "客户 K · 机场接驳", desc: "规划航线到东南机场接驳点，绕开高楼群（从东侧绕行）", coords: "[106.82, 28.90]", targetPt: [106.82, 28.90] as [number, number] },
  { id: 12, targetEn: "Node L · Pharmacy", target: "客户 L · 药房", desc: "规划航线到西南连锁药房，绕开高楼群（从西侧绕行）", coords: "[106.35, 28.92]", targetPt: [106.35, 28.92] as [number, number] },
  { id: 13, targetEn: "Node M · Restaurant", target: "客户 M · 餐厅", desc: "规划航线到东北连锁餐厅，绕开高楼群（从东侧绕行）", coords: "[106.70, 29.25]", targetPt: [106.70, 29.25] as [number, number] },
  { id: 14, targetEn: "Node N · School Annex", target: "客户 N · 学校副校区", desc: "规划航线到西北学校副校区，绕开高楼群（从西侧绕行）", coords: "[106.48, 29.25]", targetPt: [106.48, 29.25] as [number, number] },
  { id: 15, targetEn: "Node O · First Aid Sta.", target: "客户 O · 急救站", desc: "规划航线到东侧紧急急救站，绕开高楼群（选择最短路线）", coords: "[106.72, 29.00]", targetPt: [106.72, 29.00] as [number, number] },
  { id: 16, targetEn: "Node P · Community Center", target: "客户 P · 社区中心", desc: "规划航线到西侧社区活动中心，绕开高楼群（从西侧绕行）", coords: "[106.40, 29.12]", targetPt: [106.40, 29.12] as [number, number] },
];

const SHARED_SYSTEM_PROMPT = `# 角色
你是城市无人机舰队调度系统。本次为并发节点调度，每个节点独立规划一架无人机从共享仓库到各自客户的航线。

# 共享地图参数（所有节点相同）
- 仓库起点：[106.60, 28.50]
- 禁飞区中心：[106.60, 28.80]
- 禁飞区半径：0.14 度（所有航点必须距离禁飞区中心 > 0.14 度）

# 输出契约（严格）
<OUTPUT>
{"routes":[[经度,纬度,300],[经度,纬度,300], ... ]}
</OUTPUT>
<EXPLAIN>
（1 句话说明本节点的绕行方向选择）
</EXPLAIN>

# 硬性约束
1. <OUTPUT> 内为合法 JSON，字段名 "routes"。
2. routes 第一个点必须是仓库 [106.60,28.50,300]。
3. routes 最后一个点必须与用户问题中的客户坐标一致。
4. 中间航点绕开禁飞区：西侧绕行经度 ≈ 106.40~106.45，东侧绕行经度 ≈ 106.75~106.80。
5. 总航点 5~7 个，相邻间距 0.08~0.12 度。
6. 绝对禁止：Markdown 代码围栏（\`\`\`）、<OUTPUT> 前加任何说明文字。

# 示例（西侧绕行到北侧居民区）
<OUTPUT>
{"routes":[[106.60,28.50,300],[106.50,28.65,300],[106.42,28.80,300],[106.50,28.95,300],[106.60,29.10,300]]}
</OUTPUT>
<EXPLAIN>
西侧绕行，中段经 106.42 规避高楼群，5 点最短方案。
</EXPLAIN>`;

const SHARED_SYSTEM_PROMPT_EN = `# Role
You are a city drone fleet dispatch system. This workload runs multiple planning nodes concurrently. Each node plans one drone route from the shared warehouse to its own customer.

# Shared map
- Warehouse: [106.60, 28.50]
- No-fly zone center: [106.60, 28.80]
- No-fly zone radius: 0.14 degrees. All intermediate waypoints must stay outside this radius.

# Output contract
<OUTPUT>
{"routes":[[longitude,latitude,300],[longitude,latitude,300], ... ]}
</OUTPUT>
<EXPLAIN>
One sentence explaining the detour direction.
</EXPLAIN>

# Hard constraints
1. The content inside <OUTPUT> must be valid JSON with a "routes" field.
2. The first waypoint must be the warehouse [106.60,28.50,300].
3. The last waypoint must match the customer coordinate in the user request.
4. West detour uses longitude around 106.40~106.45; east detour uses longitude around 106.75~106.80.
5. Use 5 to 7 waypoints.
6. Do not add Markdown fences or any text before <OUTPUT>.`;

function parseWaypoints(text: string): number[][] {
  // 优先从 <OUTPUT>...</OUTPUT> 标签内抓 JSON
  const outputBlock = text.match(/<OUTPUT>([\s\S]*?)<\/OUTPUT>/);
  const scanText = outputBlock ? outputBlock[1] : text;

  const isValidCoord = (arr: any[]): boolean => {
    if (arr.length < 2) return false;
    const lon = Number(arr[0]), lat = Number(arr[1]);
    return !isNaN(lon) && !isNaN(lat) && lon >= 100 && lon <= 115 && lat >= 25 && lat <= 35;
  };
  const tryParse = (jsonStr: string): number[][] => {
    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) {
        const valid = parsed.filter((p: any) => Array.isArray(p) && isValidCoord(p));
        if (valid.length >= 2) return valid.map((p: any) => [Number(p[0]), Number(p[1]), Number(p[2]) || 300]);
      }
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.routes)) {
        const valid = parsed.routes.filter((p: any) => Array.isArray(p) && isValidCoord(p));
        if (valid.length >= 2) return valid.map((p: any) => [Number(p[0]), Number(p[1]), Number(p[2]) || 300]);
      }
    } catch { /* ignore */ }
    return [];
  };
  const jsonObjMatch = scanText.match(/\{\s*"routes"\s*:\s*\[[\s\S]*?\]\s*\]/);
  if (jsonObjMatch) { const r = tryParse(jsonObjMatch[0] + "}"); if (r.length >= 2) return r; }
  const routesMatch = scanText.match(/"routes"\s*:\s*(\[[\s\S]*\]\s*\])/);
  if (routesMatch) { const r = tryParse(routesMatch[1]); if (r.length >= 2) return r; }
  const partialRoutes = scanText.match(/"routes"\s*:\s*(\[[\s\S]*)/);
  if (partialRoutes) {
    let raw = partialRoutes[1];
    raw = raw.replace(/,\s*\[\s*[\d.,\s]*$/, "");
    if (!raw.endsWith("]]")) { if (raw.endsWith("]")) raw += "]"; else raw += "]]"; }
    const r = tryParse(raw); if (r.length >= 2) return r;
  }
  const arrayRe = /\[\s*\[[\d.\s,]+\](?:\s*,\s*\[[\d.\s,]+\])+\s*\]/g;
  let arrMatch;
  while ((arrMatch = arrayRe.exec(scanText)) !== null) {
    const r = tryParse(arrMatch[0]); if (r.length >= 2) return r;
  }
  const coordPattern = /\[\s*(10[0-9]\.\d+)\s*,\s*(2[5-9]\.\d+)(?:\s*,\s*([\d.]+))?\s*\]/g;
  const coords: number[][] = [];
  let cm;
  while ((cm = coordPattern.exec(scanText)) !== null) {
    coords.push([parseFloat(cm[1]), parseFloat(cm[2]), parseFloat(cm[3]) || 300]);
  }
  if (coords.length >= 2) return coords;
  return [];
}

function fixRouteStart(waypoints: number[][], start: [number, number]): number[][] {
  if (waypoints.length < 1) return waypoints;
  const dist = (a: number[], b: number[]) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);
  const result = [...waypoints];
  if (dist(result[0], start) > 0.02) result.unshift([start[0], start[1], 300]);
  return result;
}

function buildSafeMissionRoute(target: [number, number]): number[][] {
  const sideLon = target[0] >= WAREHOUSE[0] ? 106.78 : 106.42;
  const midLat = Math.max(28.78, Math.min(28.90, (WAREHOUSE[1] + target[1]) / 2));
  return [
    [WAREHOUSE[0], WAREHOUSE[1], 300],
    [sideLon, 28.65, 300],
    [sideLon, midLat, 300],
    [target[0], target[1], 300],
  ];
}

function missionRouteReachesTarget(waypoints: number[][], target: [number, number]): boolean {
  if (waypoints.length < 2) return false;
  const last = waypoints[waypoints.length - 1];
  const dist = Math.sqrt((last[0] - target[0]) ** 2 + (last[1] - target[1]) ** 2);
  return dist < 0.08;
}

function canonicalMissionAnswer(waypoints: number[][]): string {
  return JSON.stringify({ routes: waypoints });
}

function sanitizeMissionResultText(rawText: string, missionId: number): { text: string; waypoints: number[][]; routeFallback: boolean } {
  const mission = DELIVERY_MISSIONS.find(item => item.id === missionId) || DELIVERY_MISSIONS[0];
  let waypoints = fixRouteStart(parseWaypoints(rawText), WAREHOUSE);
  const routeFallback = waypoints.length < 2 || !missionRouteReachesTarget(waypoints, mission.targetPt);
  if (routeFallback) {
    waypoints = buildSafeMissionRoute(mission.targetPt);
  }
  return {
    text: canonicalMissionAnswer(waypoints),
    waypoints,
    routeFallback,
  };
}

/* ── Types ── */
type MissionResult = {
  missionId: number;
  target: string;
  ttft: number;
  tps: number;
  text: string;
  waypoints: number[][];
  routeFallback?: boolean;
  streamText: string;
  status: "pending" | "running" | "done" | "error";
  mapAnimating: boolean;
  mapDone: boolean;
  contextTokens: number;
  outputTokens: number;
  servingTarget?: string;
  upstreamBaseUrl?: string;
  resolvedModel?: string;
};

type GroupResults = {
  avgTtft: number;
  p95Ttft: number;
  avgTps: number;
  totalTime: number;
  results: MissionResult[];
  avgContextTokens: number;
  avgOutputTokens: number;
};

type RoundSnapshot = {
  round: number;
  lm?: MissionResult[];
  ik?: MissionResult[];
};

function normalizeWaypoints(value: any): number[][] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((p: any) => Array.isArray(p) && p.length >= 2)
    .map((p: any) => [Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 300]);
}

function normalizeMissionResult(raw: any, idx = 0): MissionResult {
  const rawText = typeof raw?.text === "string" ? raw.text : (typeof raw?.streamText === "string" ? raw.streamText : "");
  const missionId = Number(raw?.missionId) || idx + 1;
  const fromText = sanitizeMissionResultText(rawText, missionId);
  const rawWaypoints = normalizeWaypoints(raw?.waypoints);
  const mission = DELIVERY_MISSIONS.find(item => item.id === missionId) || DELIVERY_MISSIONS[0];
  const rawWaypointsValid = rawWaypoints.length >= 2 && missionRouteReachesTarget(rawWaypoints, mission.targetPt);
  const waypoints = rawWaypointsValid ? rawWaypoints : fromText.waypoints;
  const routeFallback = !rawWaypointsValid || fromText.routeFallback;
  const text = canonicalMissionAnswer(waypoints);
  const status: MissionResult["status"] = raw?.status === "error"
    ? "error"
    : raw?.status === "running"
      ? "running"
      : raw?.status === "pending"
        ? "pending"
        : "done";
  return {
    missionId,
    target: typeof raw?.target === "string" ? raw.target : `节点 ${idx + 1}`,
    ttft: Number(raw?.ttft) || 0,
    tps: Number(raw?.tps) || 0,
    text,
    waypoints,
    routeFallback,
    streamText: text,
    status,
    mapAnimating: false,
    mapDone: waypoints.length >= 2,
    contextTokens: Number(raw?.contextTokens) || 0,
    outputTokens: Number(raw?.outputTokens) || 0,
  };
}

function normalizeGroupResults(raw: any): GroupResults {
  const results: MissionResult[] = Array.isArray(raw?.results)
    ? raw.results.map((item: any, idx: number) => normalizeMissionResult(item, idx))
    : [];
  const doneResults = results.filter(r => r.status === "done");
  const avgContextTokens = Number(raw?.avgContextTokens) || (doneResults.length ? Math.round(doneResults.reduce((a, b) => a + b.contextTokens, 0) / doneResults.length) : 0);
  const avgOutputTokens = Number(raw?.avgOutputTokens) || (doneResults.length ? Math.round(doneResults.reduce((a, b) => a + b.outputTokens, 0) / doneResults.length) : 0);
  return {
    avgTtft: Number(raw?.avgTtft) || 0,
    p95Ttft: Number(raw?.p95Ttft) || 0,
    avgTps: Number(raw?.avgTps) || 0,
    totalTime: Number(raw?.totalTime) || 0,
    results,
    avgContextTokens,
    avgOutputTokens,
  };
}

function normalizeRoundSnapshots(value: any): RoundSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.map((snap: any, idx: number) => ({
    round: Number(snap?.round) || idx + 1,
    lm: Array.isArray(snap?.lm) ? snap.lm.map((item: any, itemIdx: number) => normalizeMissionResult(item, itemIdx)) : undefined,
    ik: Array.isArray(snap?.ik) ? snap.ik.map((item: any, itemIdx: number) => normalizeMissionResult(item, itemIdx)) : undefined,
  }));
}

function hasReplayableDroneFleetRecord(record: TestRecord): boolean {
  const replay = record.normalizedReplay || record.results;
  const lmResults = (replay as any)?.lmcache?.results;
  const ikResults = (replay as any)?.infinikv?.results;
  const snapshots = (replay as any)?.roundSnapshots;
  return Boolean(
    (Array.isArray(lmResults) && lmResults.length > 0) ||
    (Array.isArray(ikResults) && ikResults.length > 0) ||
    (Array.isArray(snapshots) && snapshots.some((snap: any) =>
      (Array.isArray(snap?.lm) && snap.lm.length > 0) ||
      (Array.isArray(snap?.ik) && snap.ik.length > 0)
    ))
  );
}

const SCENARIO_ROUTES: Record<string, string> = {
  "long-context": "/demo/long-context", "concurrent": "/demo/concurrent", "agent": "/demo/agent",
  "drone-delivery": "/demo/drone-delivery", "drone-fleet": "/demo/drone-fleet",
};

const ROUTE_COLORS = ["#34D399", "#60A5FA", "#F472B6", "#FBBF24", "#A78BFA", "#FB923C", "#2DD4BF", "#F87171"];

/* ── Baked-in default result ──
   Rendered on first paint so the page always shows a complete comparison immediately,
   with no async fetch (this removes the "history flashes by / nothing loads" problem).
   A visitor's own newer local run still overrides it; otherwise this stays. */
const SEED_REPLAY = SEED_RECORD.results as any;
const SEED_LM: GroupResults | null = SEED_REPLAY?.lmcache ? normalizeGroupResults(SEED_REPLAY.lmcache) : null;
const SEED_IK: GroupResults | null = SEED_REPLAY?.infinikv ? normalizeGroupResults(SEED_REPLAY.infinikv) : null;
const SEED_SNAPSHOTS: RoundSnapshot[] = normalizeRoundSnapshots(SEED_REPLAY?.roundSnapshots);
const SEED_ACTIVE_ROUND = SEED_SNAPSHOTS.length > 0 ? SEED_SNAPSHOTS.length - 1 : -1;

/* ── Mission detail panel — vertical stack: header → streaming text → map ── */
function MissionDetailPanel({ result, mission, color }: { result: MissionResult; mission: typeof DELIVERY_MISSIONS[0]; color: string }) {
  const [locale] = useLocale();
  const isEn = locale === "en";
  const textRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (textRef.current) textRef.current.scrollTop = textRef.current.scrollHeight;
  }, [result.streamText]);

  const wpCount = result.waypoints.length;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* Header: mission label + metrics */}
      <div className="flex items-center space-x-2 border-b border-slate-200 bg-slate-50 px-4 py-3">
        <MapPin className="w-4 h-4" style={{ color }} />
        <span className="text-sm font-semibold text-slate-800">{isEn ? mission.targetEn : mission.target}</span>
        {result.status === "done" && (
          <div className="ml-auto flex items-center space-x-3 text-xs font-mono text-slate-500">
            <span>TTFT: <span className="font-semibold text-slate-600">{result.ttft.toFixed(3)}s</span></span>
            <span>TPS: <span className="font-semibold text-slate-600">{result.tps.toFixed(1)}</span></span>
          </div>
        )}
        {result.status === "running" && <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-600 ml-auto" />}
      </div>

      {/* Streaming text — clean neutral style, FIXED height for A|A B|B alignment */}
      <div className="p-4">
        <div className="mb-2 flex items-center space-x-2 text-xs font-semibold text-slate-500">
          <span>{result.status === "running" ? (isEn ? "Live inference output" : "实时推理输出") : result.status === "done" ? (isEn ? "Plan output complete" : "方案输出完成") : (isEn ? "Waiting to run" : "等待执行")}</span>
          {result.status === "running" && <span className="relative flex h-1.5 w-1.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75" /><span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-sky-500" /></span>}
        </div>
        <div ref={textRef} className="h-[160px] overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-700 scrollbar-hide">
          {result.streamText ? (
            <>
              <span className="whitespace-pre-wrap">{result.streamText}</span>
              {result.status === "running" && <span className="inline-block w-1.5 h-3.5 bg-sky-500 ml-0.5 align-middle animate-pulse rounded-sm" />}
            </>
          ) : result.status === "running" ? (
            <div className="flex items-center space-x-2 text-slate-400"><Loader2 className="w-3 h-3 animate-spin" /><span>{isEn ? "Waiting for first token..." : "等待首 Token..."}</span></div>
          ) : (
            <span className="text-slate-400">{isEn ? "Waiting to run" : "等待执行"}</span>
          )}
        </div>
        {/* Waypoints bridge */}
        <div className="mt-1.5 min-h-[56px]">
          {result.status === "done" && wpCount >= 2 && (
            <div className="h-full rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-emerald-700">
                  {isEn ? `Extracted ${wpCount} waypoints · flight validation` : `提取 ${wpCount} 航点 · 飞行验证`}
                </span>
              </div>
              <div className="text-[11px] font-mono text-slate-600 leading-relaxed mt-1 max-h-[72px] overflow-y-auto flex flex-wrap items-center gap-x-1.5">
                {result.waypoints.map((wp, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && <Plane className="inline-block w-2.5 h-2.5 text-slate-400" strokeWidth={2.5} />}
                    <span className="text-slate-600">[{wp[0].toFixed(2)},{wp[1].toFixed(2)}]</span>
                  </React.Fragment>
                ))}
              </div>
            </div>
          )}
          {result.status === "done" && wpCount < 2 && (
            <div className="flex h-full items-center rounded-xl border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-600">
              {isEn ? "No valid waypoint coordinates parsed" : "未解析到有效航点坐标"}
            </div>
          )}
        </div>
      </div>

      {/* Map below — bump to 340 to match scenario 04 size */}
      <div className="border-t border-slate-200 p-3">
        <div className="mb-2 text-xs font-semibold text-slate-500">
          {result.mapAnimating ? (isEn ? "Flight validation in progress..." : "配送飞行验证中...") : result.mapDone && wpCount >= 2 ? (isEn ? "Validation complete" : "验证完成") : (isEn ? "Delivery map" : "配送地图")}
        </div>
        <div className="h-[340px]">
          <TacticalMap
            launchPoint={WAREHOUSE}
            targetPoint={mission.targetPt}
            obstacleZones={OBSTACLE_ZONES}
            obstacleRadius={OBSTACLE_RADIUS}
            waypoints={result.waypoints.length >= 2 ? result.waypoints : undefined}
            animating={result.mapAnimating}
            animationDone={result.mapDone}
            routeColor={color}
            label={mission.target.split(" ")[0]}
            showStats
          />
        </div>
      </div>
    </div>
  );
}

/* ── Page ── */
export default function DroneFleetPage() {
  const router = useRouter();
  const [locale] = useLocale();
  const tr = (key: Parameters<typeof t>[1]) => t(locale, key);
  const [apiBase, setApiBase] = useState("");
  useEffect(() => { setApiBase(getApiBase()); }, []);

  const [model] = useState("llama3.1-8b-instruct");
  const modelLabel = locale === "en" ? "llama3.1-8b-instruct · 128K window" : "llama3.1-8b-instruct · 128K 窗口";
  const [outputLen, setOutputLen] = useState(1024);
  const [concurrentCount, setConcurrentCount] = useState(8);
  const [batchCount, setBatchCount] = useState(1);   // 连续跑 N 批；每批 concurrentCount 并发
  const [sessionReplica, setSessionReplica] = useState(1); // 每份档案扩成多个独立会话，逼近 stress 模式 A
  const [sessionShift, setSessionShift] = useState(4); // 每批会话窗口前移步长
  const [runLMCache, setRunLMCache] = useState(true);
  const [runInfiniKV, setRunInfiniKV] = useState(true);
  const [showConfig, setShowConfig] = useState(true);

  // ⭐ 改造核心：每节点一份专属 PDF（节点档案）。上传 N 份就有 N 个独立 session。
  // 跟 stress-test 的"多 PDF 轮询"设计逻辑一致，只是换成了"多 PDF 并发"。
  type NodeDoc = { id: string; name: string; text: string; estTokens: number };
  const [nodeDocs, setNodeDocs] = useState<NodeDoc[]>([]);
  const docInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const [isRunning, setIsRunning] = useState(false);
  const [currentGroup, setCurrentGroup] = useState<string>("");
  const [currentBatch, setCurrentBatch] = useState(0);
  const [lmResults, setLmResults] = useState<GroupResults | null>(() => SEED_LM);
  const [ikResults, setIkResults] = useState<GroupResults | null>(() => SEED_IK);
  const [lmLive, setLmLive] = useState<MissionResult[]>([]);
  const [ikLive, setIkLive] = useState<MissionResult[]>([]);
  const [roundSnapshots, setRoundSnapshots] = useState<RoundSnapshot[]>(() => SEED_SNAPSHOTS);
  const [activeRoundView, setActiveRoundView] = useState(() => SEED_ACTIVE_ROUND);

  const [showHistory, setShowHistory] = useState(false);
  const [showWorkloadInfo, setShowWorkloadInfo] = useState(false);

  useEffect(() => {
    const pending = sessionStorage.getItem("infinikv_pending_record");
    if (pending) {
      sessionStorage.removeItem("infinikv_pending_record");
      try {
        const record: TestRecord = JSON.parse(pending);
        if (record.scenario === "drone-fleet") tryLoadRecord(record);
      } catch { }
      return;
    }
    // Prefer the visitor's own most recent local run; otherwise keep the baked-in seed
    // that is already in initial state. We intentionally do NOT auto-fetch the shared
    // history here — that async load was both stale and the source of the "flash".
    const cachedLatest = getCachedLatestRecord("drone-fleet");
    if (cachedLatest && !isRunning) tryLoadRecord(cachedLatest);
  }, []);

  const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  };

  const handleDocUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    const newDocs: NodeDoc[] = [];
    for (const file of Array.from(files)) {
      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      try {
        let text = "";
        if (ext === "pdf") {
          const arr = await file.arrayBuffer();
          const fileB64 = arrayBufferToBase64(arr);
          const res = await fetch(`${apiBase}/api/attachments/extract-pdf`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: file.name, file_b64: fileB64 }),
          });
          const data = await res.json();
          if (!res.ok || !data?.text) throw new Error(data?.detail || "PDF 解析失败");
          text = String(data.text);
        } else if (ext === "txt" || ext === "md") {
          text = await file.text();
        } else {
          throw new Error(`${file.name}: 仅支持 .pdf / .txt / .md`);
        }
        newDocs.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name, text,
          estTokens: Math.floor(text.length / 1.5),
        });
      } catch (err: any) {
        alert(`文件 ${file.name} 解析失败：${err?.message}`);
      }
    }
    setNodeDocs(prev => [...prev, ...newDocs]);
    setUploading(false);
    if (docInputRef.current) docInputRef.current.value = "";
  };

  const removeNodeDoc = (id: string) => setNodeDocs(prev => prev.filter(d => d.id !== id));
  const clearAllDocs = () => setNodeDocs([]);

  const simulateStreaming = useCallback((fullText: string, missionId: number, setter: React.Dispatch<React.SetStateAction<MissionResult[]>>): Promise<void> => {
    return new Promise(resolve => {
      let idx = 0;
      const chunkSize = 4;
      const interval = 12;
      const timer = setInterval(() => {
        idx = Math.min(idx + chunkSize, fullText.length);
        setter(prev => prev.map(r => r.missionId === missionId ? { ...r, streamText: fullText.slice(0, idx) } : r));
        if (idx >= fullText.length) { clearInterval(timer); resolve(); }
      }, interval);
    });
  }, []);

  // ⭐ 每节点的 system content = 共享基线 + 该节点专属 PDF（机体档案）
  // 这是"打破共享前缀"的关键：N 个节点 = N 个独立 session，DRAM LRU 才能显效
  const MAX_DOC_CHARS = 80_000;
  const buildSystemContentForNode = (nodeIdx: number, doc: NodeDoc | undefined, sessionTag?: string): string => {
    let pfx = SHARED_SYSTEM_PROMPT;
    if (doc) {
      const docTrimmed = doc.text.length > MAX_DOC_CHARS
        ? doc.text.slice(0, MAX_DOC_CHARS) + "\n\n[…档案后续已截断]"
        : doc.text;
      pfx += `\n\n# 节点 ${nodeIdx + 1} 号专属档案（仅本节点可见：${doc.name}）\n${docTrimmed}`;
    }
    if (sessionTag) {
      pfx += `\n\n# 会话标签\n${sessionTag}`;
    }
    return pfx;
  };

  const runConcurrentGroup = async (
    group: "LMCache-DRAM" | "InfiniKV",
    setLive: React.Dispatch<React.SetStateAction<MissionResult[]>>,
    batchIdx: number,
  ): Promise<GroupResults> => {
    type VirtualSession = { id: string; doc?: NodeDoc; docName: string; sessionTag: string };
    const virtualSessions: VirtualSession[] = nodeDocs.length > 0
      ? nodeDocs.flatMap((doc, i) => Array.from({ length: Math.max(1, sessionReplica) }, (_, replicaIdx) => ({
        id: `${doc.id}::rep-${replicaIdx + 1}`,
        doc,
        docName: doc.name,
        sessionTag: `doc-${i + 1}-rep-${replicaIdx + 1}`,
      })))
      : [{ id: "shared-session", doc: undefined, docName: "shared", sessionTag: `shared-batch-${batchIdx + 1}` }];

    // 节点数 = min(上传档案数, DELIVERY_MISSIONS.length, concurrentCount)
    // 没上传档案时退化成原来的"共享 system + N 并发"，仍能工作
    const activeNodeCount = nodeDocs.length > 0
      ? Math.min(virtualSessions.length, DELIVERY_MISSIONS.length, concurrentCount)
      : concurrentCount;
    const missions = DELIVERY_MISSIONS.slice(0, activeNodeCount);
    const shift = Math.max(1, sessionShift);
    const startIdx = virtualSessions.length > 0 ? ((batchIdx * shift) % virtualSessions.length) : 0;
    const selectedSessions = Array.from({ length: activeNodeCount }, (_, idx) => {
      if (virtualSessions.length === 0) return undefined;
      return virtualSessions[(startIdx + idx) % virtualSessions.length];
    });

    const initial: MissionResult[] = missions.map(m => ({
      missionId: m.id, target: m.target, ttft: 0, tps: 0, text: "", waypoints: [],
      streamText: "", status: "running" as const, mapAnimating: false, mapDone: false,
      contextTokens: 0, outputTokens: 0,
    }));
    setLive(initial);

    const startTime = Date.now();
    const promises = missions.map(async (mission, idx) => {
      // 每节点用自己的档案做 system；批次 > 1 时在 user 内容加批次标记让后缀微变、前缀命中
      const selected = selectedSessions[idx];
      const nodeDoc = selected?.doc;
      const systemContent = buildSystemContentForNode(idx, nodeDoc, selected?.sessionTag);
      const batchTag = batchIdx > 0 ? `（批次 ${batchIdx + 1}，请换一条绕行路径）` : "";
      const userContent = `任务描述：${mission.desc}\n客户坐标：${mission.coords}（这必须是 routes 数组的最后一个点）\n会话来源：${selected?.docName || "shared"} · ${selected?.sessionTag || "shared"}${batchTag}`;
      const messages = [
        { role: "system", content: systemContent },
        { role: "user", content: userContent },
      ];
      try {
        const res = await fetch(`${apiBase}/api/benchmark/run`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model, scenario: "drone_fleet_concurrent", contextLen: 128000, contextBucket: 128000,
            prefixReuseRate: 90, concurrent: 1, outputLen, ttftSloSec: 5,
            messages, groupName: group,
          }),
        });
        const data = await res.json();
        const item = data?.data?.[0] || {};
        const rawText = item.generated_text || "(无输出)";
        const sanitized = sanitizeMissionResultText(rawText, mission.id);
        const text = sanitized.text;
        const waypoints = sanitized.waypoints;
        const routeFallback = sanitized.routeFallback;

        await simulateStreaming(text, mission.id, setLive);

        const contextTokens = item.actual_chat_input_tokens || 0;
        const outputTokens = item.usage_completion_tokens || item.outTokens || 0;
        setLive(prev => prev.map(r => r.missionId === mission.id ? {
          ...r, ttft: item.ttft || 0, tps: item.tps || 0, text, waypoints, routeFallback,
          streamText: text, status: "done" as const, mapAnimating: true,
          contextTokens, outputTokens,
        } : r));

        await new Promise<void>(resolve => setTimeout(resolve, 3500));
        setLive(prev => prev.map(r => r.missionId === mission.id ? { ...r, mapAnimating: false, mapDone: true } : r));

        return {
          missionId: mission.id, target: mission.target,
          ttft: item.ttft || 0, tps: item.tps || 0, text, waypoints, routeFallback,
          streamText: text, status: "done" as const, mapAnimating: false, mapDone: true,
          contextTokens, outputTokens,
          servingTarget: item.serving_target,
          upstreamBaseUrl: item.upstream_base_url,
          resolvedModel: item.resolved_model,
        } as MissionResult;
      } catch (err: any) {
        const errResult: MissionResult = {
          missionId: mission.id, target: mission.target, ttft: 0, tps: 0,
          text: err?.message || "error", waypoints: [], streamText: err?.message || "error",
          status: "error", mapAnimating: false, mapDone: false,
          contextTokens: 0, outputTokens: 0,
          servingTarget: undefined, upstreamBaseUrl: undefined, resolvedModel: undefined,
        };
        setLive(prev => prev.map(r => r.missionId === mission.id ? errResult : r));
        return errResult;
      }
    });

    const results = await Promise.all(promises);
    const totalTime = (Date.now() - startTime) / 1000;
    const valid = results.filter(r => r.status === "done" && r.ttft > 0);
    const ttfts = valid.map(r => r.ttft).sort((a, b) => a - b);
    const p95idx = Math.max(0, Math.ceil(ttfts.length * 0.95) - 1);

    const ctxs = valid.map(r => r.contextTokens).filter(t => t > 0);
    const outs = valid.map(r => r.outputTokens).filter(t => t > 0);
    return {
      avgTtft: valid.length ? valid.reduce((a, b) => a + b.ttft, 0) / valid.length : 0,
      p95Ttft: ttfts[p95idx] || 0,
      avgTps: valid.length ? valid.reduce((a, b) => a + b.tps, 0) / valid.length : 0,
      totalTime, results,
      avgContextTokens: ctxs.length ? Math.round(ctxs.reduce((a, b) => a + b, 0) / ctxs.length) : 0,
      avgOutputTokens: outs.length ? Math.round(outs.reduce((a, b) => a + b, 0) / outs.length) : 0,
    };
  };

  // 聚合 N 批结果：把每批的 valid results 拼起来，重算 avg/p95/avgCtx
  const aggregateBatches = (batches: GroupResults[]): GroupResults => {
    const allResults = batches.flatMap(b => b.results);
    const valid = allResults.filter(r => r.status === "done" && r.ttft > 0);
    const ttfts = valid.map(r => r.ttft).sort((a, b) => a - b);
    const p95idx = Math.max(0, Math.ceil(ttfts.length * 0.95) - 1);
    const ctxs = valid.map(r => r.contextTokens).filter(t => t > 0);
    const outs = valid.map(r => r.outputTokens).filter(t => t > 0);
    return {
      avgTtft: valid.length ? valid.reduce((a, b) => a + b.ttft, 0) / valid.length : 0,
      p95Ttft: ttfts[p95idx] || 0,
      avgTps: valid.length ? valid.reduce((a, b) => a + b.tps, 0) / valid.length : 0,
      totalTime: batches.reduce((a, b) => a + b.totalTime, 0),
      results: allResults,
      avgContextTokens: ctxs.length ? Math.round(ctxs.reduce((a, b) => a + b, 0) / ctxs.length) : 0,
      avgOutputTokens: outs.length ? Math.round(outs.reduce((a, b) => a + b, 0) / outs.length) : 0,
    };
  };

  const replayRound = (idx: number) => {
    if (isRunning) return;

    const snap = roundSnapshots[idx];
    if (!snap) return;

    const resetForReplay = (items?: MissionResult[]) => items?.map(item => ({
      ...item,
      streamText: item.text || item.streamText,
      mapAnimating: item.status === "done" && item.waypoints.length >= 2,
      mapDone: false,
      status: item.status === "error" ? ("error" as const) : ("done" as const),
    }));

    const finishReplay = (items?: MissionResult[]) => items?.map(item => ({
      ...item,
      mapAnimating: false,
      mapDone: item.status === "done" && item.waypoints.length >= 2,
    }));

    setActiveRoundView(idx);
    setRoundSnapshots(prev => prev.map((item, itemIdx) => itemIdx === idx
      ? { ...item, lm: resetForReplay(item.lm), ik: resetForReplay(item.ik) }
      : item
    ));

    window.setTimeout(() => {
      setRoundSnapshots(prev => prev.map((item, itemIdx) => itemIdx === idx
        ? { ...item, lm: finishReplay(item.lm), ik: finishReplay(item.ik) }
        : item
      ));
    }, 2800);
  };

  const runBenchmark = async () => {
    setIsRunning(true);

    setLmResults(null);
    setIkResults(null);
    setLmLive([]);
    setIkLive([]);
    setCurrentBatch(0);
    setRoundSnapshots([]);
    setActiveRoundView(-1);

    const runtimeSnapshots: RoundSnapshot[] = [];

    try {
      const lmBatches: GroupResults[] = [];
      const ikBatches: GroupResults[] = [];

      for (let b = 0; b < batchCount; b++) {
        setCurrentBatch(b);
        let lmCurrent: GroupResults | undefined;
        let ikCurrent: GroupResults | undefined;
        if (runLMCache) {
          setCurrentGroup(`LMCache-DRAM · 批 ${b + 1}/${batchCount}`);
          const lm = await runConcurrentGroup("LMCache-DRAM", setLmLive, b);
          lmCurrent = lm;
          lmBatches.push(lm);
          // 每跑完一批就更新聚合结果，UI 能实时看到 avg/p95 演变
          setLmResults(aggregateBatches(lmBatches));
        }
        if (runInfiniKV) {
          setCurrentGroup(`InfiniKV · 批 ${b + 1}/${batchCount}`);
          const ik = await runConcurrentGroup("InfiniKV", setIkLive, b);
          ikCurrent = ik;
          ikBatches.push(ik);
          setIkResults(aggregateBatches(ikBatches));
        }
        const snapshot: RoundSnapshot = { round: b + 1, lm: lmCurrent?.results, ik: ikCurrent?.results };
        runtimeSnapshots.push(snapshot);
        setRoundSnapshots(prev => [...prev, snapshot]);
      }
      if (batchCount > 0) {
        setActiveRoundView(batchCount - 1);
      }
      setCurrentGroup("");

      const finalLm = runLMCache && lmBatches.length > 0 ? aggregateBatches(lmBatches) : null;
      const finalIk = runInfiniKV && ikBatches.length > 0 ? aggregateBatches(ikBatches) : null;
      if (finalLm) setLmResults(finalLm);
      if (finalIk) setIkResults(finalIk);

      if (finalLm || finalIk) {
        await saveRecord({
          scenario: "drone-fleet", scenarioLabel: "多无人机并发航线规划",
          config: {
            concurrentCount, batchCount, sessionReplica, sessionShift, outputLen, runLMCache, runInfiniKV,
            nodeDocNames: nodeDocs.map(d => d.name),
            nodeDocTokensTotal: nodeDocs.reduce((a, d) => a + d.estTokens, 0),
          },
          results: {
            lmcache: finalLm ? {
              avgTtft: finalLm.avgTtft,
              p95Ttft: finalLm.p95Ttft,
              avgTps: finalLm.avgTps,
              totalTime: finalLm.totalTime,
              avgContextTokens: finalLm.avgContextTokens,
              avgOutputTokens: finalLm.avgOutputTokens,
              results: finalLm.results,
            } : null,
            infinikv: finalIk ? {
              avgTtft: finalIk.avgTtft,
              p95Ttft: finalIk.p95Ttft,
              avgTps: finalIk.avgTps,
              totalTime: finalIk.totalTime,
              avgContextTokens: finalIk.avgContextTokens,
              avgOutputTokens: finalIk.avgOutputTokens,
              results: finalIk.results,
            } : null,
            roundSnapshots: runtimeSnapshots,
            activeRoundView: runtimeSnapshots.length > 0 ? runtimeSnapshots.length - 1 : -1,
          },
        });
      }
    } catch (err: any) {
      alert(`错误: ${err?.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const handleNavigateAndLoad = (record: TestRecord) => {
    sessionStorage.setItem("infinikv_pending_record", JSON.stringify(record));
    const route = SCENARIO_ROUTES[record.scenario];
    if (route) router.push(route);
  };
  const tryLoadRecord = (record: TestRecord) => {
    if (!hasReplayableDroneFleetRecord(record)) return false;
    handleLoadRecord(record);
    return true;
  };

  const handleLoadRecord = (record: TestRecord) => {
    const replay = record.normalizedReplay || record.results;
    const loadedLm = replay?.lmcache ? normalizeGroupResults(replay.lmcache as any) : null;
    const loadedIk = replay?.infinikv ? normalizeGroupResults(replay.infinikv as any) : null;

    if (record.config?.concurrentCount) setConcurrentCount(record.config.concurrentCount);
    if (record.config?.batchCount) setBatchCount(record.config.batchCount);
    if (record.config?.outputLen) setOutputLen(record.config.outputLen);
    if (typeof record.config?.sessionReplica === "number") setSessionReplica(record.config.sessionReplica);
    if (typeof record.config?.sessionShift === "number") setSessionShift(record.config.sessionShift);

    // 历史记录里可能没有保存 runLMCache / runInfiniKV 开关。
    // 这里优先使用历史配置；老记录则按实际是否有结果自动打开对应列，避免加载后页面空白。
    setRunLMCache(typeof record.config?.runLMCache === "boolean" ? record.config.runLMCache : Boolean(loadedLm));
    setRunInfiniKV(typeof record.config?.runInfiniKV === "boolean" ? record.config.runInfiniKV : Boolean(loadedIk));
    let loadedSnapshots = normalizeRoundSnapshots((replay as any)?.roundSnapshots);
    if (loadedSnapshots.length === 0) {
      const fallbackLm = loadedLm?.results || [];
      const fallbackIk = loadedIk?.results || [];
      if (fallbackLm.length > 0 || fallbackIk.length > 0) {
        const pickLatestPerMission = (results: MissionResult[]) => {
          const map = new Map<number, MissionResult>();
          results.forEach(item => map.set(item.missionId, {
            ...item,
            streamText: item.text || item.streamText,
            mapAnimating: false,
            mapDone: item.waypoints.length >= 2,
            status: item.status === "error" ? ("error" as const) : ("done" as const),
          }));
          return Array.from(map.values()).sort((a, b) => a.missionId - b.missionId);
        };
        loadedSnapshots = [{
          round: 1,
          lm: pickLatestPerMission(fallbackLm),
          ik: pickLatestPerMission(fallbackIk),
        }];
      }
    }
    const storedActiveRoundView = typeof (replay as any)?.activeRoundView === "number"
      ? Number((replay as any).activeRoundView)
      : undefined;
    const nextActiveRoundView = loadedSnapshots.length > 0
      ? Math.max(0, Math.min(storedActiveRoundView ?? (loadedSnapshots.length - 1), loadedSnapshots.length - 1))
      : -1;

    setLmResults(loadedLm);
    setIkResults(loadedIk);
    setRoundSnapshots(loadedSnapshots);
    setActiveRoundView(nextActiveRoundView);
    setLmLive([]);
    setIkLive([]);
    setIsRunning(false);
    setCurrentGroup("");
    setCurrentBatch(loadedSnapshots.length);
    setShowHistory(false);
  };

  // UI 渲染用：实际节点数 = min(上传档案数 或 concurrentCount)
  const effectiveNodeCount = nodeDocs.length > 0
    ? Math.min(Math.max(1, sessionReplica) * nodeDocs.length, DELIVERY_MISSIONS.length, concurrentCount)
    : concurrentCount;
  const virtualSessionPoolSize = nodeDocs.length > 0 ? nodeDocs.length * Math.max(1, sessionReplica) : 1;
  const viewedRound = activeRoundView >= 0 ? roundSnapshots[activeRoundView] : undefined;
  const lmDisplay = isRunning
    ? lmLive
    : (viewedRound?.lm || lmResults?.results || []);
  const ikDisplay = isRunning
    ? ikLive
    : (viewedRound?.ik || ikResults?.results || []);
  const maxDisplayedMissionId = Math.max(
    0,
    ...lmDisplay.map(item => item.missionId || 0),
    ...ikDisplay.map(item => item.missionId || 0),
  );
  const displayNodeCount = Math.min(DELIVERY_MISSIONS.length, Math.max(effectiveNodeCount, lmDisplay.length, ikDisplay.length, maxDisplayedMissionId));
  const missions = DELIVERY_MISSIONS.slice(0, displayNodeCount);
  const lmAvgContextTokens = lmResults?.avgContextTokens || 0;
  const ikAvgContextTokens = ikResults?.avgContextTokens || 0;
  const contextNodeMultiplier = Math.max(1, displayNodeCount || effectiveNodeCount || concurrentCount);
  const lmWorksetTokens = lmAvgContextTokens > 0 ? lmAvgContextTokens * contextNodeMultiplier : 0;
  const ikWorksetTokens = ikAvgContextTokens > 0 ? ikAvgContextTokens * contextNodeMultiplier : 0;
  const contextSubtitleBase = isRunning
    ? locale === "en"
      ? `batch ${currentBatch + 1}/${batchCount} · ${concurrentCount} concurrent nodes · session pool ${virtualSessionPoolSize}`
      : `批 ${currentBatch + 1}/${batchCount} · ${concurrentCount} 节点并发 · 会话池 ${virtualSessionPoolSize}`
    : locale === "en"
      ? `${batchCount} batches × ${effectiveNodeCount} nodes${nodeDocs.length > 0 ? ` · ${nodeDocs.length} profiles · session pool ${virtualSessionPoolSize}` : " · shared prefix"}`
      : `${batchCount} 批 × ${effectiveNodeCount} 节点${nodeDocs.length > 0 ? ` · 档案 ${nodeDocs.length} 份 · 会话池 ${virtualSessionPoolSize}` : " · 共享前缀"}`;
  const contextPressureSubtitle =
    lmAvgContextTokens > 0 || ikAvgContextTokens > 0
      ? locale === "en"
        ? `${contextSubtitleBase} · per-node avg LM ${fmtCompactTokens(lmAvgContextTokens)} / IK ${fmtCompactTokens(ikAvgContextTokens)} · ${contextNodeMultiplier}-node KV working set approx. LM ${fmtCompactTokens(lmWorksetTokens)} / IK ${fmtCompactTokens(ikWorksetTokens)}`
        : `${contextSubtitleBase} · 单节点平均 LM ${fmtCompactTokens(lmAvgContextTokens)} / IK ${fmtCompactTokens(ikAvgContextTokens)} · ${contextNodeMultiplier} 节点合计 KV 工作集约 LM ${fmtCompactTokens(lmWorksetTokens)} / IK ${fmtCompactTokens(ikWorksetTokens)}`
      : contextSubtitleBase;
  const lmChartResults = viewedRound?.lm || lmResults?.results || [];
  const ikChartResults = viewedRound?.ik || ikResults?.results || [];

  const ttftChartData = lmResults || ikResults ? [
    { name: "Avg TTFT", lmcache: lmResults?.avgTtft || 0, infinikv: ikResults?.avgTtft || 0 },
    { name: "P95 TTFT", lmcache: lmResults?.p95Ttft || 0, infinikv: ikResults?.p95Ttft || 0 },
  ] : [];
  const tpsChartData = lmResults || ikResults ? [
    { name: "Avg TPS", lmcache: lmResults?.avgTps || 0, infinikv: ikResults?.avgTps || 0 },
  ] : [];
  const lmDoneCount = lmResults?.results.filter(r => r.status === "done").length || 0;
  const ikDoneCount = ikResults?.results.filter(r => r.status === "done").length || 0;
  const lmTotalTtft = (lmResults?.avgTtft || 0) * lmDoneCount;
  const ikTotalTtft = (ikResults?.avgTtft || 0) * ikDoneCount;
  const lmQps = lmResults && lmResults.totalTime > 0 ? lmDoneCount / lmResults.totalTime : 0;
  const ikQps = ikResults && ikResults.totalTime > 0 ? ikDoneCount / ikResults.totalTime : 0;
  const qpsChartData = lmResults || ikResults ? [
    { name: locale === "en" ? "Est. QPS" : "估算 QPS", lmcache: lmQps || 0, infinikv: ikQps || 0 },
  ] : [];
  const qpsGain = lmQps > 0 && ikQps > 0 ? ((ikQps / lmQps) - 1) * 100 : 0;
  const ttftSpeedupOverall = lmResults && ikResults && lmResults.avgTtft > 0 && ikResults.avgTtft > 0 ? lmResults.avgTtft / ikResults.avgTtft : 0;
  const qpsSpeedupOverall = lmQps > 0 && ikQps > 0 ? ikQps / lmQps : 0;

  /* Header bar for one column (LMCache or InfiniKV) */
  const renderColumnHeader = (groupLabel: string, dotColor: string, accentBg: string, display: MissionResult[]) => {
    const running = display.filter(r => r.status === "running").length;
    const done = display.filter(r => r.status === "done").length;
    return (
      <div className={`sticky top-16 z-10 flex items-center space-x-2 rounded-2xl border px-5 py-3 shadow-sm backdrop-blur-md ${accentBg}`}>
        <div className={`w-3 h-3 rounded-full ${dotColor}`} />
        <span className="text-sm font-black text-slate-900">{groupLabel}</span>
        {display.length > 0 && (
          <span className="ml-auto font-mono text-xs text-slate-500">{done}/{display.length} {locale === "en" ? "done" : "完成"}{running > 0 ? ` · ${running} ${locale === "en" ? "running" : "执行中"}` : ""}</span>
        )}
      </div>
    );
  };

  // Demo view hides the live test-configuration panel and run button (presentation mode).
  const SHOW_CONFIG_PANEL = false;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-7xl space-y-8 px-4 py-10 sm:px-6 lg:px-8">

        {/* Header */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center space-x-3 mb-3">
              <span className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-sm font-bold text-slate-700 shadow-sm">{tr("demo.multi.badge")}</span>
              <span className="text-sm font-medium text-slate-500">{tr("demo.multi.tagline")}</span>
            </div>
            <h1 className="flex items-center space-x-3 text-4xl font-black tracking-tight text-slate-900">
              <Share2 className="h-8 w-8 text-sky-600" />
              <span>{tr("demo.multi.title")}</span>
            </h1>
            <p className="text-slate-500 text-base mt-2 leading-relaxed max-w-5xl">
              <span className="font-semibold text-slate-900">{tr("demo.multi.description.nodes")}</span>{tr("demo.multi.description.a")}<span className="font-semibold text-slate-700">{tr("demo.multi.description.cache")}</span>{tr("demo.multi.description.b")}<span className="font-semibold text-slate-600">{tr("demo.multi.description.dram")}</span>{tr("demo.multi.description.c")}<span className="text-sky-700 font-semibold">{tr("demo.multi.description.ssd")}</span>{tr("demo.multi.description.d")}
            </p>
          </div>
          <div className="flex flex-shrink-0 items-center space-x-2">
            <button onClick={() => setShowWorkloadInfo(true)} className="flex items-center space-x-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50">
              <Zap className="w-4 h-4" /><span>{tr("demo.common.info")}</span>
            </button>
            <button onClick={() => setShowHistory(true)} className="flex items-center space-x-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50">
              <Clock className="w-4 h-4" /><span>{tr("demo.common.history")}</span>
            </button>
          </div>
        </div>

        <PlanningTransitionPanel />
        <CostBenefitPanel />
        <ExperimentConfigPanel workloadLabel={tr("demo.multi.workload")} />

        <MetricDefinitionPanel />

        {(lmResults || ikResults) && (
          <ModelMetricsPanel
            title={locale === "en" ? "Key Metrics: Performance Stability under Multi-Drone Concurrency" : "关键指标：多无人机并发下的性能稳定性"}
            model={modelLabel}
            lm={{
              label: "LMCache-DRAM",
              avgTtft: lmResults?.avgTtft || 0,
              totalTtft: lmTotalTtft,
              qps: lmQps,
              avgInputTokens: lmResults?.avgContextTokens || 0,
              avgOutputTokens: lmResults?.avgOutputTokens || 0,
              accent: "orange",
            }}
            ik={{
              label: "InfiniKV (SSD)",
              avgTtft: ikResults?.avgTtft || 0,
              totalTtft: ikTotalTtft,
              qps: ikQps,
              avgInputTokens: ikResults?.avgContextTokens || 0,
              avgOutputTokens: ikResults?.avgOutputTokens || 0,
              accent: "sky",
            }}
            qpsGainPct={qpsGain}
          />
        )}

        {/* Config (hidden in demo view) */}
        {SHOW_CONFIG_PANEL && (
          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
            <button onClick={() => setShowConfig(!showConfig)} className="flex w-full items-center justify-between px-6 py-4 text-base font-black text-slate-900 transition-colors hover:bg-slate-50">
              <span>{locale === "en" ? "Test Configuration" : "测试配置"}</span>
              <ChevronDown className={`w-5 h-5 text-slate-400 transition-transform ${showConfig ? "rotate-180" : ""}`} />
            </button>
            {showConfig && (
              <div className="space-y-5 border-t border-slate-200 px-6 pb-6 pt-5">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                  <div className="mb-3 flex items-center space-x-2"><Info className="h-4 w-4 text-sky-600" /><span className="text-sm font-black text-slate-800">{locale === "en" ? "Scenario Notes" : "场景说明"}</span></div>
                  <div className="text-sm text-slate-500 leading-relaxed">
                    {locale === "en" ? (
                      <>The dispatch center sends multiple drones to different delivery tasks at the same time. <span className="font-semibold text-sky-700">Each drone can carry an independent profile</span>, such as sensor calibration, no-fly clauses, and maintenance logs, so each node becomes an independent session. N concurrent nodes create N active KV Cache working sets. As batches increase, the DRAM baseline is more likely to evict early-node KV Cache, while InfiniKV keeps and revisits those caches through SSD.</>
                    ) : (
                      <>模拟调度中心同时派遣多架无人机执行不同配送任务。<span className="font-semibold text-sky-700">每架无人机携带一份独立机体档案</span>（传感器校准记录、限飞条款、历史维修日志等），因此每个节点都是独立 session；N 个节点并发就会形成 N 份活跃 KV Cache 工作集。当批次数增加后，DRAM 基线更容易淘汰早期节点的 KV Cache；InfiniKV 则通过 SSD 层保留并重访这些缓存。</>
                    )}
                  </div>
                </div>

                {/* ⭐ 每节点一份专属 PDF：批量上传后每个节点绑定一份，N = 上传份数
                  这打破了共享前缀 → N 路并发真正拉动 DRAM，跟 stress-test 模式 A 相呼应 */}
                <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <Paperclip className="h-4 w-4 text-sky-600" />
                      <span className="text-sm font-black text-slate-800">{locale === "en" ? "Per-Node Profiles (Batch Upload)" : "每节点专属档案（批量上传）"}</span>
                      <span className="text-xs text-slate-500">{locale === "en" ? "- upload N documents to form N independent session working sets" : "— 上传 N 份资料，形成 N 个独立 session 工作集"}</span>
                    </div>
                    {nodeDocs.length > 0 && (
                      <button onClick={clearAllDocs} className="text-xs text-slate-400 hover:text-red-600 flex items-center space-x-1">
                        <X className="w-3.5 h-3.5" /><span>{locale === "en" ? "Clear All" : "清空全部"}</span>
                      </button>
                    )}
                  </div>
                  <div className="flex items-start gap-3">
                    <button
                      onClick={() => docInputRef.current?.click()}
                      disabled={uploading}
                      className="flex flex-shrink-0 items-center rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 shadow-sm transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {uploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Paperclip className="w-4 h-4 mr-2" />}
                      {uploading ? locale === "en" ? "Parsing..." : "解析中..." : locale === "en" ? "Batch Upload PDF / TXT / MD" : "批量上传 PDF / TXT / MD"}
                    </button>
                    <input type="file" ref={docInputRef} className="hidden" accept=".txt,.md,.pdf" multiple onChange={handleDocUpload} />
                    <div className="flex-1 flex flex-wrap gap-1.5">
                      {nodeDocs.length === 0 && (
                        <span className="text-sm text-slate-400 py-2">{locale === "en" ? "No upload yet. All nodes only share the base system prompt, so the working set is smaller and DRAM eviction is harder to trigger." : "未上传——所有节点只共享基础系统 Prompt，工作集较小，难以触发 DRAM 淘汰"}</span>
                      )}
                      {nodeDocs.map((d, i) => (
                        <div key={d.id} className="flex items-center space-x-1.5 rounded-lg border border-sky-100 bg-sky-50 px-2 py-1 text-xs font-medium text-sky-700">
                          <span className="font-mono font-bold text-sky-700">#{i + 1}</span>
                          <span className="max-w-[140px] truncate" title={d.name}>{d.name}</span>
                          <span className="font-mono text-sky-500">{(d.estTokens / 1000).toFixed(1)}K</span>
                          <button onClick={() => removeNodeDoc(d.id)} className="text-slate-400 hover:text-red-600"><X className="w-3 h-3" /></button>
                        </div>
                      ))}
                    </div>
                  </div>
                  {nodeDocs.length > 0 && (
                    <div className="text-xs text-slate-500">
                      {locale === "en" ? <>Uploaded <span className="font-bold text-sky-700">{nodeDocs.length}</span> profiles. This run will use <span className="font-bold text-slate-900">{effectiveNodeCount}</span> independent node working sets, limited by concurrent node count and DELIVERY_MISSIONS.</> : <>已上传 <span className="font-bold text-sky-700">{nodeDocs.length}</span> 份档案，本次压测将启用 <span className="font-bold text-slate-900">{effectiveNodeCount}</span> 个独立节点工作集（受"并发节点数"与 DELIVERY_MISSIONS 数量限制）。</>}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
                  <div>
                    <label className="mb-1.5 block text-sm font-semibold text-slate-500">{locale === "en" ? "Concurrent Nodes" : "并发节点数"}</label>
                    <select className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-900 outline-none transition-colors focus:border-sky-300 focus:ring-2 focus:ring-sky-100" value={concurrentCount} onChange={e => setConcurrentCount(Number(e.target.value))}>
                      <option value={4}>{locale === "en" ? "4 concurrent nodes" : "4 节点并发"}</option>
                      <option value={8}>{locale === "en" ? "8 concurrent nodes" : "8 节点并发"}</option>
                      <option value={16}>{locale === "en" ? "16 concurrent nodes · enlarged working set" : "16 节点并发 · 工作集放大"}</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-semibold text-slate-500">{locale === "en" ? "Batch Count" : "连续批次数"}</label>
                    <select className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-900 outline-none transition-colors focus:border-sky-300 focus:ring-2 focus:ring-sky-100" value={batchCount} onChange={e => setBatchCount(Number(e.target.value))}>
                      <option value={1}>{locale === "en" ? "1 batch (single burst)" : "1 批（单次并发）"}</option>
                      <option value={3}>{locale === "en" ? "3 batches · warm cache" : "3 批 · 缓存预热"}</option>
                      <option value={5}>{locale === "en" ? "5 batches · observe hot-cache effect" : "5 批 · 观察热效应"}</option>
                      <option value={10}>{locale === "en" ? "10 batches · trigger capacity pressure" : "10 批 · 触发容量压力"}</option>
                      <option value={30}>{locale === "en" ? "30 batches · observe eviction revisits" : "30 批 · 观察淘汰重访"}</option>
                      <option value={50}>{locale === "en" ? "50 batches · near steady-state stress" : "50 批 · 接近稳态压测"}</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-semibold text-slate-500">{locale === "en" ? "Session Replicas / Profile" : "每档案会话副本"}</label>
                    <select className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-900 outline-none transition-colors focus:border-sky-300 focus:ring-2 focus:ring-sky-100" value={sessionReplica} onChange={e => setSessionReplica(Number(e.target.value))}>
                      <option value={1}>{locale === "en" ? "1 (original)" : "1（原始）"}</option>
                      <option value={2}>{locale === "en" ? "2 (light pressure)" : "2（轻压）"}</option>
                      <option value={4}>{locale === "en" ? "4 (recommended)" : "4（推荐）"}</option>
                      <option value={8}>{locale === "en" ? "8 (heavy pressure)" : "8（强压）"}</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-semibold text-slate-500">{locale === "en" ? "Batch Rotation Step" : "批次轮换步长"}</label>
                    <select className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-900 outline-none transition-colors focus:border-sky-300 focus:ring-2 focus:ring-sky-100" value={sessionShift} onChange={e => setSessionShift(Number(e.target.value))}>
                      <option value={1}>{locale === "en" ? "1 · finest granularity" : "1 · 最细粒度"}</option>
                      <option value={2}>{locale === "en" ? "2 · common" : "2 · 常用"}</option>
                      <option value={4}>{locale === "en" ? "4 · recommended" : "4 · 推荐"}</option>
                      <option value={8}>{locale === "en" ? "8 · wider jump" : "8 · 大跨度"}</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-semibold text-slate-500">{locale === "en" ? "Output Tokens / Node" : "每节点输出 Token"}</label>
                    <input className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-900 outline-none transition-colors focus:border-sky-300 focus:ring-2 focus:ring-sky-100" type="number" value={outputLen} onChange={e => setOutputLen(Number(e.target.value || 512))} />
                  </div>
                  <div className="flex items-end gap-4 text-sm text-slate-700 md:col-span-2">
                    <label className="flex items-center space-x-2 cursor-pointer">
                      <input type="checkbox" checked={runLMCache} onChange={e => setRunLMCache(e.target.checked)} className="accent-amber-500 w-4 h-4" />
                      <span className="flex items-center space-x-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-500" /><span className="font-medium">LMCache-DRAM</span></span>
                    </label>
                    <label className="flex items-center space-x-2 cursor-pointer">
                      <input type="checkbox" checked={runInfiniKV} onChange={e => setRunInfiniKV(e.target.checked)} className="accent-sky-500 w-4 h-4" />
                      <span className="flex items-center space-x-1.5"><span className="w-2.5 h-2.5 rounded-full bg-sky-500" /><span className="font-medium">InfiniKV (SSD)</span></span>
                    </label>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-black text-slate-800">{locale === "en" ? "Shared System Prompt (city prefix shared by all nodes)" : "共享系统 Prompt（所有节点共用的城市长前缀）"}</div>
                  <div className="max-h-[220px] overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <pre className="text-xs font-mono text-slate-700 whitespace-pre-wrap leading-relaxed">{locale === "en" ? SHARED_SYSTEM_PROMPT_EN : SHARED_SYSTEM_PROMPT}</pre>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Run (hidden in demo view) */}
        {SHOW_CONFIG_PANEL && (
          <button onClick={runBenchmark} disabled={isRunning}
            className="flex items-center rounded-xl bg-slate-900 px-10 py-3.5 text-base font-black text-white shadow-sm transition-all hover:bg-slate-800 hover:shadow-lg active:scale-[0.98] disabled:opacity-40">
            {isRunning ? <Loader2 className="w-5 h-5 mr-2 animate-spin" /> : <Play className="w-5 h-5 mr-2" />}
            {isRunning
              ? locale === "en" ? `${currentGroup} running...` : `${currentGroup} 执行中...`
              : locale === "en" ? `Start ${batchCount} batches x ${concurrentCount} concurrent nodes` : `开始 ${batchCount} 批 × ${concurrentCount} 节点并发规划`}
          </button>
        )}

        {/* Per-mission TTFT chart */}
        {(lmResults || ikResults) && (
          <div className="bg-white border border-slate-200 rounded-2xl p-8 shadow-sm">
            <div className="mb-6">
              <h3 className="text-xl font-black text-slate-900 mb-1 tracking-tight text-center">{locale === "en" ? "Per-Node TTFT Comparison" : "各节点 TTFT（首字延迟） 对比"}</h3>
              {/* <p className="text-base text-slate-500 text-center">{locale === "en" ? "First-token latency comparison for each concurrent node" : "每个并发节点的首字延迟对比"}</p> */}
              <div className="mt-3 flex justify-center w-full">
                <LegendChips
                  className="justify-center"
                  items={[
                    { label: "LMCache-DRAM", colorClass: "bg-orange-50 border-orange-200", textClass: "text-orange-700" },
                    { label: "InfiniKV (SSD)", colorClass: "bg-sky-50 border-sky-200", textClass: "text-sky-700" },
                  ]}
                />
              </div>
            </div>
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={missions.map(m => ({
                name: locale === "en" ? m.targetEn : m.target,
                lmcache: lmChartResults.find(r => r.missionId === m.id)?.ttft || 0,
                infinikv: ikChartResults.find(r => r.missionId === m.id)?.ttft || 0,
              }))} margin={{ top: 10, right: 30, left: 28, bottom: 44 }}>
                <CartesianGrid vertical={false} stroke="#F3F4F6" strokeDasharray="4 4" />
                <XAxis dataKey="name" stroke="transparent" tickLine={false} axisLine={false} dy={10} interval={0} tick={{ fill: "#4B5563", fontSize: 12, fontWeight: 600 }}
                  label={{ value: locale === "en" ? "Delivery node" : "配送节点", position: "insideBottom", offset: -25, fill: "#475569", fontSize: 15, fontWeight: 700 }} />
                <YAxis stroke="transparent" tickLine={false} axisLine={false} width={56} tick={{ fill: "#6B7280", fontSize: 15 }} unit="s"
                  label={{ value: locale === "en" ? "TTFT (s)" : "TTFT (秒)", angle: -90, position: "insideLeft", fill: "#475569", fontSize: 15, fontWeight: 700, dx: -2 }} />
                <Tooltip contentStyle={{ backgroundColor: "#fff", border: "none", borderRadius: "12px", fontSize: "14px", padding: "14px 18px", boxShadow: "0 8px 30px rgba(0,0,0,0.12)" }} />
                {runLMCache && <Bar dataKey="lmcache" name="LMCache-DRAM" fill="#F97316" radius={[6, 6, 0, 0]} barSize={28} />}
                {runInfiniKV && <Bar dataKey="infinikv" name="InfiniKV (SSD)" fill="#0EA5E9" radius={[6, 6, 0, 0]} barSize={28} />}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Per-round route planning trajectories */}
        {(lmDisplay.length > 0 || ikDisplay.length > 0) && (
          <div className="space-y-4">
            <div className="flex flex-col gap-1">
              <h3 className="text-xl font-black text-slate-900 tracking-tight">{locale === "en" ? "Per-Round Route Planning Trajectories" : "每一轮航线规划轨迹"}</h3>
              <p className="text-sm text-slate-500">{locale === "en" ? "Each node plans a route around the no-fly zone; pick a round to replay its concurrent plans." : "每个节点规划一条绕开禁飞区的航线；选择某一轮可回放该轮的并发规划。"}</p>
            </div>
            {roundSnapshots.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
                {roundSnapshots.map((snap, idx) => (
                  <button key={snap.round} onClick={() => replayRound(idx)} disabled={isRunning}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-bold transition-colors ${idx === activeRoundView ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"} ${isRunning ? "cursor-not-allowed opacity-50" : ""}`}>
                    {locale === "en" ? `Batch ${snap.round}` : `第 ${snap.round} 轮`}
                  </button>
                ))}
              </div>
            )}
            <div className={`grid gap-4 ${runLMCache && runInfiniKV ? "grid-cols-1 xl:grid-cols-2" : "grid-cols-1"}`}>
              {runLMCache && (
                <div className="space-y-3">
                  {renderColumnHeader("LMCache-DRAM", "bg-orange-500", "border-orange-200 bg-orange-50/80", lmDisplay)}
                  <div className="space-y-3">
                    {missions.map((m, idx) => {
                      const result = lmDisplay.find(r => r.missionId === m.id);
                      if (!result) return null;
                      return <MissionDetailPanel key={`lm-${m.id}`} result={result} mission={m} color={ROUTE_COLORS[idx % ROUTE_COLORS.length]} />;
                    })}
                  </div>
                </div>
              )}
              {runInfiniKV && (
                <div className="space-y-3">
                  {renderColumnHeader("InfiniKV (SSD)", "bg-sky-500", "border-sky-200 bg-sky-50/80", ikDisplay)}
                  <div className="space-y-3">
                    {missions.map((m, idx) => {
                      const result = ikDisplay.find(r => r.missionId === m.id);
                      if (!result) return null;
                      return <MissionDetailPanel key={`ik-${m.id}`} result={result} mission={m} color={ROUTE_COLORS[idx % ROUTE_COLORS.length]} />;
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <HistoryModal open={showHistory} onClose={() => setShowHistory(false)} currentScenario="drone-fleet" onLoadRecord={tryLoadRecord} onNavigateAndLoad={handleNavigateAndLoad} />
      <WorkloadInfoModal open={showWorkloadInfo} onClose={() => setShowWorkloadInfo(false)} scenario="drone-fleet" />
    </div>
  );
}
