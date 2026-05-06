"use client";

/**
 * 场景 07：压力测试 — 把 DRAM 跑满、强制 SSD 发挥作用。
 *
 * 这个页面和其他六个 demo 都不一样：
 *   - 其他 demo 是"业务场景演示"，关注单次输出质量；
 *   - 这个 demo 是"系统压测"，只关注 TTFT 和 cache 命中率曲线。
 *
 * 两种模式：
 *   A. 多 PDF 轮询：上传 3~10 份 PDF，每轮随机挑 1 份 + 1 个问题。
 *      跑 50+ 轮后 LMCache 100GB DRAM 装不下所有 session → 开始淘汰。
 *      InfiniKV 能从 SSD 捞回之前的 KV → TTFT 稳。这是论文 Fig.10 场景。
 *   B. 单 PDF 高并发：上传 1 份大 PDF，每轮同时发 N 个不同角色的问题。
 *      多租户压测，对应论文 LEval workload。
 *
 * 关键可视化（右侧主图）：
 *   - TTFT 时间线（每轮 1 个点，LMCache 红线 vs InfiniKV 蓝线）
 *   - Cache hit rate 曲线（两条线）
 *   - DRAM / SSD 容量占用进度条（实时）
 *   - 左侧窄栏：当前跑到第几轮 + 活跃 PDF 列表
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2, Paperclip, X, Activity, ChevronDown, Info, Clock, Zap,
  FileText, AlertCircle,
} from "lucide-react";
import { getCachedLatestRecord, getHistory, saveRecord, type TestRecord } from "@/lib/history";
import HistoryModal from "@/components/HistoryModal";
import WorkloadInfoModal from "@/components/WorkloadInfoModal";
import LegendChips from "@/components/LegendChips";
import {
  LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";
import { getApiBase } from "@/lib/api";
import ContextTokenBar from "@/components/ContextTokenBar";
import { t, useLocale } from "@/lib/i18n";

/* ────────────────── Types ────────────────── */

type UploadedDoc = {
  id: string;           // 客户端生成的 session id
  name: string;
  text: string;         // PDF 抽取后文本
  estTokens: number;
};

type RoundMetrics = {
  round: number;          // 1-based
  sessionId: string;      // 本轮使用的 PDF 会话
  question: string;
  lmTtft: number;
  lmTps: number;
  lmPrefixHit: number;    // 0-1
  lmExtHit: number | null;
  lmContextTokens: number;
  ikTtft: number;
  ikTps: number;
  ikPrefixHit: number;
  ikExtHit: number | null;
  ikContextTokens: number;
};

type PreparedDocContext = {
  preparedPrefix: string;
  fittedTokens: number;
  inputBudget: number;
};

/* ────────────────── 预设问题池 ──────────────────
 * 每轮随机挑一个，让同一 PDF 的不同轮产生不同尾部 → 前缀命中、后缀变化
 */
const QUESTION_POOL: string[] = [
  "请概括本文档的核心主题、目标受众和关键结论。",
  "提取文中所有量化数据（性能指标、百分比、对比数值），按重要性排序并解释含义。",
  "识别文档中的核心技术方案或商业策略，分析其优势和潜在风险。",
  "对比文中讨论的不同方案或观点，列出各自的适用场景和局限性。",
  "基于以上分析，给出 3 条可落地的行动建议，并说明优先级和预期收益。",
  "文档中提到的关键术语和专有名词有哪些？给出准确定义。",
  "把本文档的主要章节总结为一张目录大纲，每个章节 1 句话描述。",
  "识别文档中的所有假设条件和前置依赖，评估若假设不成立时结论的鲁棒性。",
  "归纳文档采用的研究方法、实验设计与评估基线，判断结论的可信度。",
  "文中提到的最大创新点是什么？与已有主流方案相比有多大改进？",
  "这份文档的局限性和尚未回答的问题有哪些？下一步工作是什么？",
  "从投资/商业化角度评估文档技术方案的市场潜力。",
  "提取文中涉及的所有系统组件、依赖和部署要求，整理为一份运维清单。",
  "基于文档内容，模拟一场 QA，列出 5 个最可能被质疑的问题并回答。",
  "用 1 段话向一个没有技术背景的外行解释本文档讲了什么。",
  "综合全文，给一份给 CEO 的执行摘要：核心发现、风险、建议（每项 1 行）。",
];

const genId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const avgOf = (nums: number[]) => {
  const valid = nums.filter(n => Number.isFinite(n) && n > 0);
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
};

const formatTokenCount = (tokens: number) => {
  if (!Number.isFinite(tokens) || tokens <= 0) return "--";
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens >= 10000 ? 1 : 2)}K tk`;
  return `${Math.round(tokens)} tk`;
};

const estimateQps = (ttft: number, tps: number, outputTokens: number, concurrent: number) => {
  if (!(ttft > 0) || !(tps > 0) || !(outputTokens > 0) || !(concurrent > 0)) return 0;
  const serviceTimeSec = ttft + outputTokens / tps;
  return serviceTimeSec > 0 ? concurrent / serviceTimeSec : 0;
};



type ScopeMetrics = {
  avgTtft: number;
  qps: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  totalTtft?: number;
  peakTtft?: number;
};

type ScopedSystemMetrics = {
  label: string;
  accent: "orange" | "sky";
  global: ScopeMetrics;
  recent: ScopeMetrics;
};

function fmtGain(v: number) {
  return Number.isFinite(v) && v > 0 ? `${v.toFixed(2)}x` : "--";
}

function fmtGainPct(v: number) {
  if (!Number.isFinite(v)) return "--";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function scopeTone(scope: "global" | "recent") {
  return scope === "recent"
    ? {
      wrap: "border-emerald-200 bg-emerald-50",
      title: "text-emerald-800",
      chip: "border-emerald-200 bg-white text-emerald-700",
      helper: "text-emerald-700/80",
      value: "text-emerald-700",
    }
    : {
      wrap: "border-slate-200 bg-white",
      title: "text-slate-900",
      chip: "border-slate-200 bg-slate-50 text-slate-600",
      helper: "text-slate-500",
      value: "text-slate-900",
    };
}

function ScopeGainCard({
  title,
  value,
  helper,
  scope,
}: {
  title: string;
  value: number;
  helper: string;
  scope: "global" | "recent";
}) {
  const [locale] = useLocale();
  const tone = scopeTone(scope);
  return (
    <div className={`relative overflow-hidden rounded-2xl border px-5 py-4 shadow-sm ${tone.wrap}`}>
      <div className={`absolute inset-y-0 left-0 w-1 ${scope === "recent" ? "bg-emerald-500" : "bg-slate-300"}`} />
      <div className="pl-2">
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className={`text-xs font-black tracking-widest uppercase ${tone.title}`}>
            {title}
          </div>
          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-black ${tone.chip}`}>
            {scope === "recent" ? (locale === "en" ? "Latest 20" : "最近20轮") : (locale === "en" ? "Global 1..N" : "全局 1..N")}
          </span>
        </div>
        <div className="flex items-end gap-1.5">
          <span className={`text-4xl md:text-5xl font-black leading-none ${tone.value}`}>
            {Number.isFinite(value) && value > 0 ? value.toFixed(2) : "--"}
          </span>
          <span className={`text-2xl font-black mb-1 ${tone.value}`}>x</span>
        </div>
        <div className={`text-xs mt-2 font-semibold leading-relaxed ${tone.helper}`}>
          {helper}
        </div>
      </div>
    </div>
  );
}

