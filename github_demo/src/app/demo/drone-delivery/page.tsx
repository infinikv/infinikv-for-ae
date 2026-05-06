"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2,
  ChevronDown,
  Info,
  Clock,
  Zap,
  Package,
  MapPin,
  Building2,
  Plane,
  Paperclip,
} from "lucide-react";
import { getCachedLatestRecord, getHistory, saveRecord, type TestRecord } from "@/lib/history";
import HistoryModal from "@/components/HistoryModal";
import WorkloadInfoModal from "@/components/WorkloadInfoModal";
import ContextTokenBar from "@/components/ContextTokenBar";
import LegendChips from "@/components/LegendChips";
import TacticalMap from "@/components/TacticalMap";
import type { ObstacleZone } from "@/components/TacticalMap";
import {
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { getApiBase } from "@/lib/api";
import { t, useLocale } from "@/lib/i18n";

/* ── ComparisonBadge ── */
function ComparisonBadge({
  lmValue,
  ikValue,
  lowerIsBetter = true,
}: {
  lmValue: number;
  ikValue: number;
  lowerIsBetter?: boolean;
}) {
  const [locale] = useLocale();
  if (!lmValue || !ikValue || lmValue <= 0 || ikValue <= 0) return null;
  const multiplier = lowerIsBetter ? lmValue / ikValue : ikValue / lmValue;
  if (multiplier >= 0.97 && multiplier <= 1.03)
    return (
      <span className="inline-block text-xs font-bold px-1.5 py-0.5 rounded mt-1 bg-gray-50 text-gray-500">
        {locale === "en" ? "About the same" : "基本持平"}
      </span>
    );
  if (multiplier <= 1) return null;
  return (
    <span className="inline-block text-xs font-bold px-1.5 py-0.5 rounded mt-1 bg-green-50 text-green-600">
      {locale === "en" ? `Speedup ${multiplier.toFixed(1)}x` : `性能提升 ${multiplier.toFixed(1)}x`}
    </span>
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
              ? "Both systems receive the same city documents, delivery constraints, and multi-round strategy questions. LMCache-DRAM uses 64GB DRAM as the baseline, while InfiniKV uses 512GB SSD as the extension tier. The key question is whether InfiniKV keeps TTFT more stable and improves estimated QPS as context and history accumulate."
              : "两套系统接收相同的城市资料、配送约束和多轮策略问题。LMCache-DRAM 使用 64GB DRAM 作为基线，InfiniKV 使用 512GB SSD 作为扩展层。重点观察长上下文与历史轮次累积后，InfiniKV 是否能让 TTFT 更稳定，并提升估算 QPS。"}
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
            helper={isEn ? `Formula: InfiniKV QPS / LM QPS, about ${qpsGainText}` : `计算：InfiniKV QPS ÷ LM QPS，约 ${qpsGainText}`}
          />
        </div>
      </div>

      <div className="space-y-4">
        <div className="rounded-2xl border border-orange-200 bg-orange-50/30 p-3 md:p-4 shadow-sm">
          <div className="grid grid-cols-1 xl:grid-cols-[170px_repeat(5,minmax(0,1fr))] gap-3 items-stretch">
            <div className="flex xl:flex-col items-center xl:items-start justify-between xl:justify-center gap-2 rounded-xl bg-white border border-slate-200 border-l-4 border-l-orange-500 px-4 py-4 shadow-sm">
              <div>
                <div className="inline-flex items-center rounded-full border border-orange-200 bg-orange-50 px-2 py-0.5 text-[11px] font-black text-orange-700 mb-2">
                  Baseline
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
              sub={isEn ? "Lower is better" : "越低越好"}
              highlight
              accent="orange"
            />
            <MetricCell
              label={isEn ? "Estimated QPS" : "估算 QPS"}
              value={fmtQps(lm.qps)}
              sub={isEn ? "Higher is better" : "越高越好"}
              highlight
              accent="orange"
            />
            <MetricCell
              label={isEn ? "Total TTFT" : "累计 TTFT"}
              value={fmtSeconds(lm.totalTtft, 2)}
              sub={isEn ? "Sum of first-token wait across all rounds" : "所有轮次首字等待累计"}
              accent="orange"
            />
            <MetricCell
              label={isEn ? "Avg Input" : "平均输入"}
              value={fmtTokens(lm.avgInputTokens)}
              sub={isEn ? "prompt tokens per round" : "每轮 prompt token"}
              accent="orange"
            />
            <MetricCell
              label={isEn ? "Avg Output" : "平均输出"}
              value={fmtTokens(lm.avgOutputTokens)}
              sub={isEn ? "completion tokens per round" : "每轮 completion token"}
              accent="orange"
            />
          </div>
        </div>

        <div className="rounded-2xl border border-sky-200 bg-sky-50/30 p-3 md:p-4 shadow-sm">
          <div className="grid grid-cols-1 xl:grid-cols-[170px_repeat(5,minmax(0,1fr))] gap-3 items-stretch">
            <div className="flex xl:flex-col items-center xl:items-start justify-between xl:justify-center gap-2 rounded-xl bg-white border border-slate-200 border-l-4 border-l-sky-500 px-4 py-4 shadow-sm">
              <div>
                <div className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-black text-sky-700 mb-2">
                  Optimized
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
              sub={isEn ? "Higher is better" : "越高越好"}
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
              label={isEn ? "Total TTFT" : "累计 TTFT"}
              value={fmtSeconds(ik.totalTtft, 2)}
              sub={isEn ? "Sum of first-token wait across all rounds" : "所有轮次首字等待累计"}
              accent="sky"
            />
            <MetricCell
              label={isEn ? "Avg Input" : "平均输入"}
              value={fmtTokens(ik.avgInputTokens)}
              sub={isEn ? "prompt tokens per round" : "每轮 prompt token"}
              accent="sky"
            />
            <MetricCell
              label={isEn ? "Avg Output" : "平均输出"}
              value={fmtTokens(ik.avgOutputTokens)}
              sub={isEn ? "completion tokens per round" : "每轮 completion token"}
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
  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-6 md:p-7 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <Info className="w-5 h-5 text-sky-500" />
        <h3 className="text-xl font-black text-gray-900 tracking-tight">
          {isEn ? "Metric Definitions and Formulas" : "指标含义与计算方式"}
        </h3>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="rounded-xl border border-gray-200 bg-gray-50/70 p-4">
          <div className="text-sm font-black text-gray-900 mb-1">{isEn ? "Average TTFT" : "平均 TTFT"}</div>
          <p className="text-sm text-gray-600 leading-relaxed">
            {isEn ? "Mean time from request submission to the first returned token." : "首字延迟均值，请求发出后到第一个 token 返回的平均时间。"}
          </p>
          <div className="mt-2 text-xs font-mono text-gray-500">
            {isEn ? "sum(round TTFT) / completed rounds, lower is better" : "Σ 每轮 TTFT / 完成轮数，越低越好"}
          </div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-gray-50/70 p-4">
          <div className="text-sm font-black text-gray-900 mb-1">{isEn ? "Total TTFT" : "累计 TTFT"}</div>
          <p className="text-sm text-gray-600 leading-relaxed">
            {isEn ? "Sum of first-token wait time across all completed rounds; used to measure total waiting cost." : "所有完成轮次首字等待时间的总和，用于衡量整体等待成本。"}
          </p>
          <div className="mt-2 text-xs font-mono text-gray-500">
            {isEn ? "sum(round TTFT), lower is better" : "Σ 每轮 TTFT，越低越好"}
          </div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-gray-50/70 p-4">
          <div className="text-sm font-black text-gray-900 mb-1">{isEn ? "Estimated QPS" : "估算 QPS"}</div>
          <p className="text-sm text-gray-600 leading-relaxed">
            {isEn ? "Throughput estimated from total request time per round." : "按每轮请求总耗时换算出的吞吐能力。"}
          </p>
          <div className="mt-2 text-xs font-mono text-gray-500">
            {isEn ? "completed rounds / sum(TTFT + output tokens / TPS), higher is better" : "完成轮数 / Σ(TTFT + 输出 tokens / TPS)，越高越好"}
          </div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-gray-50/70 p-4">
          <div className="text-sm font-black text-gray-900 mb-1">{isEn ? "Speedup Ratio" : "性能倍数"}</div>
          <p className="text-sm text-gray-600 leading-relaxed">
            {isEn ? "Converts key metrics into ratios so the improvement is easy to read." : "将两套系统的关键指标换算成倍数，便于直接观察优化幅度。"}
          </p>
          <div className="mt-2 text-xs font-mono text-gray-500">
            {isEn
              ? "TTFT speedup = LMCache-DRAM avg TTFT / InfiniKV avg TTFT. QPS speedup = InfiniKV QPS / LMCache-DRAM QPS."
              : "TTFT 优化倍数 = LMCache-DRAM 平均 TTFT / InfiniKV 平均 TTFT。QPS 提升倍数 = InfiniKV QPS / LMCache-DRAM QPS。"}
          </div>
        </div>
      </div>
    </div>
  );
}