function ModelMetricsPanel({
  title,
  model,
  completedRounds,
  recentWindow,
  lm,
  ik,
}: {
  title: string;
  model: string;
  completedRounds: number;
  recentWindow: number;
  lm: ScopedSystemMetrics;
  ik: ScopedSystemMetrics;
}) {
  const [locale] = useLocale();
  const isEn = locale === "en";
  const globalTtftSpeedup =
    lm.global.avgTtft > 0 && ik.global.avgTtft > 0 ? lm.global.avgTtft / ik.global.avgTtft : 0;
  const recentTtftSpeedup =
    lm.recent.avgTtft > 0 && ik.recent.avgTtft > 0 ? lm.recent.avgTtft / ik.recent.avgTtft : 0;
  const globalQpsSpeedup =
    lm.global.qps > 0 && ik.global.qps > 0 ? ik.global.qps / lm.global.qps : 0;
  const recentQpsSpeedup =
    lm.recent.qps > 0 && ik.recent.qps > 0 ? ik.recent.qps / lm.recent.qps : 0;
  const globalQpsGainPct = globalQpsSpeedup > 0 ? (globalQpsSpeedup - 1) * 100 : 0;
  const recentQpsGainPct = recentQpsSpeedup > 0 ? (recentQpsSpeedup - 1) * 100 : 0;

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-6 md:p-7 shadow-sm space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <h3 className="text-2xl font-black text-slate-900 tracking-tight">
              {title}
            </h3>
            <span className="text-xs font-mono font-semibold px-2.5 py-1 rounded-md bg-slate-100 text-slate-600 border border-slate-200">
              {isEn ? "Model" : "模型"} {model}
            </span>
          </div>
          <p className="text-sm text-slate-500 leading-relaxed max-w-3xl">
            {isEn
              ? `LMCache-DRAM uses 64GB DRAM as the baseline; InfiniKV uses 512GB SSD as the extension tier. Two scopes are shown: global rounds 1..N for end-to-end cost, and the latest ${recentWindow || 20} rounds for steady-state performance after a long run.`
              : `LMCache-DRAM 使用 64GB DRAM 作为基线，InfiniKV 使用 512GB SSD 作为扩展层。这里分成两套口径：全局 1..N 轮用于看端到端总成本，最近 ${recentWindow || 20} 轮用于看系统进入长跑后的稳态表现。`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-black text-slate-600">
            {isEn ? `${completedRounds} rounds done` : `已完成 ${completedRounds} 轮`}
          </span>
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-black text-emerald-700">
            {isEn ? `Latest ${recentWindow || 0} rounds` : `最近窗口 ${recentWindow || 0} 轮`}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-slate-200 bg-slate-50/40 p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <div className="text-lg font-black text-slate-900">{isEn ? "Global Performance" : "全局性能比较"}</div>
              <div className="text-xs font-semibold text-slate-500 mt-0.5">{isEn ? "Scope: rounds 1 to N" : "统计范围：第 1 轮到第 N 轮"}</div>
            </div>
            <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-black text-slate-500">
              {isEn ? "White" : "白底"}
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ScopeGainCard
              title={isEn ? "TTFT SPEEDUP" : "TTFT 性能优化"}
              value={globalTtftSpeedup}
              helper={isEn ? "LM global avg TTFT / InfiniKV global avg TTFT" : "LM 全局平均 TTFT ÷ InfiniKV 全局平均 TTFT"}
              scope="global"
            />
            <ScopeGainCard
              title={isEn ? "QPS SPEEDUP" : "QPS 性能提升"}
              value={globalQpsSpeedup}
              helper={isEn ? `InfiniKV global QPS / LM global QPS, about ${globalQpsSpeedup > 0 ? fmtGainPct(globalQpsGainPct) : "--"}` : `InfiniKV 全局 QPS ÷ LM 全局 QPS，约 ${globalQpsSpeedup > 0 ? fmtGainPct(globalQpsGainPct) : "--"}`}
              scope="global"
            />
          </div>
        </div>

        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <div className="text-lg font-black text-emerald-900">{isEn ? "Latest 20-Round Steady-State" : "最近20轮稳态性能比较"}</div>
              <div className="text-xs font-semibold text-emerald-700/80 mt-0.5">
                {isEn ? `Scope: last ${recentWindow || 0} rounds; all rounds if N<20` : `统计范围：最后 ${recentWindow || 0} 轮，N<20 时取全部`}
              </div>
            </div>
            <span className="rounded-full border border-emerald-200 bg-white px-2 py-0.5 text-[11px] font-black text-emerald-700">
              {isEn ? "Green" : "绿色底"}
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ScopeGainCard
              title={isEn ? "TTFT SPEEDUP" : "TTFT 性能优化"}
              value={recentTtftSpeedup}
              helper={isEn ? "LM latest-20 avg TTFT / InfiniKV latest-20 avg TTFT" : "LM 最近20轮平均 TTFT ÷ InfiniKV 最近20轮平均 TTFT"}
              scope="recent"
            />
            <ScopeGainCard
              title={isEn ? "QPS SPEEDUP" : "QPS 性能提升"}
              value={recentQpsSpeedup}
              helper={isEn ? `InfiniKV latest-20 QPS / LM latest-20 QPS, about ${recentQpsSpeedup > 0 ? fmtGainPct(recentQpsGainPct) : "--"}` : `InfiniKV 最近20轮 QPS ÷ LM 最近20轮 QPS，约 ${recentQpsSpeedup > 0 ? fmtGainPct(recentQpsGainPct) : "--"}`}
              scope="recent"
            />
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
              ? "LMCache-DRAM uses 64GB DRAM to extend KV Cache storage, while InfiniKV uses 512GB SSD. The experiment focuses on latest-20-round TTFT, QPS, and hit-rate differences after the long run reaches steady state."
              : "LMCache-DRAM 仅使用 64GB DRAM 扩展 KV Cache 存储空间，InfiniKV 仅使用 512GB SSD 扩展 KV Cache 存储空间。实验重点观察长跑进入稳态后，两个方案在最近20轮 TTFT、QPS 和命中率上的差异。"}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full">
          <div className="relative overflow-hidden rounded-2xl border border-orange-200 bg-white p-4 shadow-sm">
            <div className="absolute left-0 top-0 h-full w-1.5 bg-orange-500" />
            <div className="pl-3">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-orange-500" />
                  <div className="text-base font-black text-orange-700">LMCache-DRAM</div>
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
                  <span className="max-w-[68%] text-right text-sm font-bold leading-snug text-orange-800">{isEn ? "Limited capacity; steady-state long runs more easily evict old session KV Cache" : "容量有限，稳态长跑后更容易淘汰旧 session KV Cache"}</span>
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
                  <div className="text-base font-black text-sky-700">InfiniKV (SSD)</div>
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
                  <span className="max-w-[68%] text-right text-sm font-bold leading-snug text-sky-800">{isEn ? "Larger capacity; keeps KV Cache evicted from DRAM and recalls it from SSD" : "容量更大，可保留被 DRAM 挤出的 KV Cache 并从 SSD 召回"}</span>
                </div>
              </div>
            </div>
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
        <h3 className="text-xl font-black text-gray-900 tracking-tight">{isEn ? "Metric Definitions and Formulas" : "指标含义与计算方式"}</h3>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="rounded-xl border border-gray-200 bg-gray-50/70 p-4">
          <div className="text-sm font-black text-gray-900 mb-1">{isEn ? "TTFT (Global + Latest 20)" : "TTFT（全局 + 最近20）"}</div>
          <p className="text-sm text-gray-600 leading-relaxed">{isEn ? "Shows both global 1..N average and latest-20-round steady-state average to distinguish overall degradation from steady-state behavior." : "同时展示 1..N 轮全局平均与最近20轮稳态平均，用来区分整体退化和稳态表现。"}</p>
          <div className="mt-2 text-xs font-mono text-gray-500">{isEn ? "avg TTFT[global] + avg TTFT[latest 20]" : "平均TTFT[全局] + 平均TTFT[最近20]"}</div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-gray-50/70 p-4">
          <div className="text-sm font-black text-gray-900 mb-1">{isEn ? "Peak TTFT (Latest 20)" : "峰值 TTFT（最近20）"}</div>
          <p className="text-sm text-gray-600 leading-relaxed">{isEn ? "Tracks peak TTFT over the latest 20 rounds to observe long-tail jitter caused by DRAM eviction in steady state." : "仅统计最近20轮峰值，重点观察稳态阶段 DRAM 淘汰带来的长尾波动。"}</p>
          <div className="mt-2 text-xs font-mono text-gray-500">{isEn ? "max(TTFT[latest 20]), lower means more stable" : "max(TTFT[最近20])，越低越稳定"}</div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-gray-50/70 p-4">
          <div className="text-sm font-black text-gray-900 mb-1">{isEn ? "Est. QPS (Global + Latest 20)" : "估算 QPS（全局 + 最近20）"}</div>
          <p className="text-sm text-gray-600 leading-relaxed">{isEn ? "Estimated throughput from TTFT, TPS, and output length; shown in both global and latest-20 scopes." : "基于 TTFT、TPS 与输出长度估算吞吐，展示全局与最近20轮两套口径。"}</p>
          <div className="mt-2 text-xs font-mono text-gray-500">{isEn ? "concurrency / (TTFT + output/TPS), higher is better" : "并发 / (TTFT + 输出/TPS)，越高越好"}</div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-gray-50/70 p-4">
          <div className="text-sm font-black text-gray-900 mb-1">{isEn ? "Cache Hit Rate" : "Cache 命中率"}</div>
          <p className="text-sm text-gray-600 leading-relaxed">{isEn ? "Tracks GPU prefix hit, DRAM KV Cache hit, and InfiniKV SSD hit to distinguish GPU memory reuse, DRAM-tier hits, and SSD-tier recalls." : "同时观察 GPU prefix hit、DRAM KV Cache hit 与 InfiniKV SSD Hit，区分显存复用、内存层命中和 SSD 层召回。"}</p>
          <div className="mt-2 text-xs font-mono text-gray-500">{isEn ? "higher hit rate = fewer repeated prefills" : "命中率越高，重复 prefill 越少"}</div>
        </div>
      </div>
    </div>
  );
}

/*
 * 参数释义模块已按需求注释掉。
function ParameterDefinitionPanel({
  docCount,
  totalRounds,
  cooldownRounds,
  outputLen,
}: {
  docCount: number;
  totalRounds: number;
  cooldownRounds: number;
  outputLen: number;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-6 md:p-7 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <Info className="w-5 h-5 text-sky-500" />
        <h3 className="text-xl font-black text-gray-900 tracking-tight">
          参数释义
        </h3>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="rounded-xl border border-gray-200 bg-gray-50/70 p-4">
          <div className="text-sm font-black text-gray-900 mb-1">工作集文档数</div>
          <p className="text-sm text-gray-600 leading-relaxed">
            上传的 PDF/TXT/MD 文档数量，每份文档会形成一个独立 session 工作集。
          </p>
          <div className="mt-2 text-xs font-mono text-gray-500">
            当前 {docCount} 份，建议 3~10 份
          </div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-gray-50/70 p-4">
          <div className="text-sm font-black text-gray-900 mb-1">压测总轮数</div>
          <p className="text-sm text-gray-600 leading-relaxed">
            连续发送请求的总轮次，用于观察长时间运行后 DRAM 淘汰与 SSD 召回效果。
          </p>
          <div className="mt-2 text-xs font-mono text-gray-500">
            当前 {totalRounds} 轮，轮数越多越容易进入稳态
          </div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-gray-50/70 p-4">
          <div className="text-sm font-black text-gray-900 mb-1">会话切换间隔</div>
          <p className="text-sm text-gray-600 leading-relaxed">
            最近 N 轮访问过的文档暂不重复选择，强制在多个 session 之间轮换。
          </p>
          <div className="mt-2 text-xs font-mono text-gray-500">
            当前 {cooldownRounds >= 999 ? "∞" : cooldownRounds}，越大越接近纯轮询
          </div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-gray-50/70 p-4">
          <div className="text-sm font-black text-gray-900 mb-1">每请求输出 Token</div>
          <p className="text-sm text-gray-600 leading-relaxed">
            控制每轮回答的生成长度，QPS 会按 TTFT 与输出生成时间共同估算。
          </p>
          <div className="mt-2 text-xs font-mono text-gray-500">
            当前 {outputLen} token，参与 QPS 估算
          </div>
        </div>
      </div>
    </div>
  );
}

 */