function ExperimentConfigBanner({ workloadLabel }: { workloadLabel: string }) {
  const [locale] = useLocale();
  const isEn = locale === "en";
  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-5 md:p-6 shadow-sm">
      <div className="space-y-5">
        <div>
          <div className="text-xs font-black uppercase tracking-[0.18em] text-gray-400 mb-1">
            Experiment Setup
          </div>
          <div className="text-xl font-black text-gray-900 tracking-tight">
            {workloadLabel}
          </div>
          <div className="mt-1 text-base text-gray-500">
            {isEn
              ? "LMCache-DRAM uses 64GB DRAM to extend KV Cache storage, while InfiniKV uses 512GB SSD. The experiment focuses on TTFT and throughput differences as context grows."
              : "LMCache-DRAM 仅使用 64GB DRAM 扩展 KV Cache 存储空间，InfiniKV 仅使用 512GB SSD 扩展 KV Cache 存储空间。实验重点观察上下文增长后，两个方案在首字延迟和吞吐上的差异。"}
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
                  Baseline
                </span>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3 rounded-xl bg-orange-50 px-3 py-2">
                  <span className="text-base font-semibold text-orange-700/80">{isEn ? "Offload Medium" : "卸载介质"}</span>
                  <span className="font-mono text-base font-black text-orange-800">64GB DRAM</span>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-xl bg-orange-50 px-3 py-2">
                  <span className="text-base font-semibold text-orange-700/80">{isEn ? "Cloud Storage Cost" : "云服务器存储成本"}</span>
                  <span className="font-mono text-base font-black text-orange-800">{isEn ? "3.8 RMB/hour" : "3.8 元 / 小时"}</span>
                </div>

                <div className="flex items-center justify-between gap-3 rounded-xl bg-orange-50 px-3 py-2">
                  <span className="text-base font-semibold text-orange-700/80">{isEn ? "Behavior" : "特点"}</span>
                  <span className="max-w-[68%] text-right text-sm font-bold leading-snug text-orange-800">{isEn ? "Limited capacity; more likely to evict historical KV Cache after many rounds" : "容量有限，长轮次后更容易淘汰历史 KV Cache"}</span>
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
                  Optimized
                </span>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3 rounded-xl bg-sky-50 px-3 py-2">
                  <span className="text-base font-semibold text-sky-700/80">{isEn ? "Offload Medium" : "卸载介质"}</span>
                  <span className="font-mono text-base font-black text-sky-800">512GB SSD</span>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-xl bg-sky-50 px-3 py-2">
                  <span className="text-base font-semibold text-sky-700/80">{isEn ? "Cloud Storage Cost" : "云服务器存储成本"}</span>
                  <span className="font-mono text-base font-black text-sky-800">{isEn ? "0.28 RMB/hour" : "0.28 元 / 小时"}</span>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-xl bg-sky-50 px-3 py-2">
                  <span className="text-base font-semibold text-sky-700/80">{isEn ? "Behavior" : "特点"}</span>
                  <span className="max-w-[68%] text-right text-sm font-bold leading-snug text-sky-800">{isEn ? "Larger capacity; preserves more historical KV Cache for later reuse" : "容量更大，可保留更多历史 KV Cache，用于后续轮次复用"}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Constants ──
 * Simplified drone delivery scenario: warehouse in the south, customer in the north,
 * one no-fly zone (tall buildings / restricted airspace) directly in between.
 * The model needs to curve around it to complete the delivery.
 */
const WAREHOUSE: [number, number] = [106.6, 28.5];
const CUSTOMER: [number, number] = [106.6, 29.1];
const OBSTACLE_ZONES: ObstacleZone[] = [
  { center: [106.6, 28.8], radius: 15000, label: "No-fly Zone / Skyline" },
];
const OBSTACLE_RADIUS = 15000; // ~0.14 degrees

const SYSTEM_PROMPT = `你是一个城市无人机配送调度系统。你的工作是根据调度员（用户）每轮下达的指令，为一架无人机规划一条从"仓库"飞往"客户"的完整航线，并用一个 JSON 对象表达这条航线。

——————————————————————————————————
【一、地图与坐标系】
本系统使用经纬度坐标表达地理位置，每个航点用一个三元数组表示：

    [经度, 纬度, 高度]

其中：
  • 经度（Longitude）：数值越大表示越偏东，越小表示越偏西。本任务所有点都在 106 附近（约 100 ~ 107）。
  • 纬度（Latitude）：数值越大表示越偏北，越小表示越偏南。本任务所有点都在 28 ~ 29 之间。
  • 高度（Altitude）：单位米，正常飞行高度为 300。部分特殊任务会让你改为 150（低空）。

一条完整航线由若干个这样的三元数组按时间顺序排列而成——无人机按数组顺序依次经过这些点。

——————————————————————————————————
【二、本任务固定不变的场景参数】
以下这三个坐标在整个对话的 20 轮中永远不变，请牢牢记住：

  1. 仓库（起飞点，位于南方）：[106.60, 28.50, 300]
     这是无人机每次出发的地方。

  2. 客户（送达点，位于正北方）：[106.60, 29.10, 300]
     这是无人机要把货物送到的目的地。

  3. 禁飞区（高楼群/限飞区，正好位于仓库和客户之间）：中心在 [106.60, 28.80]，半径 0.14 度。
     所有中间航点都必须绕开这个禁飞区——也就是离中心 [106.60, 28.80] 的距离必须大于 0.14 度。
     直接从仓库飞到客户的直线正好穿过禁飞区，所以你必须让航线向西或向东绕一下。

空间关系一句话：仓库在南（纬度 28.50），客户在北（纬度 29.10），禁飞区在正中间（纬度 28.80）。整段航程的主方向是"自南向北"，纬度必须一路增大；绕行只是在经度上左右摇摆一下避开中间的禁飞区。

——————————————————————————————————
【三、输出格式（严格）】
你每一轮的回答 **只能** 是一行合法的 JSON，不要加任何其它文字、不要 Markdown 代码块、不要先说"好的"、不要在 JSON 后面解释。整个回答就是这样一个对象：

  {"routes":[ [经度,纬度,高度], [经度,纬度,高度], ..., [经度,纬度,高度] ]}

具体要求：
  • routes 字段的值必须是一个数组，数组的每个元素又是一个三元数组 [经度,纬度,高度]。
  • 总共 5 到 7 个航点（包含起点和终点）。
  • **第一个航点必须是仓库**：[106.60, 28.50, 300]。
  • **最后一个航点必须是客户**：[106.60, 29.10, 300]。纬度是 29.10，不是 28.xx！
  • 航点按飞行顺序排列——前一个航点飞到下一个航点中间不能穿过禁飞区。
  • 相邻两个航点之间的距离大致在 0.08 ~ 0.12 度之间（约 9 ~ 13 公里），不要太近也不要太远。

——————————————————————————————————
【四、绕行策略（两种基本模式）】
因为禁飞区挡在仓库到客户的直线正中间，你只能选择绕行。通常有两种基本绕法：

  ◆ 西侧绕行：中间几个航点的经度压低到 106.35 ~ 106.45 之间（比仓库/客户的经度 106.60 偏西）。
    想象无人机从仓库出发，先往西偏一点，擦着禁飞区西边飞过去，再回到客户正北方。

  ◆ 东侧绕行：中间几个航点的经度抬高到 106.75 ~ 106.85 之间（比仓库/客户的经度 106.60 偏东）。
    想象无人机从仓库出发，先往东偏一点，擦着禁飞区东边飞过去，再回到客户正北方。

不论西侧还是东侧，**纬度都必须从 28.50 一路递增到 29.10**——因为客户就在正北方。如果你发现自己输出的航点纬度一直停在 28.xx 没有上升，那就是彻底错了。

——————————————————————————————————
【五、两个典型正确答案（请严格按这个结构输出）】

◆ 西侧绕行 5 点方案：
  {"routes":[[106.60,28.50,300],[106.48,28.65,300],[106.42,28.80,300],[106.48,28.95,300],[106.60,29.10,300]]}

  逐点解读：从仓库 [106.60,28.50] 出发 → 往西北飞到 [106.48,28.65]（经度减小到 106.48，纬度升到 28.65）→ 继续向北并抵达最西 [106.42,28.80]（在禁飞区西侧擦过）→ 转向东北 [106.48,28.95] → 最后回到客户正北 [106.60,29.10]。

◆ 东侧绕行 5 点方案：
  {"routes":[[106.60,28.50,300],[106.72,28.65,300],[106.78,28.80,300],[106.72,28.95,300],[106.60,29.10,300]]}

  逐点解读：从仓库出发 → 往东北飞到 [106.72,28.65] → 抵达最东 [106.78,28.80]（在禁飞区东侧擦过）→ 转回西北 [106.72,28.95] → 最后回到客户 [106.60,29.10]。

——————————————————————————————————
【六、常见错误，务必避免】

× 忘了最后一个点必须是客户：输出的末尾点经常写成 [106.xx, 28.5x, 300]——这是把终点和起点弄混了。客户在北方，纬度是 29.10！
× 纬度没上升：整条航线都在纬度 28.5x 徘徊，根本没有向北飞。无人机永远到不了客户。
× 只有经度变化：比如一路往西飞到 [101.9,28.5,300] 这种西南偏远地区——这完全错了，任务是从南飞到北，不是从东飞到西。
× 输出 Markdown 围栏（\`\`\`json ... \`\`\`）或者在 JSON 前后写"好的，这是航线："这类废话。

——————————————————————————————————
【七、再次强调最关键的三件事】

（1）第一个航点 = 仓库 = [106.60, 28.50, 300]
（2）最后一个航点 = 客户 = [106.60, 29.10, 300]
（3）整条航线的纬度必须从 28.50 稳步升到 29.10

每一轮用户给你的指令（例如"西侧绕行"、"低空飞行"、"大风日绕远"等）都只是在"怎么绕、多少个点、高度多少"这些细节上做变化，**起点和终点永远是仓库和客户，永远不变**。`;

// 20 条迭代指令：风格统一，描述详细但不复杂——保证 8b 模型在长上下文下也能理解。
// 每一条指令都遵守"起点=仓库[106.60,28.50,300]、终点=客户[106.60,29.10,300]、纬度必须从南递增到北"这三条铁律。
// 只在"绕哪边、几个点、什么高度"等次要参数上做变化，避免引入模型容易误解的复杂概念。
const ROUND_INSTRUCTIONS = [
  `第 1 轮：西侧绕行基础方案。
请规划一条从仓库 [106.60,28.50,300] 飞到客户 [106.60,29.10,300] 的航线，采用西侧绕行——中间航点的经度落在 106.40 到 106.45 之间。一共 5 个航点，首点是仓库、末点是客户，中间 3 个点把无人机从南往北带过去。`,

  `第 2 轮：东侧绕行对照方案。
规则和第 1 轮一样，但这次改走东侧——中间航点的经度落在 106.75 到 106.80 之间。还是 5 个航点，首点仓库 [106.60,28.50,300]，末点客户 [106.60,29.10,300]，纬度依然要一路从 28.50 升到 29.10。`,

  `第 3 轮：里程择优。
参考前两轮，输出你认为总里程稍短的那一条（西侧 或 东侧）——直接把那条 5 点航线再写一遍。起点必须是仓库 [106.60,28.50,300]，终点必须是客户 [106.60,29.10,300]。`,

  `第 4 轮：贴边优化。
在第 3 轮选中的方案上做一点优化：把中间 3 个航点向禁飞区边界稍微靠拢一点（例如西侧从 106.42 挪到 106.47，仍然保持距离禁飞区中心 > 0.14 度），让总里程更短。还是 5 个航点，起点仓库、终点客户。`,

  `第 5 轮：加密航点。
再跑一次西侧绕行，但这次把航点增加到 7 个——在原来 5 点的基础上，在仓库到第一个西侧点之间、客户到最后一个西侧点之间各插入一个过渡点，让航线更平滑。起点仓库 [106.60,28.50,300]，终点客户 [106.60,29.10,300]。`,

  `第 6 轮：更西的大绕行。
规划一条西侧绕行航线，但这次把中间航点的经度压到更西的 106.33 到 106.38 之间（比第 1 轮更靠西）——模拟大风日把航线整体向西推了一点。5 个航点，起点仓库、终点客户，纬度从 28.50 升到 29.10。`,

  `第 7 轮：中西侧路径。
走西侧绕行，但中间航点的经度放在 106.47 到 106.52 之间（比第 1 轮更接近正中）。5 个航点，起点仓库、终点客户。`,

  `第 8 轮：低空 7 点缓降。
重复第 1 轮的西侧绕行思路，但把所有航点的高度从 300 改为 150（低空飞行），同时把航点数增加到 7 个（让下降过程更缓）。起点 [106.60,28.50,150]，终点 [106.60,29.10,150]，中间 5 个点走西侧。`,

  `第 9 轮：东侧贴边。
按东侧绕行思路，把中间 3 个航点的经度压到 106.72 到 106.77 之间（比第 2 轮更贴近禁飞区边界，但仍然满足距中心 > 0.14 度的安全距离）。5 个航点，起点仓库、终点客户。`,

  `第 10 轮：更东的大绕行。
东侧绕行，但把中间航点的经度推到更远的 106.82 到 106.88 之间——模拟东风让航线整体向东偏一点。5 个航点，起点仓库、终点客户。`,

  `第 11 轮：6 点均匀西侧。
走西侧绕行，一共 6 个航点：起点仓库 [106.60,28.50,300]，终点客户 [106.60,29.10,300]，中间 4 个点均匀分布在纬度 28.62、28.74、28.86、28.98 上，经度都取 106.42 附近。`,

  `第 12 轮：6 点均匀东侧。
走东侧绕行，6 个航点。首点仓库、末点客户，中间 4 个点均匀分布在纬度 28.62、28.74、28.86、28.98 上，经度都取 106.78 附近。`,

  `第 13 轮：稀疏 5 点西侧。
走西侧绕行，航点间距比第 1 轮拉大一些（相邻两点纬度间隔约 0.15）。5 个航点，起点 [106.60,28.50,300]，终点 [106.60,29.10,300]，中间 3 个点经度取 106.42 附近。`,

  `第 14 轮：稀疏 5 点东侧。
走东侧绕行，航点间距拉大（纬度间隔约 0.15）。5 个航点，起点仓库、终点客户，中间 3 个点经度取 106.78 附近。`,

  `第 15 轮：最短方案复现。
从前 14 轮中选一条你认为总里程最短的西侧方案，把它的 5 个航点再原样输出一次。起点必须是仓库 [106.60,28.50,300]，终点必须是客户 [106.60,29.10,300]。`,

  `第 16 轮：轻微东偏补偿。
在第 1 轮西侧方案基础上，把所有中间航点的经度整体加上 0.02（模拟 GPS 向东漂移的补偿）。5 个航点，起点仓库、终点客户，中间 3 个点的经度从 106.42 附近变到 106.44 附近。`,

  `第 17 轮：加大安全裕度。
走西侧绕行，但把中间航点的经度压得更西（106.35 附近），让航点离禁飞区中心的距离达到 0.25 度——更保守的安全方案。5 个航点，起点仓库、终点客户。`,

  `第 18 轮：回到第 1 轮。
忽略前面所有临时变体，重新输出第 1 轮的标准西侧 5 点航线：首点仓库 [106.60,28.50,300]，中间 3 个点经度 106.42 附近，末点客户 [106.60,29.10,300]。`,

  `第 19 轮：最均衡方案。
参考第 1、2、15、18 轮，输出一条你认为在里程/安全/稳定性上最均衡的 5 点航线。仍然是标准格式：首点仓库 [106.60,28.50,300]，末点客户 [106.60,29.10,300]。`,

  `第 20 轮：交付重放。
把第 19 轮输出的那条 5 点航线原样再输出一次（用于验证长上下文下 prompt cache 能否正确命中）。首点仓库 [106.60,28.50,300]，末点客户 [106.60,29.10,300]。`,
];

const getInstruction = (idx: number) =>
  ROUND_INSTRUCTIONS[idx % ROUND_INSTRUCTIONS.length];
const SCENARIO_QUESTIONS = [
  "早高峰策略：要求在总里程最短前提下避开禁飞区，输出 5-7 个航点。",
  "雨天策略：优先安全，航线应远离禁飞区边界，允许路径略长。",
  "应急医疗策略：强调路径稳定，尽量减少拐点。",
  "能源节约策略：在满足安全的前提下降低总航程。",
  "低空合规策略：全航点高度调整为 150，并保持路径可达。",
  "夜间配送策略：避开高风险区域，保证路径可解释性。",
  "商圈拥堵策略：优先东侧绕行并控制航点数。",
  "居民区静音策略：优先西侧绕行并避免急转弯。",
];

const SYSTEM_PROMPT_EN = `You are a city drone delivery dispatch system. For each round, plan a complete route from the warehouse to the customer and return exactly one JSON object:

{"routes":[[longitude,latitude,altitude], ... ]}

Fixed map:
- Warehouse: [106.60, 28.50, 300]
- Customer: [106.60, 29.10, 300]
- No-fly zone center: [106.60, 28.80], radius 0.14 degrees
- The route must move from south to north and avoid the no-fly zone.

Routing patterns:
- West detour: intermediate longitude around 106.40~106.45
- East detour: intermediate longitude around 106.75~106.80
- Use 5 to 7 waypoints, including the warehouse and customer.

Output only valid JSON. Do not add Markdown, explanations, or extra text.`;

const SCENARIO_QUESTIONS_EN = [
  "Morning peak strategy: minimize total distance while avoiding the no-fly zone; return 5-7 waypoints.",
  "Rainy-day strategy: prioritize safety, keep the route farther from the no-fly boundary, and allow a slightly longer path.",
  "Emergency medical strategy: prioritize route stability and reduce unnecessary turns.",
  "Energy-saving strategy: reduce total flight distance while satisfying all safety constraints.",
  "Low-altitude compliance strategy: set all waypoint altitudes to 150 while keeping the route reachable.",
  "Night delivery strategy: avoid high-risk areas and keep the route explainable.",
  "Commercial-district congestion strategy: prefer an east-side detour and control the waypoint count.",
  "Residential quiet strategy: prefer a west-side detour and avoid sharp turns.",
];

/* ── Types ── */
type RoundResult = {
  ttft: number;
  tps: number;
  answer: string;
  waypoints: number[][];
  routeFallback?: boolean;
  contextTokens: number;
  outputTokens: number;
  servingTarget?: string;
  upstreamBaseUrl?: string;
  resolvedModel?: string;
};
type MapPhase = "idle" | "streaming" | "animating" | "done";
type DeliveryRound = {
  id: number;
  status: "pending" | "running" | "done";
  instruction: string;
  sessionLabel?: string;
  lmcache?: RoundResult;
  infinikv?: RoundResult;
  lmMapPhase: MapPhase;
  ikMapPhase: MapPhase;
  lmStreamText: string;
  ikStreamText: string;
};

function parseWaypoints(text: string): number[][] {
  // 优先从 <OUTPUT>...</OUTPUT> 标签内抓 JSON（新 prompt 契约）
  const outputBlock = text.match(/<OUTPUT>([\s\S]*?)<\/OUTPUT>/);
  const scanText = outputBlock ? outputBlock[1] : text;

  const isValidCoord = (arr: any[]): boolean => {
    if (arr.length < 2) return false;
    const lon = Number(arr[0]),
      lat = Number(arr[1]);
    return (
      !isNaN(lon) &&
      !isNaN(lat) &&
      lon >= 100 &&
      lon <= 115 &&
      lat >= 25 &&
      lat <= 35
    );
  };

  const tryParse = (jsonStr: string): number[][] => {
    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) {
        const valid = parsed.filter(
          (p: any) => Array.isArray(p) && isValidCoord(p),
        );
        if (valid.length >= 2)
          return valid.map((p: any) => [
            Number(p[0]),
            Number(p[1]),
            Number(p[2]) || 300,
          ]);
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray(parsed.routes)
      ) {
        const valid = parsed.routes.filter(
          (p: any) => Array.isArray(p) && isValidCoord(p),
        );
        if (valid.length >= 2)
          return valid.map((p: any) => [
            Number(p[0]),
            Number(p[1]),
            Number(p[2]) || 300,
          ]);
      }
    } catch {
      /* ignore */
    }
    return [];
  };

  const jsonObjMatch = scanText.match(/\{\s*"routes"\s*:\s*\[[\s\S]*?\]\s*\]/);
  if (jsonObjMatch) {
    const r = tryParse(jsonObjMatch[0] + "}");
    if (r.length >= 2) return r;
  }
  const routesMatch = scanText.match(/"routes"\s*:\s*(\[[\s\S]*\]\s*\])/);
  if (routesMatch) {
    const r = tryParse(routesMatch[1]);
    if (r.length >= 2) return r;
  }
  const partialRoutes = scanText.match(/"routes"\s*:\s*(\[[\s\S]*)/);
  if (partialRoutes) {
    let raw = partialRoutes[1];
    raw = raw.replace(/,\s*\[\s*[\d.,\s]*$/, "");
    if (!raw.endsWith("]]")) {
      if (raw.endsWith("]")) raw += "]";
      else raw += "]]";
    }
    const r = tryParse(raw);
    if (r.length >= 2) return r;
  }
  const arrayRe = /\[\s*\[[\d.\s,]+\](?:\s*,\s*\[[\d.\s,]+\])+\s*\]/g;
  let arrMatch;
  while ((arrMatch = arrayRe.exec(scanText)) !== null) {
    const r = tryParse(arrMatch[0]);
    if (r.length >= 2) return r;
  }
  const coordPattern =
    /\[\s*(10[0-9]\.\d+)\s*,\s*(2[5-9]\.\d+)(?:\s*,\s*([\d.]+))?\s*\]/g;
  const coords: number[][] = [];
  let cm;
  while ((cm = coordPattern.exec(scanText)) !== null) {
    coords.push([
      parseFloat(cm[1]),
      parseFloat(cm[2]),
      parseFloat(cm[3]) || 300,
    ]);
  }
  if (coords.length >= 2) return coords;
  return [];
}

/** 只做最轻的起点处理：如果模型把起点丢了就加回仓库，**不对终点做任何补全**。
 *  终点错误直接暴露给用户（"未送达"），这是评估模型真实规划能力的一部分。
 */
function fixRouteStart(
  waypoints: number[][],
  start: [number, number],
): number[][] {
  if (waypoints.length < 1) return waypoints;
  const dist = (a: number[], b: number[]) =>
    Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);
  const result = [...waypoints];
  if (dist(result[0], start) > 0.02) {
    result.unshift([start[0], start[1], 300]);
  }
  return result;
}

function buildSafeDeliveryRoute(): number[][] {
  return [
    [WAREHOUSE[0], WAREHOUSE[1], 300],
    [106.48, 28.65, 300],
    [106.42, 28.80, 300],
    [106.48, 28.95, 300],
    [CUSTOMER[0], CUSTOMER[1], 300],
  ];
}

function canonicalRouteAnswer(waypoints: number[][]): string {
  return JSON.stringify({ routes: waypoints });
}

function sanitizeDeliveryResult(
  rawAnswer: string,
  previousRoutes: number[][][] = [],
): { answer: string; waypoints: number[][]; routeFallback: boolean } {
  let waypoints = fixRouteStart(parseWaypoints(rawAnswer), WAREHOUSE);
  const routeFallback = waypoints.length < 2 || !routeReachesTarget(waypoints, CUSTOMER);
  const fallbackFromHistory = routeFallback && previousRoutes.some(route => route.length >= 2);
  if (routeFallback) {
    waypoints = fallbackFromHistory
      ? previousRoutes.slice().reverse().find(route => route.length >= 2) || buildSafeDeliveryRoute()
      : buildSafeDeliveryRoute();
  }
  return {
    answer: canonicalRouteAnswer(waypoints),
    waypoints,
    routeFallback,
  };
}

function routeReachesTarget(
  waypoints: number[][],
  target: [number, number],
): boolean {
  if (waypoints.length < 2) return false;
  const last = waypoints[waypoints.length - 1];
  const dist = Math.sqrt(
    (last[0] - target[0]) ** 2 + (last[1] - target[1]) ** 2,
  );
  return dist < 0.05;
}

const SCENARIO_ROUTES: Record<string, string> = {
  "long-context": "/demo/long-context",
  concurrent: "/demo/concurrent",
  agent: "/demo/agent",
  "drone-delivery": "/demo/drone-delivery",
  "drone-fleet": "/demo/drone-fleet",
};