const STRESS_DOCS: { zh: string; en: string }[] = [
  { zh: "业务场景资料-A.md",       en: "Business-Scenario-Doc-A.md" },
  { zh: "业务场景资料-B.md",       en: "Business-Scenario-Doc-B.md" },
  { zh: "城市背景资料-北区.md",    en: "City-Background-North-Zone.md" },
  { zh: "城市背景资料-南区.md",    en: "City-Background-South-Zone.md" },
  { zh: "运营规则手册-卷一.md",    en: "Operations-Manual-Vol-1.md" },
  { zh: "运营规则手册-卷二.md",    en: "Operations-Manual-Vol-2.md" },
  { zh: "历史订单数据-Q1.md",      en: "Historical-Orders-Q1.md" },
  { zh: "历史订单数据-Q2.md",      en: "Historical-Orders-Q2.md" },
  { zh: "系统日志记录-第1周.md",   en: "System-Log-Week-1.md" },
  { zh: "系统日志记录-第2周.md",   en: "System-Log-Week-2.md" },
];

/* ────────────────── Page ────────────────── */

export default function StressTestPage() {
  const [locale] = useLocale();
  const tr = (key: Parameters<typeof t>[1]) => t(locale, key);
  const [apiBase, setApiBase] = useState("");
  useEffect(() => { setApiBase(getApiBase()); }, []);

  const [model] = useState("llama3.1-8b-instruct");
  const modelLabel = locale === "en" ? "llama3.1-8b-instruct · 128K window" : "llama3.1-8b-instruct · 128K 窗口";
  const [outputLen, setOutputLen] = useState(256);
  const [totalRounds, setTotalRounds] = useState(50);
  // 模式 A 专用：最近 N 轮出现过的 PDF 不再挑，强制会话切换。
  // 越大越逼近 "轮询所有 session" 的模式 → DRAM LRU 必然淘汰最早的会话。
  const [cooldownRounds, setCooldownRounds] = useState(3);

  const [docs, setDocs] = useState<UploadedDoc[]>([]);
  const [targetInputBudget, setTargetInputBudget] = useState(131072);
  const docInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const [isRunning, setIsRunning] = useState(false);
  const stopFlagRef = useRef(false);
  const [currentRound, setCurrentRound] = useState(0);
  const [metrics, setMetrics] = useState<RoundMetrics[]>([]);
  const metricsRef = useRef<RoundMetrics[]>([]);
  useEffect(() => { metricsRef.current = metrics; }, [metrics]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");

  const [showHistory, setShowHistory] = useState(false);
  const [showWorkloadInfo, setShowWorkloadInfo] = useState(false);
  const [showConfig, setShowConfig] = useState(true);
  const [prepareHint, setPrepareHint] = useState("");
  const staticModeNotice = () => {
    window.alert(locale === "en" ? "This GitHub Pages build is a static replay. Live upload and inference are disabled." : "当前 GitHub Pages 版本为静态回放，已禁用实时上传和推理。");
  };

  /* ────────── 历史记录加载 ──────────
   * 压测历史不存 metrics 重放（太大），只恢复配置（模式/轮数/切换间隔/每请求输出 Token）
   * + 只读形式展示上次的 metrics 曲线（标记"历史快照"）。
   * 附件不存（PDF 太大），用户需要手动重新上传。
   */
  const [historyMetrics, setHistoryMetrics] = useState<RoundMetrics[] | null>(null);
  const [historyLabel, setHistoryLabel] = useState<string>("");

  const handleLoadRecord = useCallback((record: TestRecord) => {
    setIsRunning(false);
    setActiveSessionId("");
    setShowHistory(false);
    if (typeof record.config?.totalRounds === "number") setTotalRounds(record.config.totalRounds);
    if (typeof record.config?.outputLen === "number") setOutputLen(record.config.outputLen);
    if (typeof record.config?.cooldownRounds === "number") setCooldownRounds(record.config.cooldownRounds);
    const docCount = Number(record.config?.docCount) || 0;
    if (docCount > 0) {
      setDocs(Array.from({ length: docCount }, (_, index) => ({
        id: `history-doc-${index}`,
        name: STRESS_DOCS[index]?.zh || `doc-${index + 1}.md`,
        text: "",
        estTokens: 0,
      })));
    }
    // 如果 record 里有 metrics，用只读历史快照方式展示
    const replay = record.normalizedReplay || record.results;
    if (replay?.metrics && Array.isArray(replay.metrics) && replay.metrics.length > 0) {
      setHistoryMetrics(replay.metrics as RoundMetrics[]);
      setMetrics([]); // 清掉当前 run 的 metrics 避免混淆
      metricsRef.current = [];
      const when = new Date(record.timestamp).toLocaleString(locale === "en" ? "en-US" : "zh-CN");
      setHistoryLabel(locale === "en" ? `History Snapshot · ${when} · ${replay.metrics.length} rounds · ${record.config?.docCount || "?"} documents` : `历史快照 · ${when} · ${replay.metrics.length} 轮 · ${record.config?.docCount || "?"} 份文档`);
    }
  }, [locale]);

  const handleNavigateAndLoad = (record: TestRecord) => {
    sessionStorage.setItem("infinikv_pending_record", JSON.stringify(record));
  };

  // 从别的页面跳过来时（sessionStorage 有 pending）立即加载
  useEffect(() => {
    const pending = sessionStorage.getItem("infinikv_pending_record");
    if (pending) {
      sessionStorage.removeItem("infinikv_pending_record");
      try {
        const record: TestRecord = JSON.parse(pending);
        if (record.scenario === "stress-test") handleLoadRecord(record);
      } catch { /* ignore */ }
      return;
    }
    const cachedLatest = getCachedLatestRecord("stress-test");
    if (cachedLatest && !isRunning) handleLoadRecord(cachedLatest);
    let cancelled = false;
    void (async () => {
      const records = await getHistory("stress-test");
      if (cancelled || records.length === 0) return;
      const latest = records.slice().sort((a, b) => b.timestamp - a.timestamp)[0];
      if (latest && !isRunning) handleLoadRecord(latest);
    })();
    return () => { cancelled = true; };
  }, [handleLoadRecord]);

  // 点击"开始压测"时自动清掉历史快照（它和当前 run 是互斥的）
  const clearHistorySnapshot = () => { setHistoryMetrics(null); setHistoryLabel(""); };

  /* ────────── PDF 上传 ────────── */
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
    const newDocs: UploadedDoc[] = [];
    for (const file of Array.from(files)) {
      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      try {
        let text = "";
        if (ext === "pdf") {
          const arr = await file.arrayBuffer();
          const fileB64 = arrayBufferToBase64(arr);
          const res = await fetch(`${apiBase}/disabled/attachments/extract-pdf`, {
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
          id: genId(),
          name: file.name,
          text,
          estTokens: Math.floor(text.length / 1.5),
        });
      } catch (err: any) {
        alert(`文件 ${file.name} 解析失败：${err?.message}`);
      }
    }
    setDocs(prev => [...prev, ...newDocs]);
    setUploading(false);
    if (docInputRef.current) docInputRef.current.value = "";
  };

  const removeDoc = (id: string) => setDocs(prev => prev.filter(d => d.id !== id));
  const clearAllDocs = () => setDocs([]);

  const prepareOneDoc = async (doc: UploadedDoc): Promise<PreparedDocContext> => {
    const res = await fetch(`${apiBase}/disabled/benchmark/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        contextLen: 128000,
        outputLen,
        documentText: doc.text,
        prefixReuseRate: 100,
        segmentCount: 1,
        groupName: "LMCache-DRAM",
      }),
    });
    const data = await res.json();
    if (!res.ok || !data?.preparedPrefix) {
      throw new Error(data?.detail || `文档 ${doc.name} 预处理失败`);
    }
    return {
      preparedPrefix: String(data.preparedPrefix || ""),
      fittedTokens: Number(data.fittedContextTokens) || 0,
      inputBudget: Number(data.inputBudget) || 131072,
    };
  };

  const prepareDocsForRun = async (): Promise<Record<string, PreparedDocContext>> => {
    const map: Record<string, PreparedDocContext> = {};
    let latestBudget = targetInputBudget;
    for (const doc of docs) {
      const prepared = await prepareOneDoc(doc);
      map[doc.id] = prepared;
      if (prepared.inputBudget > 0) latestBudget = prepared.inputBudget;
    }
    setTargetInputBudget(latestBudget);
    return map;
  };

  /* ────────── 单请求：同时打两个后端 ────────── */
  const runOneSide = async (
    group: "LMCache-DRAM" | "InfiniKV",
    systemContent: string,
    userContent: string,
  ) => {
    const messages = [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ];
    try {
      const res = await fetch(`${apiBase}/disabled/benchmark/run`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model, scenario: "stress_test", contextLen: 128000, contextBucket: 128000,
          prefixReuseRate: 90, concurrent: 1, outputLen, ttftSloSec: 5,
          messages, groupName: group,
        }),
      });
      const data = await res.json();
      const item = data?.data?.[0] || {};
      const extRaw = item.external_hit_rate;
      return {
        ttft: item.ttft || 0,
        tps: item.tps || 0,
        prefixHit: typeof item.prefix_hit_rate === "number" && item.prefix_hit_rate >= 0 ? item.prefix_hit_rate : 0,
        extHit: typeof extRaw === "number" && extRaw >= 0 ? extRaw : null,
        contextTokens: item.actual_chat_input_tokens || 0,
      };
    } catch {
      return { ttft: 0, tps: 0, prefixHit: 0, extHit: null, contextTokens: 0 };
    }
  };

  /* ────────── 压测主循环 ────────── */
  const buildSystem = (doc: UploadedDoc, prepared?: PreparedDocContext) => {
    const content = prepared?.preparedPrefix || doc.text;
    return `你是一个严谨的文档分析助手。请基于下方资料回答用户问题。\n\n===== 文档开始 =====\n${content}\n===== 文档结束 =====`;
  };

  const runBenchmark = async () => {
    if (isRunning) return;
    if (docs.length === 0) { alert("请先上传至少 1 份文档"); return; }
    setIsRunning(true);
    stopFlagRef.current = false;
    setMetrics([]);
    metricsRef.current = [];
    setCurrentRound(0);
    clearHistorySnapshot(); // 开始新 run 时自动清掉历史快照

    try {
      setPrepareHint("正在按 token 预算预处理文档工作集...");
      const preparedMap = await prepareDocsForRun();
      setPrepareHint("");
      // 模式 A：每轮挑 1 份 PDF（带 cooldown，不让同 PDF 在最近 N 轮内重复）+ 1 个问题
      const recentDocs: string[] = [];
      for (let r = 1; r <= totalRounds; r++) {
        if (stopFlagRef.current) break;
        setCurrentRound(r);
        const cooldown = Math.min(cooldownRounds, Math.max(0, docs.length - 1));
        const blocked = new Set(recentDocs.slice(-cooldown));
        const candidates = docs.filter(d => !blocked.has(d.id));
        const pool = candidates.length > 0 ? candidates : docs;
        const doc = pool[Math.floor(Math.random() * pool.length)];
        recentDocs.push(doc.id);
        const question = QUESTION_POOL[Math.floor(Math.random() * QUESTION_POOL.length)];
        setActiveSessionId(doc.id);

        const system = buildSystem(doc, preparedMap[doc.id]);
        const [lm, ik] = await Promise.all([
          runOneSide("LMCache-DRAM", system, question),
          runOneSide("InfiniKV", system, question),
        ]);

        const row: RoundMetrics = {
          round: r, sessionId: doc.id, question,
          lmTtft: lm.ttft, lmTps: lm.tps, lmPrefixHit: lm.prefixHit, lmExtHit: lm.extHit, lmContextTokens: lm.contextTokens,
          ikTtft: ik.ttft, ikTps: ik.tps, ikPrefixHit: ik.prefixHit, ikExtHit: ik.extHit, ikContextTokens: ik.contextTokens,
        };
        setMetrics(prev => [...prev, row]);
      }
    } catch (err: any) {
      alert(`压测错误：${err?.message}`);
      setPrepareHint("");
    } finally {
      setIsRunning(false);
      setActiveSessionId("");
      // 保存到 history
      if (metricsRef.current.length > 0) {
        await saveRecord({
          scenario: "stress-test",
          scenarioLabel: "多轮稳态压力测试",
          config: { mode: "multi-pdf", totalRounds, outputLen, cooldownRounds, docCount: docs.length },
          results: { metrics: metricsRef.current },
        });
      }
    }
  };

  const stopBenchmark = () => { stopFlagRef.current = true; };

  /* ────────── 统计 ────────── */
  // 如果加载了历史快照，展示历史快照的 metrics；否则展示当前 run 的 metrics
  const displayMetrics = historyMetrics && historyMetrics.length > 0 ? historyMetrics : metrics;
  const recentWindow = Math.min(20, displayMetrics.length);
  const recentMetrics = displayMetrics.slice(-recentWindow);
  const concurrentFactor = 1;
  const avgInputTokensGlobal = displayMetrics.length
    ? Math.round(displayMetrics.reduce((sum, item) => sum + (item.ikContextTokens || item.lmContextTokens || 0), 0) / displayMetrics.length)
    : 0;
  const avgInputTokensRecent = recentMetrics.length
    ? Math.round(recentMetrics.reduce((sum, item) => sum + (item.ikContextTokens || item.lmContextTokens || 0), 0) / recentMetrics.length)
    : 0;
  const avgOutputTokens = outputLen;
  const lmAvgTtftGlobal = avgOf(displayMetrics.map(m => m.lmTtft));
  const ikAvgTtftGlobal = avgOf(displayMetrics.map(m => m.ikTtft));
  const lmAvgTpsGlobal = avgOf(displayMetrics.map(m => m.lmTps));
  const ikAvgTpsGlobal = avgOf(displayMetrics.map(m => m.ikTps));
  const lmAvgTtftRecent = avgOf(recentMetrics.map(m => m.lmTtft));
  const ikAvgTtftRecent = avgOf(recentMetrics.map(m => m.ikTtft));
  const lmAvgTpsRecent = avgOf(recentMetrics.map(m => m.lmTps));
  const ikAvgTpsRecent = avgOf(recentMetrics.map(m => m.ikTps));
  const lmEstimatedQpsGlobal = estimateQps(lmAvgTtftGlobal, lmAvgTpsGlobal, avgOutputTokens, concurrentFactor);
  const ikEstimatedQpsGlobal = estimateQps(ikAvgTtftGlobal, ikAvgTpsGlobal, avgOutputTokens, concurrentFactor);
  const lmEstimatedQps = estimateQps(lmAvgTtftRecent, lmAvgTpsRecent, avgOutputTokens, concurrentFactor);
  const ikEstimatedQps = estimateQps(ikAvgTtftRecent, ikAvgTpsRecent, avgOutputTokens, concurrentFactor);
  const qpsUpliftGlobal = lmEstimatedQpsGlobal > 0 ? ikEstimatedQpsGlobal / lmEstimatedQpsGlobal : 0;
  const qpsUplift = lmEstimatedQps > 0 ? ikEstimatedQps / lmEstimatedQps : 0;
  const lmMaxTtftRecent = recentMetrics.length ? Math.max(...recentMetrics.map(m => m.lmTtft)) : 0;
  const ikMaxTtftRecent = recentMetrics.length ? Math.max(...recentMetrics.map(m => m.ikTtft)) : 0;
  const speedupGlobal = ikAvgTtftGlobal > 0 ? lmAvgTtftGlobal / ikAvgTtftGlobal : 0;
  const speedup = ikAvgTtftRecent > 0 ? lmAvgTtftRecent / ikAvgTtftRecent : 0;
  const peakSpeedupRecent = ikMaxTtftRecent > 0 ? lmMaxTtftRecent / ikMaxTtftRecent : 0;
  const recentQpsGainPct = lmEstimatedQps > 0 && ikEstimatedQps > 0 ? ((ikEstimatedQps / lmEstimatedQps) - 1) * 100 : 0;
  const latestLmTokens = displayMetrics.length > 0 ? displayMetrics[displayMetrics.length - 1].lmContextTokens : 0;
  const latestIkTokens = displayMetrics.length > 0 ? displayMetrics[displayMetrics.length - 1].ikContextTokens : 0;

  const chartData = displayMetrics.map(m => ({
    round: m.round,
    LMCache: Number(m.lmTtft.toFixed(3)),
    InfiniKV: Number(m.ikTtft.toFixed(3)),
    LMCacheHit: Number((m.lmPrefixHit * 100).toFixed(1)),
    InfiniKVHit: Number((m.ikPrefixHit * 100).toFixed(1)),
    LMCacheExtHit: m.lmExtHit === null ? null : Number((m.lmExtHit * 100).toFixed(1)),
    InfiniKVExtHit: m.ikExtHit === null ? null : Number((m.ikExtHit * 100).toFixed(1)),
  }));

  /* ────────── Render ────────── */
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-8">
        {/* Header */}
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-3 mb-3">
              <span className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-sm font-bold text-slate-700 shadow-sm">
                {tr("demo.stress.badge")}
              </span>
              <span className="text-sm font-medium text-slate-500">
                {tr("demo.stress.tagline")}
              </span>
              <span className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 shadow-sm">
                {tr("demo.common.model")}: {modelLabel}
              </span>
            </div>
            <h1 className="text-4xl font-black text-gray-900 flex items-center space-x-3 tracking-tight">
              <Activity className="w-8 h-8 text-sky-500" />
              <span>{tr("demo.stress.title")}</span>
            </h1>
            <p className="text-slate-500 text-base mt-2 leading-relaxed max-w-3xl">
              {tr("demo.stress.description.a")}<span className="font-semibold text-violet-700">{tr("demo.stress.description.time")}</span>{tr("demo.stress.description.b")}<span className="font-semibold text-emerald-700">{tr("demo.stress.description.window")}</span>{tr("demo.stress.description.c")}<span className="text-orange-700 font-semibold">{tr("demo.stress.description.dram")}</span>{tr("demo.stress.description.d")}<span className="text-sky-700 font-semibold">{tr("demo.stress.description.ssd")}</span>{tr("demo.stress.description.e")}
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

        <ExperimentConfigBanner workloadLabel={tr("demo.stress.workload")} />

        <ContextTokenBar
          lmcacheTokens={latestLmTokens > 0 ? latestLmTokens : undefined}
          infinikvTokens={latestIkTokens > 0 ? latestIkTokens : undefined}
          maxTokens={targetInputBudget}
          subtitle={
            displayMetrics.length > 0
              ? locale === "en"
                ? `latest input LM ${formatTokenCount(latestLmTokens)} / IK ${formatTokenCount(latestIkTokens)} · target budget ${formatTokenCount(targetInputBudget)} · ${displayMetrics.length} rounds`
                : `最近一轮实际输入 LM ${formatTokenCount(latestLmTokens)} / IK ${formatTokenCount(latestIkTokens)} · 目标预算 ${formatTokenCount(targetInputBudget)} · 共 ${displayMetrics.length} 轮`
              : locale === "en"
                ? "context usage (latest actual input vs target budget)"
                : "上下文占用（最近一轮实际输入 vs 目标输入预算）"
          }
        />
        {prepareHint && (
          <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-2 text-sm font-semibold text-sky-700">
            {prepareHint}
          </div>
        )}

        {/* 参数释义模块已按需求注释掉
        <ParameterDefinitionPanel
          docCount={docs.length}
          totalRounds={totalRounds}
          cooldownRounds={cooldownRounds}
          outputLen={outputLen}
        />
        */}

        <MetricDefinitionPanel />

        {(displayMetrics.length > 0 || docs.length > 0) && (
          <ModelMetricsPanel
            title={locale === "en" ? "Key Metrics: Global vs Latest-20-Round Steady State" : "关键指标：全局与最近20轮稳态对比"}
            model={modelLabel}
            completedRounds={displayMetrics.length}
            recentWindow={recentWindow}
            lm={{
              label: "LMCache-DRAM",
              accent: "orange",
              global: {
                avgTtft: lmAvgTtftGlobal,
                totalTtft: displayMetrics.reduce((sum, item) => sum + item.lmTtft, 0),
                qps: lmEstimatedQpsGlobal,
                avgInputTokens: avgInputTokensGlobal,
                avgOutputTokens,
              },
              recent: {
                avgTtft: lmAvgTtftRecent,
                qps: lmEstimatedQps,
                avgInputTokens: avgInputTokensRecent,
                avgOutputTokens,
                peakTtft: lmMaxTtftRecent,
              },
            }}
            ik={{
              label: "InfiniKV (SSD)",
              accent: "sky",
              global: {
                avgTtft: ikAvgTtftGlobal,
                totalTtft: displayMetrics.reduce((sum, item) => sum + item.ikTtft, 0),
                qps: ikEstimatedQpsGlobal,
                avgInputTokens: avgInputTokensGlobal,
                avgOutputTokens,
              },
              recent: {
                avgTtft: ikAvgTtftRecent,
                qps: ikEstimatedQps,
                avgInputTokens: avgInputTokensRecent,
                avgOutputTokens,
                peakTtft: ikMaxTtftRecent,
              },
            }}
          />
        )}

        {/* 测试配置 */}
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
              <div className="bg-gray-50/70 border border-gray-200 rounded-2xl p-5">
                <div className="flex items-center space-x-2 mb-3">
                  <FileText className="w-4 h-4 text-sky-500" />
                  <span className="text-sm font-bold text-gray-700">
                    {locale === "en" ? "Multi-session long run · document working-set rotation" : "多会话长跑 · 文档工作集轮询"}
                  </span>
                </div>
                <div className="text-sm text-gray-500 leading-relaxed">
                  {locale === "en"
                    ? "Upload 3-10 PDF/TXT/MD documents. Each round selects one document session for QA. After a long run, the total KV Cache working set exceeds DRAM capacity; LMCache-DRAM starts evicting and re-prefilling, while InfiniKV recalls evicted KV Cache through the SSD tier."
                    : "上传 3~10 份不同 PDF/TXT/MD，每轮选择 1 份文档会话做 QA。长跑后工作集总 KV Cache 超过 DRAM 容量，LMCache-DRAM 会出现淘汰与重新 prefill；InfiniKV 通过 SSD 层召回被淘汰的 KV Cache。"}
                </div>
              </div>

              <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Paperclip className="w-4 h-4 text-sky-500" />
                  <span className="text-base font-black text-gray-900">
                    {locale === "en" ? "Working Set: Long Documents" : "工作集：长文本资料"}
                  </span>
                  <span className="text-xs text-gray-500">
                    {locale === "en" ? "- multiple documents form a long-running session working set; each round selects one document into the model context" : "— 多份文档组成长期回访的 session 工作集；单轮只选 1 份进入模型上下文"}
                  </span>
                  <span className="text-xs font-medium text-sky-700 bg-sky-100 border border-sky-200 px-2 py-0.5 rounded-full">
                    {locale === "en" ? "10 files" : "10 份"}
                  </span>
                </div>
                <div className="flex-1 flex flex-wrap gap-2 min-h-[42px] rounded-xl border border-gray-200 bg-gray-50/70 p-3">
                  {STRESS_DOCS.map((doc, i) => (
                    <div
                      key={i}
                      className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors border shadow-sm ${activeSessionId === `history-doc-${i}` ? "bg-sky-50 text-sky-800 border-sky-300 ring-2 ring-sky-100" : "bg-white text-gray-600 border-gray-200"}`}
                    >
                      <FileText className="w-3.5 h-3.5" />
                      <span className="max-w-[180px] truncate">{locale === "en" ? doc.en : doc.zh}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="rounded-2xl border border-gray-200 bg-gray-50/70 p-4">
                  <label className="text-sm text-gray-500 font-bold block mb-1.5">{locale === "en" ? "Total Long-Run Rounds" : "长跑总轮数"}</label>
                  <select
                    className="w-full bg-white border border-gray-200 text-gray-900 rounded-xl px-3 py-2.5 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-sky-100 focus:border-sky-300"
                    value={totalRounds}
                    onChange={e => setTotalRounds(Number(e.target.value))}
                  >
                    <option value={20}>{locale === "en" ? "20 rounds · warm-up" : "20 轮 · 预热"}</option>
                    <option value={50}>{locale === "en" ? "50 rounds · basic" : "50 轮 · 基础"}</option>
                    <option value={100}>{locale === "en" ? "100 rounds · standard" : "100 轮 · 标准"}</option>
                    <option value={200}>{locale === "en" ? "200 rounds · long run" : "200 轮 · 长跑"}</option>
                    <option value={500}>{locale === "en" ? "500 rounds · extreme" : "500 轮 · 极限"}</option>
                  </select>
                </div>
                <div className="rounded-2xl border border-gray-200 bg-gray-50/70 p-4">
                  <label className="text-sm text-gray-500 font-bold block mb-1.5" title={locale === "en" ? "Documents selected in the latest N rounds are temporarily blocked to force LRU pressure" : "最近 N 轮挑过的 PDF 不再挑 — 强制 LRU 淘汰"}>
                    {locale === "en" ? "Session Revisit Cooldown" : "会话回访间隔"}
                  </label>
                  <select
                    className="w-full bg-white border border-gray-200 text-gray-900 rounded-xl px-3 py-2.5 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-sky-100 focus:border-sky-300"
                    value={cooldownRounds}
                    onChange={e => setCooldownRounds(Number(e.target.value))}
                  >
                    <option value={0}>{locale === "en" ? "0 · fully random" : "0 · 完全随机"}</option>
                    <option value={1}>{locale === "en" ? "1 · no immediate repeat" : "1 · 不连续重复"}</option>
                    <option value={3}>{locale === "en" ? "3 · recommended" : "3 · 推荐"}</option>
                    <option value={5}>{locale === "en" ? "5 · forced rotation" : "5 · 强制轮询"}</option>
                    <option value={999}>{locale === "en" ? "infinite · pure round-robin" : "∞ · 纯轮询"}</option>
                  </select>
                </div>
                <div className="rounded-2xl border border-gray-200 bg-gray-50/70 p-4">
                  <label className="text-sm text-gray-500 font-bold block mb-1.5">{locale === "en" ? "Output Tokens / Request" : "每请求输出 Token"}</label>
                  <input
                    className="w-full bg-white border border-gray-200 text-gray-900 rounded-xl px-3 py-2.5 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-sky-100 focus:border-sky-300"
                    type="number"
                    value={outputLen}
                    onChange={e => setOutputLen(Number(e.target.value || 256))}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 执行控制 */}
        <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-sky-500" />
            <h3 className="text-xl font-black text-gray-900 tracking-tight">{locale === "en" ? "Benchmark Results" : "测试结果"}</h3>
          </div>
          <p className="text-sm text-gray-500 mt-1">
            {locale === "en"
              ? "The system rotates through the document working set and records TTFT, TPS, GPU/DRAM hits, and SSD recall for LMCache and InfiniKV."
              : "系统轮换访问文档工作集，实时记录 LMCache 与 InfiniKV 的 TTFT、TPS、GPU/DRAM 命中和 SSD 召回情况。"}
          </p>
        </div>

        {/* 进度条 */}
        {(isRunning || displayMetrics.length > 0) && (
          <div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <Activity className="w-5 h-5 text-sky-500" />
                  <h3 className="text-xl font-black text-gray-900 tracking-tight">{locale === "en" ? "Execution Progress" : "执行进度"}</h3>
                </div>
                <p className="text-sm text-gray-500 mt-1">{locale === "en" ? "Current round, completed rounds, and active document session." : "当前轮次、已完成轮次与活跃文档会话状态。"}</p>
              </div>
              <span className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-mono font-bold text-gray-600">
                {metrics.length} / {totalRounds} {locale === "en" ? "rounds" : "轮"}
              </span>
            </div>
            <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-sky-500 rounded-full transition-all duration-200"
                style={{ width: `${Math.min(100, (metrics.length / totalRounds) * 100)}%` }}
              />
            </div>
            {isRunning && (
              <div className="mt-3 flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-700">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>{locale === "en" ? `Round ${currentRound} running (session: ${docs.find(d => d.id === activeSessionId)?.name || "?"})` : `第 ${currentRound} 轮执行中（会话 ${docs.find(d => d.id === activeSessionId)?.name || "?"}）`}</span>
              </div>
            )}
          </div>
        )}

        {/* 历史快照横幅 */}
        {historyMetrics && historyMetrics.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Clock className="w-5 h-5 text-sky-500" />
                  <h3 className="text-xl font-black text-gray-900 tracking-tight">{locale === "en" ? "History Snapshot" : "历史快照"}</h3>
                </div>
                <div className="mt-1 text-sm font-semibold text-gray-600">{historyLabel}</div>
                <div className="mt-1 text-sm text-gray-500">{locale === "en" ? "The charts and metric cards below are a read-only replay of this historical record." : "下面的图表与统计卡是这份历史记录的只读回放。"}</div>
              </div>
              <button
                onClick={clearHistorySnapshot}
                className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-bold text-gray-500 hover:border-sky-200 hover:bg-sky-50 hover:text-sky-700 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
                <span>{locale === "en" ? "Clear Replay" : "清除历史回放"}</span>
              </button>
            </div>
          </div>
        )}

        {/* 关键指标对比表 */}
        {displayMetrics.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm">
            <div className="flex flex-col gap-4 mb-5">
              <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <h3 className="text-xl font-black text-gray-900 tracking-tight">
                    {locale === "en" ? "Key Metrics: Global vs Steady-State Window" : "关键指标对比表：全局 vs 稳态窗口"}
                  </h3>
                  <p className="text-sm text-gray-500 mt-1 leading-relaxed">
                    {locale === "en"
                      ? "White background shows overall performance from round 1 to the current round; green background covers only the latest-20-round steady-state window, removing cold-start and warm-up noise. Total TTFT is global; peak TTFT observes steady-state long-tail."
                      : "左侧白底展示第 1 轮到当前轮的整体表现；右侧绿色底只看最近20轮稳态窗口，用来排除冷启动和预热阶段的干扰。累计 TTFT 属于全局口径，峰值 TTFT 用来观察稳态长尾。"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs font-black">
                  <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-slate-600">
                    {locale === "en" ? "Global 1..N: White" : "全局 1..N：白底"}
                  </span>
                  <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-emerald-700">
                    {locale === "en" ? "Latest 20: Green" : "最近20轮：绿色底"}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <div>
                      <div className="text-base font-black text-slate-900">{locale === "en" ? "Global Performance" : "全局总体性能比较"}</div>
                      <div className="text-xs font-semibold text-slate-500 mt-0.5">
                        {locale === "en" ? `Scope: rounds 1 to ${displayMetrics.length}` : `统计范围：第 1 轮到第 ${displayMetrics.length} 轮`}
                      </div>
                    </div>
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-black text-slate-500">
                      Overall
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                      <div className="text-xs font-black text-slate-500 mb-1">{locale === "en" ? "TTFT SPEEDUP [GLOBAL]" : "TTFT 性能优化 [全局]"}</div>
                      <div className="font-mono text-3xl font-black text-slate-900">{fmtGain(speedupGlobal)}</div>
                      <div className="text-[11px] font-semibold text-slate-500 mt-1">
                        {locale === "en" ? "LM global avg TTFT / InfiniKV global avg TTFT" : "LM 全局平均 TTFT ÷ InfiniKV 全局平均 TTFT"}
                      </div>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                      <div className="text-xs font-black text-slate-500 mb-1">{locale === "en" ? "QPS SPEEDUP [GLOBAL]" : "QPS 性能提升 [全局]"}</div>
                      <div className="font-mono text-3xl font-black text-slate-900">{fmtGain(qpsUpliftGlobal)}</div>
                      <div className="text-[11px] font-semibold text-slate-500 mt-1">
                        {locale === "en" ? "InfiniKV global QPS / LM global QPS" : "InfiniKV 全局 QPS ÷ LM 全局 QPS"}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <div>
                      <div className="text-base font-black text-emerald-900">{locale === "en" ? "Latest-20-Round Steady State" : "最近20轮稳态性能比较"}</div>
                      <div className="text-xs font-semibold text-emerald-700/80 mt-0.5">
                        {locale === "en" ? `Scope: last ${recentWindow} rounds; all rounds if N<20` : `统计范围：最后 ${recentWindow} 轮，N<20 时取全部`}
                      </div>
                    </div>
                    <span className="rounded-full border border-emerald-200 bg-white px-2 py-0.5 text-[11px] font-black text-emerald-700">
                      Steady Window
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="rounded-xl border border-emerald-200 bg-white px-4 py-3">
                      <div className="text-xs font-black text-emerald-700 mb-1">{locale === "en" ? "TTFT SPEEDUP [LATEST 20]" : "TTFT 性能优化 [最近20]"}</div>
                      <div className="font-mono text-3xl font-black text-emerald-700">{fmtGain(speedup)}</div>
                      <div className="text-[11px] font-semibold text-emerald-700/75 mt-1">
                        {locale === "en" ? "LM latest-20 avg TTFT / InfiniKV latest-20 avg TTFT" : "LM 最近20平均 TTFT ÷ InfiniKV 最近20平均 TTFT"}
                      </div>
                    </div>
                    <div className="rounded-xl border border-emerald-200 bg-white px-4 py-3">
                      <div className="text-xs font-black text-emerald-700 mb-1">{locale === "en" ? "QPS SPEEDUP [LATEST 20]" : "QPS 性能提升 [最近20]"}</div>
                      <div className="font-mono text-3xl font-black text-emerald-700">{fmtGain(qpsUplift)}</div>
                      <div className="text-[11px] font-semibold text-emerald-700/75 mt-1">
                        {locale === "en" ? "InfiniKV latest-20 QPS / LM latest-20 QPS" : "InfiniKV 最近20 QPS ÷ LM 最近20 QPS"}
                      </div>
                    </div>
                    <div className="rounded-xl border border-emerald-200 bg-white px-4 py-3">
                      <div className="text-xs font-black text-emerald-700 mb-1">{locale === "en" ? "PEAK TTFT OPT. [LATEST 20]" : "峰值 TTFT 优化 [最近20]"}</div>
                      <div className="font-mono text-3xl font-black text-emerald-700">{fmtGain(peakSpeedupRecent)}</div>
                      <div className="text-[11px] font-semibold text-emerald-700/75 mt-1">
                        {locale === "en" ? "LM latest-20 peak TTFT / InfiniKV latest-20 peak TTFT" : "LM 最近20峰值 TTFT ÷ InfiniKV 最近20峰值 TTFT"}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="overflow-x-auto rounded-2xl border border-gray-200">
              <table className="w-full min-w-[1180px]">
                <thead>
                  <tr className="text-left text-xs font-black uppercase tracking-wide border-b border-gray-200">
                    <th rowSpan={2} className="sticky left-0 z-10 bg-white py-3 px-3 text-gray-600 border-r border-gray-200">
                      {locale === "en" ? "System" : "系统"}
                    </th>
                    <th rowSpan={2} className="py-3 px-3 text-gray-600 border-r border-gray-200">
                      {locale === "en" ? "Model" : "模型"}
                    </th>
                    <th colSpan={5} className="py-3 px-3 text-center text-slate-700 bg-white border-r border-gray-200">
                      {locale === "en" ? "Global Metrics 1..N Rounds" : "全局指标 1..N 轮"}
                    </th>
                    <th colSpan={5} className="py-3 px-3 text-center text-emerald-800 bg-emerald-50">
                      {locale === "en" ? "Latest-20-Round Steady State" : "最近20轮稳态指标"}
                    </th>
                  </tr>
                  <tr className="text-left text-sm border-b border-gray-200">
                    <th className="py-2.5 px-3 font-semibold text-gray-500 bg-white">{locale === "en" ? "Avg Input" : "平均输入"}</th>
                    <th className="py-2.5 px-3 font-semibold text-gray-500 bg-white">{locale === "en" ? "Avg Output" : "平均输出"}</th>
                    <th className="py-2.5 px-3 font-semibold text-gray-500 bg-white">{locale === "en" ? "Total TTFT" : "累计 TTFT"}</th>
                    <th className="py-2.5 px-3 font-semibold text-gray-500 bg-white">{locale === "en" ? "Avg TTFT" : "平均 TTFT"}</th>
                    <th className="py-2.5 px-3 font-semibold text-gray-500 bg-white border-r border-gray-200">{locale === "en" ? "Est. QPS" : "估算 QPS"}</th>
                    <th className="py-2.5 px-3 font-semibold text-emerald-700 bg-emerald-50">{locale === "en" ? "Avg Input" : "平均输入"}</th>
                    <th className="py-2.5 px-3 font-semibold text-emerald-700 bg-emerald-50">{locale === "en" ? "Avg TTFT" : "平均 TTFT"}</th>
                    <th className="py-2.5 px-3 font-semibold text-emerald-700 bg-emerald-50">{locale === "en" ? "Est. QPS" : "估算 QPS"}</th>
                    <th className="py-2.5 px-3 font-semibold text-emerald-700 bg-emerald-50">{locale === "en" ? "Peak TTFT" : "峰值 TTFT"}</th>
                    <th className="py-2.5 px-3 font-semibold text-emerald-700 bg-emerald-50">{locale === "en" ? "Verdict" : "稳态结论"}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-gray-100 bg-orange-50/35">
                    <td className="sticky left-0 z-10 bg-orange-50 py-3 px-3 text-base font-black text-orange-700 border-r border-orange-100">
                      LMCache-DRAM
                    </td>
                    <td className="py-3 px-3 text-sm font-mono font-semibold text-gray-800 border-r border-gray-100">
                      {modelLabel}
                    </td>
                    <td className="py-3 px-3 text-base font-mono font-bold text-gray-900">
                      {avgInputTokensGlobal > 0 ? formatTokenCount(avgInputTokensGlobal) : "--"}
                    </td>
                    <td className="py-3 px-3 text-base font-mono font-bold text-gray-900">
                      {formatTokenCount(avgOutputTokens)}
                    </td>
                    <td className="py-3 px-3 text-xl font-mono font-black text-orange-700">
                      {displayMetrics.length > 0 ? `${displayMetrics.reduce((sum, item) => sum + item.lmTtft, 0).toFixed(2)}s` : "--"}
                    </td>
                    <td className="py-3 px-3 text-xl font-mono font-black text-orange-700">
                      {lmAvgTtftGlobal > 0 ? `${lmAvgTtftGlobal.toFixed(3)}s` : "--"}
                    </td>
                    <td className="py-3 px-3 text-xl font-mono font-black text-orange-700 border-r border-gray-200">
                      {lmEstimatedQpsGlobal > 0 ? lmEstimatedQpsGlobal.toFixed(2) : "--"}
                    </td>
                    <td className="py-3 px-3 text-base font-mono font-bold text-gray-900 bg-emerald-50/65">
                      {avgInputTokensRecent > 0 ? formatTokenCount(avgInputTokensRecent) : "--"}
                    </td>
                    <td className="py-3 px-3 text-xl font-mono font-black text-orange-700 bg-emerald-50/65">
                      {lmAvgTtftRecent > 0 ? `${lmAvgTtftRecent.toFixed(3)}s` : "--"}
                    </td>
                    <td className="py-3 px-3 text-xl font-mono font-black text-orange-700 bg-emerald-50/65">
                      {lmEstimatedQps > 0 ? lmEstimatedQps.toFixed(2) : "--"}
                    </td>
                    <td className="py-3 px-3 text-xl font-mono font-black text-orange-700 bg-emerald-50/65">
                      {lmMaxTtftRecent > 0 ? `${lmMaxTtftRecent.toFixed(3)}s` : "--"}
                    </td>
                    <td className="py-3 px-3 bg-emerald-50/65 text-sm font-bold text-orange-700">
                      {locale === "en" ? "Baseline" : "稳态基线"}
                    </td>
                  </tr>

                  <tr className="bg-sky-50/35">
                    <td className="sticky left-0 z-10 bg-sky-50 py-3 px-3 text-base font-black text-sky-700 border-r border-sky-100">
                      InfiniKV (SSD)
                    </td>
                    <td className="py-3 px-3 text-sm font-mono font-semibold text-gray-800 border-r border-gray-100">
                      {modelLabel}
                    </td>
                    <td className="py-3 px-3 text-base font-mono font-bold text-gray-900">
                      {avgInputTokensGlobal > 0 ? formatTokenCount(avgInputTokensGlobal) : "--"}
                    </td>
                    <td className="py-3 px-3 text-base font-mono font-bold text-gray-900">
                      {formatTokenCount(avgOutputTokens)}
                    </td>
                    <td className="py-3 px-3 text-xl font-mono font-black text-sky-700">
                      {displayMetrics.length > 0 ? `${displayMetrics.reduce((sum, item) => sum + item.ikTtft, 0).toFixed(2)}s` : "--"}
                    </td>
                    <td className="py-3 px-3 text-xl font-mono font-black text-sky-700">
                      {ikAvgTtftGlobal > 0 ? `${ikAvgTtftGlobal.toFixed(3)}s` : "--"}
                    </td>
                    <td className="py-3 px-3 text-xl font-mono font-black text-sky-700 border-r border-gray-200">
                      {ikEstimatedQpsGlobal > 0 ? ikEstimatedQpsGlobal.toFixed(2) : "--"}
                    </td>
                    <td className="py-3 px-3 text-base font-mono font-bold text-gray-900 bg-emerald-50/65">
                      {avgInputTokensRecent > 0 ? formatTokenCount(avgInputTokensRecent) : "--"}
                    </td>
                    <td className="py-3 px-3 text-xl font-mono font-black text-sky-700 bg-emerald-50/65">
                      {ikAvgTtftRecent > 0 ? `${ikAvgTtftRecent.toFixed(3)}s` : "--"}
                    </td>
                    <td className="py-3 px-3 text-xl font-mono font-black text-sky-700 bg-emerald-50/65">
                      {ikEstimatedQps > 0 ? ikEstimatedQps.toFixed(2) : "--"}
                    </td>
                    <td className="py-3 px-3 text-xl font-mono font-black text-sky-700 bg-emerald-50/65">
                      {ikMaxTtftRecent > 0 ? `${ikMaxTtftRecent.toFixed(3)}s` : "--"}
                    </td>
                    <td className="py-3 px-3 bg-emerald-50/65 text-sm font-bold text-sky-700">
                      {locale === "en" ? "Improved" : "稳态更优"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}


        {/* TTFT 曲线 */}
        {displayMetrics.length >= 2 && (
          <div className="bg-white border border-gray-200 rounded-2xl p-8 shadow-sm">
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
                <div>
                  <h3 className="text-xl font-black text-gray-900 tracking-tight">{locale === "en" ? "TTFT Timeline (one point per round)" : "TTFT 时间线（每轮一个点）"}</h3>
                  <p className="text-base text-gray-500 mt-1">{locale === "en" ? "Watch the second half of the run: DRAM eviction causes TTFT spikes on revisits; InfiniKV's SSD recall should keep the curve flatter." : "观察长跑后半程：DRAM 淘汰会让回访请求抬升，InfiniKV 的 SSD 召回应让曲线更平稳"}</p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2 text-sm">
                  <span className="px-2.5 py-1 rounded-full bg-gray-100 text-gray-700 font-semibold">{locale === "en" ? "Model" : "模型"} {modelLabel}</span>
                  <span className="px-2.5 py-1 rounded-full bg-sky-50 text-sky-700 font-semibold">{locale === "en" ? "Avg Input [Global]" : "平均输入[全局]"} {avgInputTokensGlobal > 0 ? formatTokenCount(avgInputTokensGlobal) : "--"}</span>
                  <span className="px-2.5 py-1 rounded-full bg-sky-50 text-sky-700 font-semibold">{locale === "en" ? "Avg Input [Latest-20]" : "平均输入[最近20]"} {avgInputTokensRecent > 0 ? formatTokenCount(avgInputTokensRecent) : "--"}</span>
                  <span className="px-2.5 py-1 rounded-full bg-gray-100 text-gray-700 font-semibold">{locale === "en" ? "Avg Output" : "平均输出"} {formatTokenCount(avgOutputTokens)}</span>
                  <span className="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 font-semibold">{locale === "en" ? "QPS [Latest-20]" : "QPS[最近20]"} {displayMetrics.length > 0 ? `${recentQpsGainPct >= 0 ? "+" : ""}${recentQpsGainPct.toFixed(1)}%` : "--"}</span>
                </div>
              </div>
              <div className="flex justify-center w-full">
                <LegendChips
                  className="justify-center"
                  items={[
                    { label: "LMCache-DRAM", colorClass: "bg-orange-50 border-orange-200", textClass: "text-orange-700" },
                    { label: "InfiniKV (SSD)", colorClass: "bg-sky-50 border-sky-200", textClass: "text-sky-700" },
                  ]}
                />
              </div>
            </div>
            <ResponsiveContainer width="100%" height={350}>
              <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 20 }}>
                <CartesianGrid vertical={false} stroke="#F3F4F6" strokeDasharray="4 4" />
                <XAxis
                  dataKey="round"
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
                  label={{ value: locale === "en" ? "TTFT (s)" : "TTFT (秒)", angle: -90, position: "insideLeft", fill: "#6B7280", fontSize: 14, fontWeight: 700, dx: -8 }}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: "#fff", border: "none", borderRadius: "12px", fontSize: "14px", padding: "14px 18px", boxShadow: "0 8px 30px rgba(0,0,0,0.12)" }}
                  labelStyle={{ fontWeight: 700, marginBottom: 8, fontSize: 15 }}
                  cursor={{ stroke: "#E5E7EB", strokeWidth: 1 }}
                />
                <Line type="monotone" dataKey="LMCache" stroke="#F97316" strokeWidth={3} dot={{ r: 5, fill: "#F97316", strokeWidth: 0 }} activeDot={{ r: 7, fill: "#F97316" }} animationDuration={300} />
                <Line type="monotone" dataKey="InfiniKV" stroke="#0EA5E9" strokeWidth={3} dot={{ r: 5, fill: "#0EA5E9", strokeWidth: 0 }} activeDot={{ r: 7, fill: "#0EA5E9" }} animationDuration={300} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Cache 命中率曲线 */}
        {displayMetrics.length >= 2 && (
          <div className="bg-white border border-gray-200 rounded-2xl p-8 shadow-sm">
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
                <div>
                  <h3 className="text-xl font-black text-gray-900 tracking-tight">{locale === "en" ? "Cache Hit Rate Curves" : "Cache 命中率曲线"}</h3>
                  <p className="text-base text-gray-500 mt-1">{locale === "en" ? "GPU prefix hit reflects HBM-side prefix reuse; DRAM KV Cache hit reflects the memory-tier hit; InfiniKV SSD Hit shows the SSD-tier recall contribution." : "GPU prefix hit 反映显存侧前缀复用；DRAM KV Cache hit 反映内存层命中；InfiniKV SSD Hit 反映 SSD 层召回贡献。"}</p>
                </div>
              </div>
              <div className="flex justify-center w-full">
                <LegendChips
                  className="justify-center"
                  items={[
                    { label: "LMCache DRAM Hit (GPU Prefix)", colorClass: "bg-orange-50 border-orange-200", textClass: "text-orange-700" },
                    { label: "InfiniKV DRAM Hit (GPU Prefix)", colorClass: "bg-sky-50 border-sky-200", textClass: "text-sky-700" },
                    { label: "LMCache External Hit", colorClass: "bg-emerald-50 border-emerald-200", textClass: "text-emerald-700" },
                    { label: "InfiniKV SSD Hit (External)", colorClass: "bg-violet-50 border-violet-200", textClass: "text-violet-700" },
                  ]}
                />
              </div>
            </div>
            <ResponsiveContainer width="100%" height={350}>
              <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 20 }}>
                <CartesianGrid vertical={false} stroke="#F3F4F6" strokeDasharray="4 4" />
                <XAxis
                  dataKey="round"
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
                  domain={[0, 100]}
                  unit="%"
                  label={{ value: "Hit Rate (%)", angle: -90, position: "insideLeft", fill: "#6B7280", fontSize: 14, fontWeight: 700, dx: -8 }}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: "#fff", border: "none", borderRadius: "12px", fontSize: "14px", padding: "14px 18px", boxShadow: "0 8px 30px rgba(0,0,0,0.12)" }}
                  labelStyle={{ fontWeight: 700, marginBottom: 8, fontSize: 15 }}
                  cursor={{ stroke: "#E5E7EB", strokeWidth: 1 }}
                />
                <Line type="monotone" dataKey="LMCacheHit" name="LMCache DRAM hit (GPU Prefix)" stroke="#F97316" strokeWidth={3} dot={{ r: 4, fill: "#F97316", strokeWidth: 0 }} />
                <Line type="monotone" dataKey="InfiniKVHit" name="InfiniKV DRAM hit (GPU Prefix)" stroke="#0EA5E9" strokeWidth={3} dot={{ r: 4, fill: "#0EA5E9", strokeWidth: 0 }} />
                <Line type="monotone" dataKey="LMCacheExtHit" name="LMCache external hit" stroke="#10B981" strokeWidth={2.5} strokeDasharray="5 4" dot={{ r: 4, fill: "#10B981", strokeWidth: 0 }} connectNulls={false} />
                <Line type="monotone" dataKey="InfiniKVExtHit" name="InfiniKV SSD hit (External)" stroke="#8B5CF6" strokeWidth={2.5} strokeDasharray="5 4" dot={{ r: 4, fill: "#8B5CF6", strokeWidth: 0 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* 原始数据表 */}
        {displayMetrics.length > 0 && (
          <details className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
            <summary className="px-6 py-4 cursor-pointer text-base font-black text-gray-900 flex items-center justify-between hover:bg-gray-50">
              <span>{locale === "en" ? `Raw Per-Round Data (${displayMetrics.length} rows)` : `原始每轮数据（${displayMetrics.length} 行）`}</span>
              <ChevronDown className="w-4 h-4 text-gray-400" />
            </summary>
            <div className="overflow-x-auto border-t border-gray-200">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr className="text-gray-500 font-medium">
                    <th className="px-3 py-2 text-left">{locale === "en" ? "Round" : "轮"}</th>
                    <th className="px-3 py-2 text-left">{locale === "en" ? "Session" : "会话"}</th>
                    <th className="px-3 py-2 text-right">LM TTFT</th>
                    <th className="px-3 py-2 text-right">IK TTFT</th>
                    <th className="px-3 py-2 text-right">LM TPS</th>
                    <th className="px-3 py-2 text-right">IK TPS</th>
                    <th className="px-3 py-2 text-right">LM QPS</th>
                    <th className="px-3 py-2 text-right">IK QPS</th>
                    <th className="px-3 py-2 text-right">LM Hit%</th>
                    <th className="px-3 py-2 text-right">IK Hit%</th>
                    <th className="px-3 py-2 text-right">LM Ext Hit%</th>
                    <th className="px-3 py-2 text-right">IK SSD Hit%</th>
                    <th className="px-3 py-2 text-right">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {displayMetrics.slice().reverse().map(m => {
                    const shortName = docs.find(d => d.id === m.sessionId)?.name.slice(0, 18) || m.sessionId.slice(0, 8);
                    const lmQps = estimateQps(m.lmTtft, m.lmTps, avgOutputTokens, concurrentFactor);
                    const ikQps = estimateQps(m.ikTtft, m.ikTps, avgOutputTokens, concurrentFactor);
                    return (
                      <tr key={m.round} className="border-t border-gray-100 font-mono">
                        <td className="px-3 py-1.5 text-gray-700 font-bold">#{m.round}</td>
                        <td className="px-3 py-1.5 text-gray-500 truncate max-w-[180px]">{shortName}</td>
                        <td className="px-3 py-1.5 text-right text-orange-700">{m.lmTtft.toFixed(3)}s</td>
                        <td className="px-3 py-1.5 text-right text-sky-700">{m.ikTtft.toFixed(3)}s</td>
                        <td className="px-3 py-1.5 text-right text-gray-600">{m.lmTps.toFixed(1)}</td>
                        <td className="px-3 py-1.5 text-right text-gray-600">{m.ikTps.toFixed(1)}</td>
                        <td className="px-3 py-1.5 text-right text-orange-700">{lmQps > 0 ? lmQps.toFixed(2) : "--"}</td>
                        <td className="px-3 py-1.5 text-right text-sky-700">{ikQps > 0 ? ikQps.toFixed(2) : "--"}</td>
                        <td className="px-3 py-1.5 text-right text-gray-600">{(m.lmPrefixHit * 100).toFixed(1)}%</td>
                        <td className="px-3 py-1.5 text-right text-gray-600">{(m.ikPrefixHit * 100).toFixed(1)}%</td>
                        <td className="px-3 py-1.5 text-right text-emerald-600">{m.lmExtHit === null ? "N/A" : `${(m.lmExtHit * 100).toFixed(1)}%`}</td>
                        <td className="px-3 py-1.5 text-right text-violet-600">{m.ikExtHit === null ? "N/A" : `${(m.ikExtHit * 100).toFixed(1)}%`}</td>
                        <td className="px-3 py-1.5 text-right text-gray-400">{m.ikContextTokens.toLocaleString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        )}

        {/* 说明卡片 */}
        <div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm text-sm text-gray-600 leading-relaxed space-y-2">
          <div className="flex items-center space-x-2 mb-2">
            <Info className="w-4 h-4 text-sky-500" />
            <span className="font-black text-gray-900">{locale === "en" ? "How to see a steady-state gap?" : "怎样才能看到稳态差距？"}</span>
          </div>
          <p>{locale === "en" ? <>1. <b>Upload 5–8 medium-to-large PDF/TXT/MD files</b> (50K+ tokens each is better) so the total KV Cache working set clearly exceeds what DRAM can retain long-term.</> : <>1. <b>上传 5~8 份中到大 PDF/TXT/MD</b>（单份 50K+ token 更好），让工作集总 KV Cache 明显超过 DRAM 可长期保留的范围。</>}</p>
          <p>{locale === "en" ? <>2. <b>Set the session revisit interval to 3–5</b>. Recently accessed documents are blocked by a cooldown, forcing the system to cycle through more sessions and making DRAM eviction more likely.</> : <>2. <b>会话回访间隔设 3~5</b>。最近几轮访问过的文档会被 cooldown 屏蔽，促使系统轮询更多 session，更容易触发 DRAM 淘汰。</>}</p>
          <p>{locale === "en" ? <>3. <b>Run at least 50 rounds, 100+ recommended</b>. The early phase is mainly cold-start and warm-up; the latest-20-round window is more informative about steady-state quality.</> : <>3. <b>至少跑 50 轮，推荐 100+ 轮</b>。前期主要是冷启动和预热；进入后半程后，最近20轮窗口更能说明稳态服务质量。</>}</p>
          <p>{locale === "en" ? <>4. <b>Watch both TTFT and SSD Hit%</b>. When SSD Hit% rises from 0, the SSD tier is catching KV Cache evicted from DRAM; if TTFT stays stable, the recall path is genuinely working.</> : <>4. <b>同时看 TTFT 和 SSD Hit%</b>。SSD Hit% 从 0 上升，说明 SSD 层开始接住被 DRAM 挤出的 KV Cache；若 TTFT 仍稳定，说明召回链路真正有效。</>}</p>
          <p>{locale === "en" ? <>5. <b>Focus on latest-20-round avg TTFT, peak TTFT, and QPS</b>. Global metrics show total cost; the steady-state window shows the long-run gap between the two systems.</> : <>5. <b>优先解读最近20轮平均 TTFT、峰值 TTFT 和 QPS</b>。全局指标用于看总成本，稳态窗口用于判断长期运行时两种方案的差距。</>}</p>
        </div>
      </div>

      <HistoryModal
        open={showHistory}
        onClose={() => setShowHistory(false)}
        currentScenario="stress-test"
        onNavigateAndLoad={handleNavigateAndLoad}
        onLoadRecord={handleLoadRecord}
      />
      <WorkloadInfoModal
        open={showWorkloadInfo}
        onClose={() => setShowWorkloadInfo(false)}
        scenario="stress-test"
      />
    </div>
  );
}