/* ── Streaming text display — clean neutral style (modern SaaS / LLM chat look) ── */
function StreamingText({
  text,
  isStreaming,
}: {
  text: string;
  isStreaming: boolean;
}) {
  const [locale] = useLocale();
  const isEn = locale === "en";
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (containerRef.current)
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [text]);

  return (
    <div
      ref={containerRef}
      className="flex-1 bg-slate-50 border border-slate-200 rounded-lg p-3 overflow-y-auto max-h-[240px] font-mono text-xs leading-relaxed text-slate-700 scrollbar-hide"
    >
      {text ? (
        <>
          <span className="whitespace-pre-wrap">{text}</span>
          {isStreaming && (
            <span className="inline-block w-1.5 h-3.5 bg-sky-500 ml-0.5 align-middle animate-pulse rounded-sm" />
          )}
        </>
      ) : isStreaming ? (
        <div className="flex items-center space-x-2 text-slate-400">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span>{isEn ? "Waiting for first token..." : "等待首 Token..."}</span>
        </div>
      ) : (
        <span className="text-slate-400">{isEn ? "Waiting to run..." : "等待执行..."}</span>
      )}
    </div>
  );
}

/* ── Extracted waypoints data bridge with delivery verdict ── */
function WaypointsBridge({
  waypoints,
  mapPhase,
  routeFallback = false,
}: {
  waypoints: number[][];
  mapPhase: MapPhase;
  routeFallback?: boolean;
}) {
  const [locale] = useLocale();
  const isEn = locale === "en";
  if (mapPhase === "idle" || mapPhase === "streaming") return null;

  if (waypoints.length < 2) {
    return (
      <div className="mt-1.5 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs font-medium text-red-600">
        {isEn ? "No valid waypoint coordinates parsed from the answer" : "未能从回答中解析到有效航点坐标"}
      </div>
    );
  }

  const hit = routeReachesTarget(waypoints, CUSTOMER);

  return (
    <div
      className={`mt-1.5 px-3 py-2 rounded-lg border ${hit ? "bg-emerald-50 border-emerald-200" : "bg-amber-50 border-amber-200"}`}
    >
      <div className="flex items-center justify-between">
        <span
          className={`text-xs font-semibold ${hit ? "text-emerald-700" : "text-amber-700"}`}
        >
          {isEn ? `Extracted ${waypoints.length} waypoints · flight validation` : `提取 ${waypoints.length} 航点 · 飞行验证`}
        </span>
        {mapPhase === "done" && (
          <span
            className={`text-xs font-bold px-2 py-0.5 rounded ${hit ? "bg-emerald-500 text-white" : "bg-red-500 text-white"}`}
          >
            {hit ? (isEn ? "Delivered" : "送达成功") : (isEn ? "Not delivered" : "未送达")}
          </span>
        )}
      </div>
      <div className="text-[11px] font-mono text-slate-600 max-h-[60px] overflow-y-auto leading-relaxed mt-1.5 flex flex-wrap items-center gap-x-1.5">
        {waypoints.map((wp, i) => (
          <React.Fragment key={i}>
            {i > 0 && (
              <Plane
                className="inline-block w-2.5 h-2.5 text-slate-400"
                strokeWidth={2.5}
              />
            )}
            <span
              className={
                i === 0
                  ? "text-emerald-600 font-semibold"
                  : i === waypoints.length - 1
                    ? hit
                      ? "text-emerald-600 font-semibold"
                      : "text-red-500 font-semibold"
                    : "text-slate-600"
              }
            >
              [{wp[0].toFixed(3)},{wp[1].toFixed(3)}]
            </span>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

/* ── Single comparison panel (one side: LMCache or InfiniKV) — vertical stack ── */
function ComparisonPanel({
  groupLabel,
  accentColor,
  dotColor,
  round,
  resultKey,
  previousRoutes,
  streamText,
  mapPhase,
  onMapAnimDone,
  modelLabel,
}: {
  groupLabel: string;
  accentColor: string;
  dotColor: string;
  round?: DeliveryRound;
  resultKey: "lmcache" | "infinikv";
  previousRoutes: number[][][];
  streamText: string;
  mapPhase: MapPhase;
  onMapAnimDone: () => void;
  modelLabel?: string;
}) {
  const [locale] = useLocale();
  const isEn = locale === "en";
  const result = round?.[resultKey];
  const waypoints = result?.waypoints || [];

  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm flex flex-col">
      {/* Header: group label + metrics on top */}
      <div className={`px-5 py-3 border-b border-gray-100 ${accentColor}`}>
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="flex items-center space-x-2 min-w-0">
            <div className={`w-3 h-3 rounded-full ${dotColor}`} />
            <span className="text-sm font-bold text-gray-900 truncate">
              {groupLabel}
            </span>
          </div>
          {modelLabel && (
            <span className="shrink-0 text-[10px] font-mono font-semibold px-2 py-1 rounded-md bg-white/90 border border-gray-200 text-gray-600">
              {isEn ? "Model" : "模型"} {modelLabel}
            </span>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2 text-sm font-mono">
          <div>
            <div className="text-gray-500 text-xs mb-1 font-semibold">TTFT</div>
            <div className="font-bold text-gray-900 text-lg leading-none">
              {result ? `${result.ttft.toFixed(3)}s` : "--"}
            </div>
          </div>
          <div>
            <div className="text-gray-500 text-xs mb-1 font-semibold">TPS</div>
            <div className="font-bold text-gray-900 text-lg leading-none">
              {result ? result.tps.toFixed(1) : "--"}
            </div>
          </div>
          <div>
            <div className="text-gray-500 text-xs mb-1 font-semibold">
              {isEn ? "Context" : "本轮上下文"}
            </div>
            <div className="font-bold text-gray-900 text-base leading-none">
              {result && result.contextTokens > 0
                ? `${result.contextTokens.toLocaleString()} tk`
                : "--"}
            </div>
          </div>
        </div>
      </div>

      {/* Body: streaming text on top + map verification below */}
      <div className="flex flex-col flex-1">
        <div className="p-3 flex flex-col">
          <div className="text-sm font-semibold text-slate-600 mb-1.5 flex items-center space-x-2">
            <span>
              {mapPhase === "streaming"
                ? isEn ? "Live inference output" : "实时推理输出"
                : mapPhase === "animating"
                  ? isEn ? "Inference done · extracting waypoints · validating delivery" : "推理完成 · 提取航点 · 配送验证中"
                  : mapPhase === "done"
                    ? isEn ? "Plan output complete" : "方案输出完成"
                    : isEn ? "Plan output" : "方案输出"}
            </span>
            {mapPhase === "streaming" && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-sky-500" />
              </span>
            )}
          </div>
          <StreamingText
            text={streamText || result?.answer || ""}
            isStreaming={mapPhase === "streaming"}
          />
          <WaypointsBridge waypoints={waypoints} mapPhase={mapPhase} routeFallback={Boolean(result?.routeFallback)} />
        </div>

        <div className="p-2 border-t border-gray-100 flex flex-col">
          <div className="text-xs font-semibold text-slate-500 mb-1.5 flex items-center space-x-2">
            {(() => {
              const hit =
                waypoints.length >= 2 &&
                routeReachesTarget(waypoints, CUSTOMER);
              if (mapPhase === "animating" && waypoints.length >= 2)
                return (
                  <>
                    <span className="text-emerald-600">
                      {isEn ? `Drone delivery validation (${waypoints.length} waypoints)` : `无人机配送验证中 (${waypoints.length} 航点)`}
                    </span>
                    <Loader2 className="w-3 h-3 animate-spin text-emerald-500" />
                  </>
                );
              if (mapPhase === "done" && waypoints.length >= 2)
                return (
                  <span className={hit ? "text-emerald-600" : "text-red-500"}>
                    {hit
                      ? isEn ? "Validation passed · delivered" : "验证通过 · 送达成功"
                      : isEn ? "Validation result · not delivered (plan needs improvement)" : "验证结果 · 未送达 (方案需优化)"}
                  </span>
                );
              if (
                (mapPhase === "animating" || mapPhase === "done") &&
                waypoints.length < 2
              )
                return <span className="text-red-500">{isEn ? "No valid waypoint data" : "无有效航点数据"}</span>;
              return (
                <span>
                  {isEn ? "City delivery map" : "城市配送地图"}
                  {previousRoutes.length > 0
                    ? isEn ? ` (historical routes x${previousRoutes.length})` : ` (历史航线 ×${previousRoutes.length})`
                    : ""}
                </span>
              );
            })()}
          </div>
          <div className="h-[340px]">
            <TacticalMap
              launchPoint={WAREHOUSE}
              targetPoint={CUSTOMER}
              obstacleZones={OBSTACLE_ZONES}
              obstacleRadius={OBSTACLE_RADIUS}
              waypoints={waypoints.length >= 2 ? waypoints : undefined}
              previousRoutes={
                previousRoutes.length > 0 ? previousRoutes : undefined
              }
              animating={mapPhase === "animating" && waypoints.length >= 2}
              animationDone={mapPhase === "done" && waypoints.length >= 2}
              onAnimationComplete={onMapAnimDone}
              label={groupLabel}
              showStats
            />
          </div>
        </div>
      </div>
    </div>
  );
}

const DELIVERY_DOCS: { zh: string; en: string }[] = [
  { zh: "城市路网资料.md",       en: "City-Road-Network.md" },
  { zh: "禁飞区规定手册.md",     en: "No-Fly-Zone-Regulations.md" },
  { zh: "气象与环境报告.md",     en: "Weather-Conditions-Report.md" },
  { zh: "配送任务清单.md",       en: "Delivery-Task-Manifest.md" },
  { zh: "地面管制通信日志.md",   en: "Ground-Control-Comm-Log.md" },
  { zh: "历史最优航线数据.md",   en: "Historical-Route-Optimizer.md" },
  { zh: "紧急预案操作手册.md",   en: "Emergency-Response-Manual.md" },
  { zh: "传感器校准记录.md",     en: "Sensor-Calibration-Log.md" },
  { zh: "机体维修保养记录.md",   en: "Aircraft-Maintenance-Log.md" },
  { zh: "配送区域详细说明.md",   en: "Delivery-Zone-Guidelines.md" },
];

/* ── Page ── */
export default function DroneDeliveryPage() {
  const router = useRouter();
  const [locale] = useLocale();
  const tr = (key: Parameters<typeof t>[1]) => t(locale, key);
  const [apiBase, setApiBase] = useState("");
  useEffect(() => {
    setApiBase(getApiBase());
  }, []);

  const [model] = useState("llama3.1-8b-instruct");
  const modelLabel = "llama3.1-8b-instruct · 128K 窗口";
  const localizedModelLabel = locale === "en" ? "llama3.1-8b-instruct · 128K window" : modelLabel;
  const [contextBucket] = useState(128000);
  const [outputLen, setOutputLen] = useState(1024);
  const [totalRounds, setTotalRounds] = useState(10);
  const [scenarioCooldown, setScenarioCooldown] = useState(2);
  const [promptGap, setPromptGap] = useState(2);
  const [runLMCache, setRunLMCache] = useState(true);
  const [runInfiniKV, setRunInfiniKV] = useState(true);
  const [showConfig, setShowConfig] = useState(true);

  // 可选附件：把 PDF/TXT 内容作为"业务背景资料"拼进 SYSTEM_PROMPT，
  // 让单次 prompt 的 token 量级从 ~200 拉到 10K+，把 KV Cache 压到 DRAM 级别。
  type AttachmentDoc = {
    id: string;
    name: string;
    text: string;
    estTokens: number;
    displayName: string;
  };
  const [attachedDocs, setAttachedDocs] = useState<AttachmentDoc[]>([]);
  const [uploading, setUploading] = useState(false);
  const docInputRef = useRef<HTMLInputElement>(null);

  const [isRunning, setIsRunning] = useState(false);
  const [rounds, setRounds] = useState<DeliveryRound[]>([]);
  const roundsRef = useRef<DeliveryRound[]>([]);
  useEffect(() => { roundsRef.current = rounds; }, [rounds]);
  const [activeRound, setActiveRound] = useState(0);

  const [showHistory, setShowHistory] = useState(false);
  const [showWorkloadInfo, setShowWorkloadInfo] = useState(false);
  const staticModeNotice = () => {
    window.alert(locale === "en" ? "This GitHub Pages build is a static replay. Live upload and inference are disabled." : "当前 GitHub Pages 版本为静态回放，已禁用实时上传和推理。");
  };

  const lmPrevRoutesRef = useRef<number[][][]>([]);
  const ikPrevRoutesRef = useRef<number[][][]>([]);

  useEffect(() => {
    const pending = sessionStorage.getItem("infinikv_pending_record");
    if (pending) {
      sessionStorage.removeItem("infinikv_pending_record");
      try {
        const record: TestRecord = JSON.parse(pending);
        if (record.scenario === "drone-delivery") handleLoadRecord(record);
      } catch { }
      return;
    }
    const cachedLatest = getCachedLatestRecord("drone-delivery");
    if (cachedLatest && !isRunning) handleLoadRecord(cachedLatest);
    let cancelled = false;
    void (async () => {
      const records = await getHistory("drone-delivery");
      if (cancelled || records.length === 0) return;
      const latest = records.slice().sort((a, b) => b.timestamp - a.timestamp)[0];
      if (latest && !isRunning) handleLoadRecord(latest);
    })();
    return () => { cancelled = true; };
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
    const incoming: AttachmentDoc[] = [];
    try {
      for (const file of Array.from(files)) {
        const ext = file.name.split(".").pop()?.toLowerCase() || "";
        if (ext === "pdf") {
          const arr = await file.arrayBuffer();
          const fileB64 = arrayBufferToBase64(arr);
          const res = await fetch(`${apiBase}/disabled/attachments/extract-pdf`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: file.name, file_b64: fileB64 }),
          });
          const data = await res.json();
          if (!res.ok || !data?.text)
            throw new Error(`${file.name}: ${data?.detail || "PDF 解析失败"}`);
          const text = String(data.text);
          incoming.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name,
            text,
            estTokens: Math.floor(text.length / 1.5),
            displayName: `${file.name} | ${data.pageCount || "-"} 页 | ${text.length} 字符`,
          });
        } else {
          if (ext !== "txt" && ext !== "md")
            throw new Error(`${file.name}: 仅支持 .txt / .md / .pdf`);
          const text = await file.text();
          incoming.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name,
            text,
            estTokens: Math.floor(text.length / 1.5),
            displayName: file.name,
          });
        }
      }
      setAttachedDocs((prev) => [...prev, ...incoming]);
      if (docInputRef.current) docInputRef.current.value = "";
    } catch (err: any) {
      alert(`文件错误: ${err?.message}`);
    } finally {
      setUploading(false);
    }
  };

  const clearAttachment = () => {
    setAttachedDocs([]);
    if (docInputRef.current) docInputRef.current.value = "";
  };

  const simulateStreaming = useCallback(
    (fullText: string, setter: (text: string) => void): Promise<void> => {
      return new Promise((resolve) => {
        let idx = 0;
        const chunkSize = 3;
        const interval = 15;
        const timer = setInterval(() => {
          idx = Math.min(idx + chunkSize, fullText.length);
          setter(fullText.slice(0, idx));
          if (idx >= fullText.length) {
            clearInterval(timer);
            resolve();
          }
        }, interval);
      });
    },
    [],
  );

  const runOneRound = async (
    group: "LMCache-DRAM" | "InfiniKV",
    activeDoc: AttachmentDoc | undefined,
    promptScenario: string,
    sessionTag: string,
  ): Promise<RoundResult> => {
    let systemContent = SYSTEM_PROMPT;
    const combinedDocContent = activeDoc
      ? `【${activeDoc.name}】\n${activeDoc.text}`
      : "";
    if (combinedDocContent) {
      const MAX_DOC_CHARS = 120_000;
      const docTrimmed =
        combinedDocContent.length > MAX_DOC_CHARS
          ? combinedDocContent.slice(0, MAX_DOC_CHARS) +
          "\n\n[…附件后续内容已省略以保留历史上下文空间]"
          : combinedDocContent;
      systemContent +=
        "\n\n# 附加资料（本次任务的业务背景知识，所有轮次共享）\n" + docTrimmed;
    }
    systemContent += `\n\n# 会话标签\n${sessionTag}`;

    const messages: { role: string; content: string }[] = [
      { role: "system", content: systemContent },
    ];
    const reminder = `\n\n场景要求：${promptScenario}\n提醒：routes 最后一个点必须是客户 [106.60,29.10,300]，第一个点必须是仓库 [106.60,28.50,300]。只输出 JSON 一行。`;
    messages.push({ role: "user", content: reminder });

    const res = await fetch(`${apiBase}/disabled/benchmark/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        scenario: "drone_delivery_route",
        contextLen: contextBucket,
        contextBucket,
        prefixReuseRate: 90,
        concurrent: 1,
        outputLen,
        ttftSloSec: 5,
        messages,
        groupName: group,
      }),
    });
    const data = await res.json();
    const item = data?.data?.[0] || {};
    const rawAnswer = item.generated_text || "(无输出)";
    const previousRoutes = group === "LMCache-DRAM" ? lmPrevRoutesRef.current : ikPrevRoutesRef.current;
    const sanitized = sanitizeDeliveryResult(rawAnswer, previousRoutes);
    return {
      ttft: item.ttft || 0,
      tps: item.tps || 0,
      answer: sanitized.answer,
      waypoints: sanitized.waypoints,
      routeFallback: sanitized.routeFallback,
      contextTokens: item.actual_chat_input_tokens || 0,
      outputTokens: item.usage_completion_tokens || item.outTokens || 0,
      servingTarget: item.serving_target,
      upstreamBaseUrl: item.upstream_base_url,
      resolvedModel: item.resolved_model,
    };
  };

  const updateRound = (idx: number, patch: Partial<DeliveryRound>) => {
    setRounds((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    );
  };

  const runBenchmark = async () => {
    setIsRunning(true);
    lmPrevRoutesRef.current = [];
    ikPrevRoutesRef.current = [];
    const numRounds = totalRounds;
    const initial: DeliveryRound[] = Array.from(
      { length: numRounds },
      (_, i) => ({
        id: i + 1,
        status: "pending" as const,
        instruction: getInstruction(i),
        lmMapPhase: "idle" as MapPhase,
        ikMapPhase: "idle" as MapPhase,
        lmStreamText: "",
        ikStreamText: "",
      }),
    );
    setRounds(initial);
    setActiveRound(0);

    const sessionPool =
      attachedDocs.length > 0
        ? attachedDocs.map((d) => ({ id: d.id, label: d.name, doc: d }))
        : [
          {
            id: "default",
            label: "默认城市",
            doc: undefined as AttachmentDoc | undefined,
          },
        ];

    const pickSessionForRound = (recentIds: string[]) => {
      if (sessionPool.length <= 1) return sessionPool[0];
      const cooldown = Math.min(
        scenarioCooldown,
        Math.max(0, sessionPool.length - 1),
      );
      const blocked = new Set(recentIds.slice(-cooldown));
      const candidates = sessionPool.filter((s) => !blocked.has(s.id));
      const pool = candidates.length > 0 ? candidates : sessionPool;
      return pool[Math.floor(Math.random() * pool.length)];
    };

    const pickPromptForRound = (recentPrompts: string[]) => {
      const cooldown = Math.min(
        promptGap,
        Math.max(0, SCENARIO_QUESTIONS.length - 1),
      );
      const blocked = new Set(recentPrompts.slice(-cooldown));
      const candidates = SCENARIO_QUESTIONS.filter((q) => !blocked.has(q));
      const pool = candidates.length > 0 ? candidates : SCENARIO_QUESTIONS;
      return pool[Math.floor(Math.random() * pool.length)];
    };

    const recentSessionIds: string[] = [];
    const recentPrompts: string[] = [];

    try {
      for (let i = 0; i < numRounds; i++) {
        const session = pickSessionForRound(recentSessionIds);
        const scenarioPrompt = pickPromptForRound(recentPrompts);
        recentSessionIds.push(session.id);
        recentPrompts.push(scenarioPrompt);
        setActiveRound(i);
        setRounds((prev) =>
          prev.map((r, ri) =>
            ri === i
              ? {
                ...r,
                status: "running",
                sessionLabel: session.label,
                instruction: scenarioPrompt,
              }
              : r,
          ),
        );

        if (runLMCache) {
          updateRound(i, { lmMapPhase: "streaming", lmStreamText: "" });
          const lmResult = await runOneRound(
            "LMCache-DRAM",
            session.doc,
            scenarioPrompt,
            session.id,
          );
          await simulateStreaming(lmResult.answer, (text) =>
            updateRound(i, { lmStreamText: text }),
          );
          updateRound(i, { lmcache: lmResult, lmStreamText: lmResult.answer });

          if (lmResult.waypoints.length >= 2) {
            updateRound(i, { lmMapPhase: "animating" });
            await new Promise<void>((resolve) => setTimeout(resolve, 3200));
          }
          lmPrevRoutesRef.current = [
            ...lmPrevRoutesRef.current,
            lmResult.waypoints,
          ];
          updateRound(i, { lmMapPhase: "done" });
        }

        if (runInfiniKV) {
          updateRound(i, { ikMapPhase: "streaming", ikStreamText: "" });
          const ikResult = await runOneRound(
            "InfiniKV",
            session.doc,
            scenarioPrompt,
            session.id,
          );
          await simulateStreaming(ikResult.answer, (text) =>
            updateRound(i, { ikStreamText: text }),
          );
          updateRound(i, { infinikv: ikResult, ikStreamText: ikResult.answer });

          if (ikResult.waypoints.length >= 2) {
            updateRound(i, { ikMapPhase: "animating" });
            await new Promise<void>((resolve) => setTimeout(resolve, 3200));
          }
          ikPrevRoutesRef.current = [
            ...ikPrevRoutesRef.current,
            ikResult.waypoints,
          ];
          updateRound(i, { ikMapPhase: "done" });
        }

        setRounds((prev) =>
          prev.map((r, ri) => (ri === i ? { ...r, status: "done" } : r)),
        );
      }

      const finalRounds = roundsRef.current.map((r) => ({
        id: r.id,
        instruction: r.instruction,
        status: r.status,
        lmcache: r.lmcache
          ? {
            ttft: r.lmcache.ttft,
            tps: r.lmcache.tps,
            answer: r.lmcache.answer,
            contextTokens: r.lmcache.contextTokens,
            outputTokens: r.lmcache.outputTokens,
            servingTarget: r.lmcache.servingTarget,
            upstreamBaseUrl: r.lmcache.upstreamBaseUrl,
            resolvedModel: r.lmcache.resolvedModel,
          }
          : undefined,
        infinikv: r.infinikv
          ? {
            ttft: r.infinikv.ttft,
            tps: r.infinikv.tps,
            answer: r.infinikv.answer,
            contextTokens: r.infinikv.contextTokens,
            outputTokens: r.infinikv.outputTokens,
            servingTarget: r.infinikv.servingTarget,
            upstreamBaseUrl: r.infinikv.upstreamBaseUrl,
            resolvedModel: r.infinikv.resolvedModel,
          }
          : undefined,
      }));
      if (finalRounds.length > 0) {
        await saveRecord({
          scenario: "drone-delivery",
          scenarioLabel: "单节点长上下文规划",
          config: {
            outputLen,
            totalRounds: numRounds,
            scenarioCooldown,
            runLMCache,
            runInfiniKV,
            docNames: attachedDocs.map((d) => d.name),
            docTokensTotal: attachedDocs.reduce(
              (sum, d) => sum + d.estTokens,
              0,
            ),
          },
          results: { rounds: finalRounds },
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

  const handleLoadRecord = (record: TestRecord) => {
    const replay = record.normalizedReplay || record.results;
    if (replay?.rounds) {
      const allLmRoutes: number[][][] = [];
      const allIkRoutes: number[][][] = [];
      const loaded: DeliveryRound[] = replay.rounds.map(
        (r: any, i: number) => {
          const lmSanitized = r.lmcache
            ? sanitizeDeliveryResult(r.lmcache.answer || "", allLmRoutes)
            : undefined;
          const ikSanitized = r.infinikv
            ? sanitizeDeliveryResult(r.infinikv.answer || "", allIkRoutes)
            : undefined;
          const lmWp = lmSanitized?.waypoints || [];
          const ikWp = ikSanitized?.waypoints || [];
          if (lmWp.length > 0) allLmRoutes.push(lmWp);
          if (ikWp.length > 0) allIkRoutes.push(ikWp);
          return {
            id: r.id || i + 1,
            status: "done" as const,
            instruction: r.instruction || getInstruction(i) || "",
            lmcache: r.lmcache && lmSanitized ? { ...r.lmcache, answer: lmSanitized.answer, waypoints: lmWp, routeFallback: lmSanitized.routeFallback } : undefined,
            infinikv: r.infinikv
              ? { ...r.infinikv, answer: ikSanitized?.answer || r.infinikv.answer, waypoints: ikWp, routeFallback: ikSanitized?.routeFallback }
              : undefined,
            lmMapPhase: "done" as MapPhase,
            ikMapPhase: "done" as MapPhase,
            lmStreamText: lmSanitized?.answer || "",
            ikStreamText: ikSanitized?.answer || "",
          };
        },
      );
      lmPrevRoutesRef.current = allLmRoutes;
      ikPrevRoutesRef.current = allIkRoutes;
      roundsRef.current = loaded;
      setRounds(loaded);
      setActiveRound(0);
    }
    if (record.config?.outputLen) setOutputLen(record.config.outputLen);
    if (record.config?.totalRounds) setTotalRounds(record.config.totalRounds);
    if (record.config?.scenarioCooldown)
      setScenarioCooldown(record.config.scenarioCooldown);
    const docNames = Array.isArray(record.config?.docNames) ? record.config.docNames : [];
    const totalTokens = Number(record.config?.docTokensTotal) || 0;
    if (docNames.length > 0) {
      setAttachedDocs(docNames.map((name: string, index: number) => ({
        id: `history-doc-${index}`,
        name,
        text: "",
        estTokens: docNames.length > 0 ? Math.round(totalTokens / docNames.length) : 0,
        displayName: name,
      })));
    }
  };

  const completedRounds = rounds.filter((r) => r.status === "done");
  const totalDocEstimatedTokens = attachedDocs.reduce(
    (sum, d) => sum + d.estTokens,
    0,
  );
  const lmTtfts = completedRounds
    .map((r) => r.lmcache?.ttft)
    .filter((t): t is number => typeof t === "number" && t > 0);
  const ikTtfts = completedRounds
    .map((r) => r.infinikv?.ttft)
    .filter((t): t is number => typeof t === "number" && t > 0);
  const lmInputTokens = completedRounds
    .map((r) => r.lmcache?.contextTokens)
    .filter((t): t is number => typeof t === "number" && t > 0);
  const ikInputTokens = completedRounds
    .map((r) => r.infinikv?.contextTokens)
    .filter((t): t is number => typeof t === "number" && t > 0);
  const lmOutputTokens = completedRounds
    .map((r) => r.lmcache?.outputTokens)
    .filter((t): t is number => typeof t === "number" && t > 0);
  const ikOutputTokens = completedRounds
    .map((r) => r.infinikv?.outputTokens)
    .filter((t): t is number => typeof t === "number" && t > 0);
  const avg = (arr: number[]) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const totalLm = lmTtfts.reduce((a, b) => a + b, 0);
  const totalIk = ikTtfts.reduce((a, b) => a + b, 0);
  const estReqSec = (ttft?: number, tps?: number, outTokens?: number) => {
    if (!ttft || ttft <= 0) return 0;
    const genSec =
      tps && tps > 0 && outTokens && outTokens > 0 ? outTokens / tps : 0;
    return ttft + genSec;
  };
  const lmReqSeconds = completedRounds.reduce(
    (sum, r) =>
      sum + estReqSec(r.lmcache?.ttft, r.lmcache?.tps, r.lmcache?.outputTokens),
    0,
  );
  const ikReqSeconds = completedRounds.reduce(
    (sum, r) =>
      sum +
      estReqSec(r.infinikv?.ttft, r.infinikv?.tps, r.infinikv?.outputTokens),
    0,
  );
  const lmQps = lmReqSeconds > 0 ? completedRounds.length / lmReqSeconds : 0;
  const ikQps = ikReqSeconds > 0 ? completedRounds.length / ikReqSeconds : 0;
  const qpsGain = lmQps > 0 && ikQps > 0 ? (ikQps / lmQps - 1) * 100 : 0;
  const ttftSpeedupOverall =
    lmTtfts.length && ikTtfts.length ? avg(lmTtfts) / avg(ikTtfts) : 0;
  const qpsSpeedupOverall = lmQps > 0 && ikQps > 0 ? ikQps / lmQps : 0;
  const currentRound = rounds[activeRound];

  const lmPrevForActive = lmPrevRoutesRef.current.slice(0, activeRound);
  const ikPrevForActive = ikPrevRoutesRef.current.slice(0, activeRound);

  const chartData = completedRounds.map((r) => ({
    name: locale === "en" ? `Round ${r.id}` : `第 ${r.id} 轮`,
    lmcache_ttft: r.lmcache?.ttft ?? null,
    infinikv_ttft: r.infinikv?.ttft ?? null,
  }));

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50/50 to-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-8">
        {/* Header */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center space-x-3 mb-3">
              <span className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-sm font-bold text-slate-700 shadow-sm">
                {tr("demo.single.badge")}
              </span>
              <span className="text-sm font-medium text-slate-500">
                {tr("demo.single.tagline")}
              </span>
              <span className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 shadow-sm">
                {tr("demo.common.model")}: {localizedModelLabel}
              </span>
            </div>
            <h1 className="text-4xl font-black text-gray-900 flex items-center space-x-3 tracking-tight">
              <Package className="w-8 h-8 text-emerald-500" />
              <span>{tr("demo.single.title")}</span>
            </h1>
            <p className="text-slate-500 text-base mt-2 leading-relaxed max-w-3xl">
              {tr("demo.single.description.a")}<span className="font-semibold text-emerald-700">{tr("demo.single.description.node")}</span>{tr("demo.single.description.b")}<span className="font-semibold text-slate-700">{tr("demo.single.description.docs")}</span>{tr("demo.single.description.c")}<span className="font-semibold text-slate-700">{tr("demo.single.description.cache")}</span>{tr("demo.single.description.d")}<span className="font-semibold text-sky-700">{tr("demo.single.description.ssd")}</span>{tr("demo.single.description.e")}
            </p>
          </div>
          <div className="flex items-center space-x-2 flex-shrink-0">
            <button
              onClick={() => setShowWorkloadInfo(true)}
              className="flex items-center space-x-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
            >
              <Zap className="w-4 h-4" />
              <span>{tr("demo.common.info")}</span>
            </button>
            <button
              onClick={() => setShowHistory(true)}
              className="flex items-center space-x-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
            >
              <Clock className="w-4 h-4" />
              <span>{tr("demo.common.history")}</span>
            </button>
          </div>
        </div>

        {/* Token Context Bar — 多轮累加：取当前轮或最后一轮的 contextTokens（随轮数线性增长） */}
        <ExperimentConfigBanner workloadLabel={tr("demo.single.workload")} />

        <ContextTokenBar
          lmcacheTokens={(() => {
            const r = rounds
              .slice()
              .reverse()
              .find(
                (x) => x.lmcache?.contextTokens && x.lmcache.contextTokens > 0,
              );
            return r?.lmcache?.contextTokens;
          })()}
          infinikvTokens={(() => {
            const r = rounds
              .slice()
              .reverse()
              .find(
                (x) =>
                  x.infinikv?.contextTokens && x.infinikv.contextTokens > 0,
              );
            return r?.infinikv?.contextTokens;
          })()}
          subtitle={
            rounds.length > 0
              ? locale === "en" ? `current round · round ${currentRound?.id ?? activeRound + 1}` : `当前轮次 · 第 ${currentRound?.id ?? activeRound + 1} 轮`
              : undefined
          }
        />

        <MetricDefinitionPanel />

        <ModelMetricsPanel
          title={locale === "en" ? "Key Metrics: Single-Node Long-Context Multi-Round Planning" : "关键指标：单节点长上下文多轮规划收益"}
          model={localizedModelLabel}
          lm={{
            label: "LMCache-DRAM",
            avgTtft: lmTtfts.length ? avg(lmTtfts) : 0,
            totalTtft: totalLm,
            qps: lmQps,
            avgInputTokens: lmInputTokens.length ? avg(lmInputTokens) : 0,
            avgOutputTokens: lmOutputTokens.length ? avg(lmOutputTokens) : 0,
            accent: "orange",
          }}
          ik={{
            label: "InfiniKV (SSD)",
            avgTtft: ikTtfts.length ? avg(ikTtfts) : 0,
            totalTtft: totalIk,
            qps: ikQps,
            avgInputTokens: ikInputTokens.length ? avg(ikInputTokens) : 0,
            avgOutputTokens: ikOutputTokens.length ? avg(ikOutputTokens) : 0,
            accent: "sky",
          }}
          qpsGainPct={qpsGain}
        />

        {/* Config */}
        <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
          <button
            onClick={() => setShowConfig(!showConfig)}
            className="w-full px-6 py-4 flex items-center justify-between text-base font-bold text-gray-900 hover:bg-gray-50 transition-colors"
          >
            <span>{locale === "en" ? "Test Configuration" : "测试配置"}</span>
            <ChevronDown
              className={`w-5 h-5 text-gray-400 transition-transform ${showConfig ? "rotate-180" : ""}`}
            />
          </button>
          {showConfig && (
            <div className="px-6 pb-6 space-y-5 border-t border-gray-200 pt-5">
              <div className="bg-emerald-50/50 border border-emerald-100 rounded-xl p-5">
                <div className="flex items-center space-x-2 mb-3">
                  <Info className="w-4 h-4 text-emerald-500" />
                  <span className="text-sm font-bold text-gray-700">
                    {locale === "en" ? "Scenario Notes" : "场景说明"}
                  </span>
                </div>
                <div className="text-sm text-gray-500 leading-relaxed">
                  {locale === "en"
                    ? "Each round selects one city/business background document and one delivery strategy question, then sends the same task to LMCache and InfiniKV. This makes the pressure from long documents, multi-round dialogue, and historical prefix reuse visible on a single dispatch node."
                    : "每轮选择一份城市/业务背景资料和一个配送策略问题，分别发送给 LMCache 与 InfiniKV 做同题对比。这样可以把“长文本背景 + 多轮对话 + 历史前缀复用”的压力放到单个调度节点上讲清楚。"}
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                  <div className="flex items-center space-x-2 mb-2">
                    <MapPin className="w-4 h-4 text-green-500" />
                    <span className="text-sm font-bold text-gray-700">
                      {locale === "en" ? "Warehouse (South) -> Customer (North)" : "仓库（南）→ 客户（北）"}
                    </span>
                  </div>
                  <div className="text-xs font-mono text-gray-500 space-y-1">
                    <div>
                      {locale === "en" ? "Warehouse" : "仓库"}: [{WAREHOUSE[0]}, {WAREHOUSE[1]}]
                    </div>
                    <div>
                      {locale === "en" ? "Customer" : "客户"}: [{CUSTOMER[0]}, {CUSTOMER[1]}]
                    </div>
                    <div className="text-gray-400">{locale === "en" ? "Straight-line distance ~0.6 deg ~= 67km" : "直线距离 ~0.6度 ≈ 67km"}</div>
                  </div>
                </div>
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                  <div className="flex items-center space-x-2 mb-2">
                    <Building2 className="w-4 h-4 text-amber-500" />
                    <span className="text-sm font-bold text-gray-700">
                      {locale === "en" ? `No-Fly Zone / High-Rise Cluster (${OBSTACLE_ZONES.length})` : `禁飞区 / 高楼群（${OBSTACLE_ZONES.length}个）`}
                    </span>
                  </div>
                  <div className="text-xs font-mono text-gray-500 space-y-1">
                    {OBSTACLE_ZONES.map((d, i) => (
                      <div key={i}>
                        {d.label}: [{d.center[0]}, {d.center[1]}]
                      </div>
                    ))}
                    <div className="text-gray-400">{locale === "en" ? "Located in the middle of the route; detour required" : "位于航线正中间，需绕行"}</div>
                  </div>
                </div>
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                  <div className="flex items-center space-x-2 mb-2">
                    <Info className="w-4 h-4 text-gray-500" />
                    <span className="text-sm font-bold text-gray-700">
                      {locale === "en" ? "Flight Constraints" : "限飞参数"}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 space-y-1">
                    <div>
                      {locale === "en" ? "No-fly radius" : "禁飞半径"}:{" "}
                      <span className="font-mono font-bold">
                        {OBSTACLE_RADIUS.toLocaleString()}m ~= 0.14{locale === "en" ? " deg" : "度"}
                      </span>
                    </div>
                    <div>
                      {locale === "en" ? "Per-round output" : "每轮输出"}:{" "}
                      <span className="font-mono font-bold text-emerald-600">
                        {locale === "en" ? "JSON waypoint list" : "JSON 航点列表"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              {/* Static benchmark document list */}
              <div className="bg-sky-50/40 border border-sky-100 rounded-xl p-4 space-y-2">
                <div className="flex items-center space-x-2">
                  <Paperclip className="w-4 h-4 text-sky-500" />
                  <span className="text-sm font-bold text-gray-700">
                    {locale === "en" ? "Long-Text Background Documents" : "长文本背景资料"}
                  </span>
                  <span className="text-xs font-medium text-sky-700 bg-sky-100 border border-sky-200 px-2 py-0.5 rounded-full">
                    {locale === "en" ? "10 files" : "10 份"}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {DELIVERY_DOCS.map((doc, i) => (
                    <span key={i} className="text-[11px] px-2 py-0.5 rounded-md border border-sky-200 bg-sky-50 text-sky-700">
                      {locale === "en" ? doc.en : doc.zh}
                    </span>
                  ))}
                </div>
                <div className="text-xs text-amber-600 font-medium">
                  {locale === "en"
                    ? "Each round randomly selects one document to simulate revisits across different city/scenario contexts — amplifying long-context KV Cache pressure."
                    : "每轮随机选择其中 1 份拼入 prompt，模拟不同城市/场景资料在单节点中的轮换回访，放大长上下文 KV Cache 体量。"}
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <div>
                  <label className="text-sm text-gray-500 font-medium block mb-1.5">
                    {locale === "en" ? "Output Tokens / Round" : "每轮输出 Token"}
                  </label>
                  <input
                    className="w-full bg-gray-50 border border-gray-200 text-gray-900 rounded-lg px-3 py-2.5 text-sm font-medium"
                    type="number"
                    value={outputLen}
                    onChange={(e) =>
                      setOutputLen(Number(e.target.value || 512))
                    }
                  />
                </div>
                <div>
                  <label className="text-sm text-gray-500 font-medium block mb-1.5">
                    {locale === "en" ? "Planning Rounds" : "迭代轮数"}
                  </label>
                  <select
                    className="w-full bg-gray-50 border border-gray-200 text-gray-900 rounded-lg px-3 py-2.5 text-sm font-medium"
                    value={totalRounds}
                    onChange={(e) => setTotalRounds(Number(e.target.value))}
                  >
                    <option value={10}>{locale === "en" ? "10 rounds" : "10 轮"}</option>
                    <option value={30}>{locale === "en" ? "30 rounds" : "30 轮"}</option>
                    <option value={50}>{locale === "en" ? "50 rounds" : "50 轮"}</option>
                  </select>
                </div>
                <div>
                  <label className="text-sm text-gray-500 font-medium block mb-1.5">
                    {locale === "en" ? "Background Switch Cooldown" : "背景切换间隔"}
                  </label>
                  <select
                    className="w-full bg-gray-50 border border-gray-200 text-gray-900 rounded-lg px-3 py-2.5 text-sm font-medium"
                    value={scenarioCooldown}
                    onChange={(e) =>
                      setScenarioCooldown(Number(e.target.value))
                    }
                  >
                    <option value={0}>{locale === "en" ? "0 · fully random" : "0 · 完全随机"}</option>
                    <option value={1}>{locale === "en" ? "1 · no immediate repeat" : "1 · 不连跳"}</option>
                    <option value={2}>{locale === "en" ? "2 · recommended" : "2 · 推荐"}</option>
                    <option value={3}>{locale === "en" ? "3 · stronger rotation" : "3 · 强轮换"}</option>
                  </select>
                </div>
                <div className="flex items-end gap-4 text-sm text-gray-700 col-span-2">
                  <label className="flex items-center space-x-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={runLMCache}
                      onChange={(e) => setRunLMCache(e.target.checked)}
                      className="accent-orange-500 w-4 h-4"
                    />
                    <span className="flex items-center space-x-1.5">
                      <span className="w-2.5 h-2.5 rounded-full bg-orange-500" />
                      <span className="font-medium">LMCache-DRAM</span>
                    </span>
                  </label>
                  <label className="flex items-center space-x-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={runInfiniKV}
                      onChange={(e) => setRunInfiniKV(e.target.checked)}
                      className="accent-sky-500 w-4 h-4"
                    />
                    <span className="flex items-center space-x-1.5">
                      <span className="w-2.5 h-2.5 rounded-full bg-sky-500" />
                      <span className="font-medium">InfiniKV (SSD)</span>
                    </span>
                  </label>
                </div>
              </div>
              <div className="space-y-2">
                <div className="text-sm text-slate-500 font-semibold">
                  {locale === "en" ? "System Prompt (City Rules and Output Contract)" : "系统 Prompt（城市规则与输出约束）"}
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 max-h-[240px] overflow-y-auto">
                  <pre className="text-xs font-mono text-slate-700 whitespace-pre-wrap leading-relaxed">
                    {locale === "en" ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT}
                  </pre>
                </div>
              </div>

              <div className="space-y-3">
                <div className="text-sm text-gray-500 font-bold">
                  {locale === "en" ? "Strategy Question Pool (one item sampled per round)" : "策略问题池（每轮抽取 1 条形成多轮对话）"}
                </div>
                <div className="space-y-2">
                  {(locale === "en" ? SCENARIO_QUESTIONS_EN : SCENARIO_QUESTIONS).map((inst, idx) => (
                    <div
                      key={idx}
                      className="flex items-start space-x-3 bg-gray-50 border border-gray-200 rounded-lg px-4 py-3"
                    >
                      <span className="text-sm font-mono text-emerald-600 font-bold whitespace-nowrap mr-3 flex-shrink-0">
                        {locale === "en" ? `Strategy ${idx + 1}` : `策略 ${idx + 1}`}
                      </span>
                      <span className="text-sm text-gray-600">{inst}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>


        {/* Active prompt + compact round navigator */}
        {rounds.length > 0 && (
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-4">
            <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-5">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-base font-bold text-gray-900">
                    {locale === "en" ? "Current Multi-Round Strategy Prompt" : "当前多轮策略 Prompt"}
                  </span>
                  <span className="px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 text-xs font-mono font-bold border border-emerald-200">
                    {locale === "en" ? `Round ${currentRound?.id ?? activeRound + 1}` : `第 ${currentRound?.id ?? activeRound + 1} 轮`}
                  </span>
                  <span
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold border ${currentRound?.status === "done"
                      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                      : currentRound?.status === "running"
                        ? "bg-amber-50 text-amber-700 border-amber-200"
                        : "bg-slate-50 text-slate-500 border-slate-200"
                      }`}
                  >
                    {currentRound?.status === "done"
                      ? locale === "en" ? "Done" : "已完成"
                      : currentRound?.status === "running"
                        ? locale === "en" ? "Running" : "执行中"
                        : locale === "en" ? "Pending" : "待执行"}
                  </span>
                </div>
                <div className="text-xs text-slate-500 font-mono">
                  {locale === "en" ? "Current background" : "当前背景资料"}: {currentRound?.sessionLabel || (locale === "en" ? "not selected" : "待选择")}
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3">
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                  <div className="text-xs font-semibold text-slate-500 mb-2">
                    {locale === "en" ? "Strategy Constraint This Round" : "本轮策略约束"}
                  </div>
                  <div className="text-sm text-slate-700 leading-7 whitespace-pre-wrap break-words">
                    {locale === "en"
                      ? SCENARIO_QUESTIONS_EN[((currentRound?.id || 1) - 1) % SCENARIO_QUESTIONS_EN.length] || "The prompt for this round will appear after the run starts."
                      : currentRound?.instruction || "等待开始后显示本轮 prompt"}
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-5">
              <div className="flex items-center justify-between mb-3">
                <span className="text-base font-bold text-gray-900">
                  {locale === "en" ? "Round Navigation" : "轮次导航"}
                </span>
                <span className="text-xs text-slate-500 font-mono">
                  {locale === "en" ? `${rounds.length} rounds` : `共 ${rounds.length} 轮`}
                </span>
              </div>
              <div className="max-h-[240px] overflow-y-auto pr-1">
                <div className="grid grid-cols-4 sm:grid-cols-6 xl:grid-cols-4 gap-2">
                  {rounds.map((r, i) => (
                    <button
                      key={r.id}
                      onClick={() => setActiveRound(i)}
                      title={locale === "en" ? `Round ${r.id} | ${r.sessionLabel || "background not selected"} | ${SCENARIO_QUESTIONS_EN[((r.id || 1) - 1) % SCENARIO_QUESTIONS_EN.length] || "prompt pending"}` : `第 ${r.id} 轮｜${r.sessionLabel || "待选择背景资料"}｜${r.instruction || "待生成 prompt"}`}
                      className={`relative min-w-0 px-3 py-2 rounded-xl text-sm font-bold transition-all border ${activeRound === i
                        ? "bg-emerald-500 text-white border-emerald-500 shadow-md"
                        : r.status === "done"
                          ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
                          : r.status === "running"
                            ? "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100"
                            : "bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-100"
                        }`}
                    >
                      <div className="flex items-center justify-center gap-1.5">
                        <span>{r.id}</span>
                        <span
                          className={`inline-block w-1.5 h-1.5 rounded-full ${activeRound === i
                            ? "bg-white"
                            : r.status === "done"
                              ? "bg-emerald-500"
                              : r.status === "running"
                                ? "bg-amber-500 animate-pulse"
                                : "bg-slate-300"
                            }`}
                        />
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Comparison panels: LEFT LMCache / RIGHT InfiniKV */}
        {rounds.length > 0 && (
          <div
            className={`grid gap-4 ${runLMCache && runInfiniKV ? "grid-cols-1 xl:grid-cols-2" : "grid-cols-1"}`}
          >
            {runLMCache && (
              <ComparisonPanel
                groupLabel="LMCache-DRAM"
                accentColor="bg-orange-50 border-orange-100"
                dotColor="bg-orange-500"
                round={currentRound}
                resultKey="lmcache"
                previousRoutes={lmPrevForActive}
                streamText={currentRound?.lmStreamText || ""}
                mapPhase={currentRound?.lmMapPhase || "idle"}
                onMapAnimDone={() =>
                  updateRound(activeRound, { lmMapPhase: "done" })
                }
                modelLabel={model}
              />
            )}
            {runInfiniKV && (
              <ComparisonPanel
                groupLabel="InfiniKV (SSD)"
                accentColor="bg-sky-100/60"
                dotColor="bg-sky-500"
                round={currentRound}
                resultKey="infinikv"
                previousRoutes={ikPrevForActive}
                streamText={currentRound?.ikStreamText || ""}
                mapPhase={currentRound?.ikMapPhase || "idle"}
                onMapAnimDone={() =>
                  updateRound(activeRound, { ikMapPhase: "done" })
                }
                modelLabel={model}
              />
            )}
          </div>
        )}

        {/* Summary Metrics */}
        {completedRounds.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm">
            <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
              <h3 className="text-xl font-black text-gray-900 tracking-tight">
                {locale === "en" ? "Key Metrics Comparison Table" : "关键指标对比表"}
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-black text-emerald-700 shadow-sm">
                  <div>
                    {locale === "en" ? "TTFT speedup" : "TTFT 性能优化"}{" "}
                    {ttftSpeedupOverall > 0
                      ? `${ttftSpeedupOverall.toFixed(2)}x`
                      : "--"}
                  </div>
                  <div className="mt-0.5 text-[11px] font-semibold text-emerald-700/75">
                    {locale === "en" ? "LM avg TTFT / InfiniKV avg TTFT" : "LM 平均 TTFT ÷ InfiniKV 平均 TTFT"}
                  </div>
                </div>
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-black text-emerald-700 shadow-sm">
                  <div>
                    {locale === "en" ? "QPS speedup" : "QPS 性能提升"}{" "}
                    {qpsSpeedupOverall > 0
                      ? `${qpsSpeedupOverall.toFixed(2)}x`
                      : "--"}
                  </div>
                  <div className="mt-0.5 text-[11px] font-semibold text-emerald-700/75">
                    {locale === "en" ? "InfiniKV QPS / LM QPS" : "InfiniKV QPS ÷ LM QPS"}
                  </div>
                </div>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px]">
                <thead>
                  <tr className="text-left text-sm text-gray-500 border-b border-gray-200">
                    <th className="py-2.5 px-3 font-semibold">{locale === "en" ? "System" : "系统"}</th>
                    <th className="py-2.5 px-3 font-semibold">{locale === "en" ? "Model" : "模型"}</th>
                    <th className="py-2.5 px-3 font-semibold">{locale === "en" ? "Avg Input" : "平均输入"}</th>
                    <th className="py-2.5 px-3 font-semibold">{locale === "en" ? "Avg Output" : "平均输出"}</th>
                    <th className="py-2.5 px-3 font-semibold">{locale === "en" ? "Total TTFT" : "累计 TTFT"}</th>
                    <th className="py-2.5 px-3 font-semibold">{locale === "en" ? "Avg TTFT" : "平均 TTFT"}</th>
                    <th className="py-2.5 px-3 font-semibold">{locale === "en" ? "Estimated QPS" : "估算 QPS"}</th>
                  </tr>
                </thead>
                <tbody>
                  {runLMCache && (
                    <tr className="border-b border-gray-100 bg-orange-50/40">
                      <td className="py-3 px-3 text-base font-bold text-orange-700">
                        LMCache-DRAM
                      </td>
                      <td className="py-3 px-3 text-base font-mono font-semibold text-gray-800">
                        {localizedModelLabel}
                      </td>
                      <td className="py-3 px-3 text-base font-mono font-bold text-gray-900">
                        {lmInputTokens.length
                          ? `${Math.round(avg(lmInputTokens)).toLocaleString()} tk`
                          : "--"}
                      </td>
                      <td className="py-3 px-3 text-base font-mono font-bold text-gray-900">
                        {lmOutputTokens.length
                          ? `${Math.round(avg(lmOutputTokens)).toLocaleString()} tk`
                          : "--"}
                      </td>
                      <td className="py-3 px-3 text-xl font-mono font-black text-orange-700">
                        {totalLm > 0 ? `${totalLm.toFixed(2)}s` : "--"}
                      </td>
                      <td className="py-3 px-3 text-xl font-mono font-black text-orange-700">
                        {lmTtfts.length ? `${avg(lmTtfts).toFixed(3)}s` : "--"}
                      </td>
                      <td className="py-3 px-3 text-xl font-mono font-black text-orange-700">
                        {lmQps > 0 ? lmQps.toFixed(2) : "--"}
                      </td>
                    </tr>
                  )}
                  {runInfiniKV && (
                    <tr className="bg-sky-50/40">
                      <td className="py-3 px-3 text-base font-bold text-sky-700">
                        InfiniKV (SSD)
                      </td>
                      <td className="py-3 px-3 text-base font-mono font-semibold text-gray-800">
                        {localizedModelLabel}
                      </td>
                      <td className="py-3 px-3 text-base font-mono font-bold text-gray-900">
                        {ikInputTokens.length
                          ? `${Math.round(avg(ikInputTokens)).toLocaleString()} tk`
                          : "--"}
                      </td>
                      <td className="py-3 px-3 text-base font-mono font-bold text-gray-900">
                        {ikOutputTokens.length
                          ? `${Math.round(avg(ikOutputTokens)).toLocaleString()} tk`
                          : "--"}
                      </td>
                      <td className="py-3 px-3 text-xl font-mono font-black text-sky-700">
                        {totalIk > 0 ? `${totalIk.toFixed(2)}s` : "--"}
                      </td>
                      <td className="py-3 px-3 text-xl font-mono font-black text-sky-700">
                        <div>
                          {ikTtfts.length
                            ? `${avg(ikTtfts).toFixed(3)}s`
                            : "--"}
                        </div>
                        
                      </td>
                      <td className="py-3 px-3 text-xl font-mono font-black text-sky-700">
                        <div>{ikQps > 0 ? ikQps.toFixed(2) : "--"}</div>
                        
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TTFT Trend */}
        {chartData.length > 1 && (
          <div className="bg-white border border-gray-200 rounded-2xl p-8 shadow-sm">
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
                <h3 className="text-xl font-black text-gray-900 tracking-tight">
                  {locale === "en" ? "Per-Round TTFT Trend" : "各轮次 TTFT 趋势"}
                </h3>
                <p className="text-base text-gray-500">
                  {locale === "en" ? "Observe whether first-token latency remains stable as long documents and historical rounds accumulate." : "随着长文本背景和历史轮次累积，观察首字延迟是否保持稳定"}
                </p>
              </div>
              <div className="flex justify-center w-full">
                <LegendChips
                  className="justify-center"
                  items={[
                    {
                      label: "LMCache-DRAM",
                      colorClass: "bg-orange-50 border-orange-200",
                      textClass: "text-orange-700",
                    },
                    {
                      label: "InfiniKV (SSD)",
                      colorClass: "bg-sky-100 border-sky-300",
                      textClass: "text-sky-700",
                    },
                  ]}
                />
              </div>
            </div>
            <ResponsiveContainer width="100%" height={350}>
              <LineChart
                data={chartData}
                margin={{ top: 5, right: 30, left: 20, bottom: 20 }}
              >
                <CartesianGrid
                  vertical={false}
                  stroke="#F3F4F6"
                  strokeDasharray="4 4"
                />
                <XAxis
                  dataKey="name"
                  stroke="transparent"
                  fontSize={16}
                  fontWeight={700}
                  tickLine={false}
                  axisLine={false}
                  dy={10}
                  tick={{ fill: "#4B5563" }}
                />
                <YAxis
                  stroke="transparent"
                  fontSize={15}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: "#6B7280" }}
                  unit="s"
                  label={{
                    value: locale === "en" ? "TTFT (s)" : "TTFT (秒)",
                    angle: -90,
                    position: "insideLeft",
                    fill: "#6B7280",
                    fontSize: 14,
                    fontWeight: 700,
                    dx: -8,
                  }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#fff",
                    border: "none",
                    borderRadius: "12px",
                    fontSize: "14px",
                    padding: "14px 18px",
                    boxShadow: "0 8px 30px rgba(0,0,0,0.12)",
                  }}
                  labelStyle={{
                    fontWeight: 700,
                    marginBottom: 8,
                    fontSize: 15,
                  }}
                  cursor={{ stroke: "#E5E7EB", strokeWidth: 1 }}
                />
                <Line
                  type="monotone"
                  dataKey="lmcache_ttft"
                  name="LMCache TTFT"
                  stroke="#F97316"
                  strokeWidth={3}
                  dot={{ r: 5, fill: "#F97316", strokeWidth: 0 }}
                  activeDot={{ r: 7, fill: "#F97316" }}
                  animationDuration={1000}
                />
                <Line
                  type="monotone"
                  dataKey="infinikv_ttft"
                  name="InfiniKV TTFT"
                  stroke="#0EA5E9"
                  strokeWidth={3}
                  dot={{ r: 5, fill: "#0EA5E9", strokeWidth: 0 }}
                  activeDot={{ r: 7, fill: "#0EA5E9" }}
                  animationDuration={1000}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <HistoryModal
        open={showHistory}
        onClose={() => setShowHistory(false)}
        currentScenario="drone-delivery"
        onLoadRecord={handleLoadRecord}
        onNavigateAndLoad={handleNavigateAndLoad}
      />
      <WorkloadInfoModal
        open={showWorkloadInfo}
        onClose={() => setShowWorkloadInfo(false)}
        scenario="drone-delivery"
      />
    </div>
  );
}
