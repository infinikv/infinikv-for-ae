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
  Play, Loader2, Paperclip, X, Activity, ChevronDown, Info, Clock, Zap,
  FileText, AlertCircle, Square, Terminal, Code, ScrollText, Bot,
} from "lucide-react";
import { saveRecord, type TestRecord } from "@/lib/history";
import { AGENT_SEED_METRICS } from "./seedMetrics";
import HistoryModal from "@/components/HistoryModal";
import WorkloadInfoModal from "@/components/WorkloadInfoModal";
import LegendChips from "@/components/LegendChips";
import {
  LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceArea, ReferenceLine,
} from "recharts";
import { getApiBase } from "@/lib/api";
import { t, useLocale } from "@/lib/i18n";

/* ────────────────── Types ────────────────── */

type UploadedDoc = {
  id: string;           // 客户端生成的 session id
  name: string;
  text: string;         // PDF 抽取后文本
  estTokens: number;
};

export type RoundMetrics = {
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
            {scope === "recent" ? (locale === "en" ? "Revisit" : "重访段") : (locale === "en" ? "Global 1..N" : "全局 1..N")}
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
              ? `LMCache-DRAM uses 64GB DRAM as the baseline; InfiniKV uses 512GB SSD. We look at it two ways: "Overall" is the average across all ${completedRounds || 50} rounds; "Long-context revisit recovery" looks only at the later rounds, after the agent has been revisiting tasks for a while.`
              : `LMCache-DRAM 使用 64GB DRAM 作为基线，InfiniKV 使用 512GB SSD。下面从两个角度看：「整体」是全部 ${completedRounds || 50} 轮的平均表现；「长上下文重访恢复」只看后段——Agent 反复重访历史任务、进入稳定阶段后的恢复表现。`}
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
              <div className="text-lg font-black text-slate-900">{isEn ? "Overall performance" : "整体性能"}</div>
              <div className="text-xs font-semibold text-slate-500 mt-0.5">{isEn ? `Scope: rounds 1 to ${completedRounds}` : `统计范围：第 1 轮到第 ${completedRounds} 轮`}</div>
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
              <div className="text-lg font-black text-emerald-900">{isEn ? "Long-context revisit recovery" : "长上下文重访恢复"}</div>
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
              helper={isEn ? "LM revisit-segment avg TTFT / InfiniKV revisit-segment avg TTFT" : "LM 重访段平均 TTFT ÷ InfiniKV 重访段平均 TTFT"}
              scope="recent"
            />
            <ScopeGainCard
              title={isEn ? "QPS SPEEDUP" : "QPS 性能提升"}
              value={recentQpsSpeedup}
              helper={isEn ? `InfiniKV revisit-segment QPS / LM revisit-segment QPS, about ${recentQpsSpeedup > 0 ? fmtGainPct(recentQpsGainPct) : "--"}` : `InfiniKV 重访段 QPS ÷ LM 重访段 QPS，约 ${recentQpsSpeedup > 0 ? fmtGainPct(recentQpsGainPct) : "--"}`}
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
          <div className="text-xl font-black text-gray-900 tracking-tight">
            {isEn ? `Experiment Setup: ${workloadLabel}` : `实验配置：${workloadLabel}`}
          </div>
          <div className="mt-1 max-w-4xl text-base leading-relaxed text-gray-500">
            {isEn
              ? "Both systems run the same agent revisit workload; the only difference is the KV Cache tier — LMCache-DRAM uses a smaller 64GB DRAM tier, InfiniKV a larger 512GB SSD tier. We compare TTFT, QPS and cache hit rate when agents reopen long-context tasks."
              : "两套系统执行同一组 Agent 重访负载，唯一区别在 KV Cache 扩展层：LMCache-DRAM 用较小的 64GB DRAM，InfiniKV 用更大的 512GB SSD。对比 Agent 反复重访长上下文任务时，两者在 TTFT、QPS 与缓存命中率上的差异。"}
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
                  {isEn ? "Baseline" : "基线"}
                </span>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3 rounded-xl bg-orange-50 px-3 py-2">
                  <span className="text-base font-semibold text-orange-700/80">{isEn ? "Offload Medium" : "卸载介质"}</span>
                  <span className="font-mono text-base font-black text-orange-800">64GB DRAM</span>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-xl bg-orange-50 px-3 py-2">
                  <span className="text-base font-semibold text-orange-700/80">{isEn ? "Behavior" : "特点"}</span>
                  <span className="whitespace-nowrap text-sm font-bold text-orange-800">{isEn ? "small; old KV is evicted on revisit" : "容量小，重访时旧 KV 容易被淘汰"}</span>
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
                  {isEn ? "Optimized" : "优化方案"}
                </span>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3 rounded-xl bg-sky-50 px-3 py-2">
                  <span className="text-base font-semibold text-sky-700/80">{isEn ? "Offload Medium" : "卸载介质"}</span>
                  <span className="font-mono text-base font-black text-sky-800">512GB SSD</span>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-xl bg-sky-50 px-3 py-2">
                  <span className="text-base font-semibold text-sky-700/80">{isEn ? "Behavior" : "特点"}</span>
                  <span className="whitespace-nowrap text-sm font-bold text-sky-800">{isEn ? "large; old KV stays on SSD, reused directly" : "容量大，旧 KV 留在 SSD 可直接复用"}</span>
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
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl border border-gray-200 bg-gray-50/70 p-4">
          <div className="text-sm font-black text-gray-900 mb-1">{isEn ? "TTFT · first-token latency" : "TTFT · 首字延迟"}</div>
          <p className="text-sm text-gray-600 leading-relaxed">{isEn ? "How long an agent waits after reopening a task before the answer starts. Lower means the historical context recovered faster." : "Agent 重新访问一个历史任务后，需要多久才开始返回结果。越低，说明历史上下文恢复得越快。"}</p>
          <div className="mt-2 text-xs font-mono text-gray-500">{isEn ? "avg(round TTFT), lower is better" : "平均(各轮 TTFT)，越低越好"}</div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-gray-50/70 p-4">
          <div className="text-sm font-black text-gray-900 mb-1">{isEn ? "QPS · throughput" : "QPS · 吞吐"}</div>
          <p className="text-sm text-gray-600 leading-relaxed">{isEn ? "How many agent requests the backend can complete per unit time. Higher means more tasks served per server." : "单位时间能完成多少次 Agent 请求。越高，单台服务器能服务的任务越多。"}</p>
          <div className="mt-2 text-xs font-mono text-gray-500">{isEn ? "concurrency / (TTFT + output/TPS), higher is better" : "并发 / (TTFT + 输出/TPS)，越高越好"}</div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-gray-50/70 p-4">
          <div className="text-sm font-black text-gray-900 mb-1">{isEn ? "Cache hit rate" : "缓存命中率"}</div>
          <p className="text-sm text-gray-600 leading-relaxed">{isEn ? "The share of revisited history KV that is served directly from cache instead of being prefilled again. A higher hit rate means less repeated computation." : "重访时历史 KV 在缓存中命中、可直接复用的比例，无需重新预填充。命中率越高，重复计算越少。"}</p>
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
          <div className="text-sm font-black text-gray-900 mb-1">重访总轮数</div>
          <p className="text-sm text-gray-600 leading-relaxed">
            连续发送请求的总轮次，用于观察长时间运行后 DRAM 淘汰与 SSD 复用效果。
          </p>
          <div className="mt-2 text-xs font-mono text-gray-500">
            当前 {totalRounds} 轮，轮数越多越能体现历史任务的反复重访
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

/* ────────────────── Page ────────────────── */

function AgentWorkloadPanel() {
  const [locale] = useLocale();
  const isEn = locale === "en";
  const TONES: Record<string, { card: string; dot: string; text: string; chip: string; chipText: string; icon: string }> = {
    sky: { card: "border-sky-200 bg-sky-50", dot: "bg-sky-500", text: "text-sky-700", chip: "bg-sky-100", chipText: "text-sky-700", icon: "text-sky-600" },
    emerald: { card: "border-emerald-200 bg-emerald-50", dot: "bg-emerald-500", text: "text-emerald-700", chip: "bg-emerald-100", chipText: "text-emerald-700", icon: "text-emerald-600" },
    amber: { card: "border-amber-200 bg-amber-50", dot: "bg-amber-500", text: "text-amber-700", chip: "bg-amber-100", chipText: "text-amber-700", icon: "text-amber-600" },
  };
  const tasks = isEn
    ? [
      { key: "sky", tag: "Agent 1", icon: Code, title: "Code analysis", body: "Reads the whole repo and prior dialogue to locate and explain an issue." },
      { key: "emerald", tag: "Agent 2", icon: ScrollText, title: "Log analysis", body: "Loads large run logs and earlier diagnoses to keep investigating." },
      { key: "amber", tag: "Agent 3", icon: Terminal, title: "Command execution", body: "Runs new instructions while reusing the existing session state." },
    ]
    : [
      { key: "sky", tag: "Agent 1", icon: Code, title: "代码分析", body: "读取整个代码库与历史对话，定位并解释问题。" },
      { key: "emerald", tag: "Agent 2", icon: ScrollText, title: "日志分析", body: "加载大量运行日志与历史诊断，继续排查根因。" },
      { key: "amber", tag: "Agent 3", icon: Terminal, title: "命令执行", body: "基于上下文执行新指令，复用既有会话状态。" },
    ];
  const Session = ({ tag, name, toneKey, saved }: { tag: string; name: string; toneKey: string; saved: boolean }) => {
    const tn = TONES[toneKey];
    return (
      <div className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 ${saved ? tn.card : "border-red-400 bg-red-50"}`}>
        <span className="flex min-w-0 items-center gap-2 text-sm font-black text-slate-700">
          <span className={`flex h-6 flex-shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-black text-white ${saved ? tn.dot : "bg-red-500"}`}><Bot className="h-3 w-3" />{tag}</span>
          <span className="truncate">{name}{isEn ? " · history KV" : " · 历史 KV"}</span>
        </span>
        <span className={`flex-shrink-0 text-xs font-bold ${saved ? tn.text : "text-red-600"}`}>{saved ? (isEn ? "kept" : "已保存") : (isEn ? "evicted" : "已淘汰")}</span>
      </div>
    );
  };
  const taskNames = tasks.map(t => ({ key: t.key, tag: t.tag, name: t.title }));
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 md:p-6 shadow-sm">
      <h3 className="text-xl md:text-2xl font-black tracking-tight text-slate-900">
        {isEn
          ? "Workload analysis: agents keep revisiting past tasks — the bottleneck is retaining historical KV Cache"
          : "负载解析：Agent 反复重访历史任务，瓶颈在历史 KV Cache 的保留能力"}
      </h3>
      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
        {tasks.map(({ key, tag, icon: Icon, title, body }) => {
          const tn = TONES[key];
          return (
            <div key={tag} className={`rounded-xl border p-4 ${tn.card}`}>
              <div className="mb-2 flex items-center gap-2">
                <span className={`flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-black ${tn.chip} ${tn.chipText}`}><Bot className="h-3.5 w-3.5" />{tag}</span>
                <div className="rounded-lg bg-white p-1.5 shadow-sm"><Icon className={`h-4 w-4 ${tn.icon}`} /></div>
                <h4 className="text-base font-black text-slate-900">{title}</h4>
              </div>
              <p className="text-sm font-semibold leading-relaxed text-slate-600">{body}</p>
            </div>
          );
        })}
      </div>

      {/* revisit diagram: DRAM evicts an old session's KV, SSD keeps all (PPT page 4) */}
      <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
        <div className="mb-3 text-sm font-black text-slate-700">
          {isEn ? "Revisiting a historical task, two backends" : "重访某个历史任务时，两种后端的差异"}
        </div>
        <div className="relative grid grid-cols-1 gap-5 md:grid-cols-2 md:gap-0">
          <div className="md:pr-6">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-sm font-black text-orange-700">{isEn ? "DRAM backend (full)" : "DRAM 后端（已满）"}</span>
              <span className="rounded-full border border-orange-200 bg-orange-50 px-2 py-0.5 text-[11px] font-bold text-orange-700">{isEn ? "capacity tight" : "容量吃紧"}</span>
            </div>
            <div className="space-y-2">
              {taskNames.map((tk, i) => (
                <Session key={tk.tag} tag={tk.tag} name={tk.name} toneKey={tk.key} saved={i !== 0} />
              ))}
            </div>
            <div className="mt-2 text-xs font-semibold leading-snug text-orange-700">
              {isEn ? "Agent 1's history KV was evicted → revisiting it must re-read and prefill its entire codebase and logs" : "Agent 1 的历史 KV 已被淘汰 → 重访时需把整个代码库与日志重新读取并预填充"}
            </div>
          </div>
          <div className="pointer-events-none absolute inset-y-0 left-1/2 hidden -translate-x-1/2 md:block"><div className="h-full w-px bg-slate-200" /></div>
          <div className="md:pl-6">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-sm font-black text-sky-700">{isEn ? "SSD backend" : "SSD 后端"}</span>
              <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-bold text-sky-700">{isEn ? "ample capacity" : "容量充裕"}</span>
            </div>
            <div className="space-y-2">
              {taskNames.map(tk => (
                <Session key={tk.tag} tag={tk.tag} name={tk.name} toneKey={tk.key} saved={true} />
              ))}
            </div>
            <div className="mt-2 text-xs font-semibold leading-snug text-sky-700">
              {isEn ? "Every task's history KV is kept on SSD → revisiting any past task reuses its cache directly, no re-reading" : "每个任务的历史 KV 都保留在 SSD → 重访任意历史任务都能直接复用缓存，无需重新读取"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

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

  /* ────────── 历史记录加载 ──────────
   * 压测历史不存 metrics 重放（太大），只恢复配置（模式/轮数/切换间隔/每请求输出 Token）
   * + 只读形式展示上次的 metrics 曲线（标记"历史快照"）。
   * 附件不存（PDF 太大），用户需要手动重新上传。
   */
  // Default: render a baked-in sample run on first paint (no async flash / blank page).
  const [historyMetrics, setHistoryMetrics] = useState<RoundMetrics[] | null>(() => AGENT_SEED_METRICS);
  const [historyLabel, setHistoryLabel] = useState<string>(() => locale === "en"
    ? `Sample run · ${AGENT_SEED_METRICS.length} rounds · 8 sessions revisited`
    : `示例数据 · ${AGENT_SEED_METRICS.length} 轮 · 8 个会话轮转重访`);

  const handleLoadRecord = useCallback((record: TestRecord) => {
    setIsRunning(false);
    setActiveSessionId("");
    setShowHistory(false);
    if (typeof record.config?.totalRounds === "number") setTotalRounds(record.config.totalRounds);
    if (typeof record.config?.outputLen === "number") setOutputLen(record.config.outputLen);
    if (typeof record.config?.cooldownRounds === "number") setCooldownRounds(record.config.cooldownRounds);
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
    // Otherwise always show the baked-in 50-round sample (already in initial state).
    // We intentionally do NOT load the cached/shared history here — that was stale
    // and caused the "flash / stale data" issue on this presentation page.
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
    const res = await fetch(`${apiBase}/api/benchmark/prepare`, {
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
      const res = await fetch(`${apiBase}/api/benchmark/run`, {
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
          scenarioLabel: "Agent 编程上下文恢复",
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
  // Backend cache-hit improvement in the revisit-recovery window (SSD external hit vs DRAM external hit).
  const recentLmExtHit = avgOf(recentMetrics.map(m => (m.lmExtHit ?? 0) * 100));
  const recentIkExtHit = avgOf(recentMetrics.map(m => (m.ikExtHit ?? 0) * 100));
  // SSD/DRAM backend hit (%) at the gap-marker round (round 48) — for the 8.7x annotation.
  const gapIdx = displayMetrics.length >= 3 ? displayMetrics.length - 3 : displayMetrics.length - 1;
  const gapMetric = gapIdx >= 0 ? displayMetrics[gapIdx] : null;
  const gapRound = gapMetric ? gapMetric.round : 0;
  const gapLmExtHit = gapMetric && gapMetric.lmExtHit != null ? gapMetric.lmExtHit * 100 : recentLmExtHit;
  const gapIkExtHit = gapMetric && gapMetric.ikExtHit != null ? gapMetric.ikExtHit * 100 : recentIkExtHit;
  const hitGainRecent = recentLmExtHit > 0 ? recentIkExtHit / recentLmExtHit : 0;
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

  // Revisit-recovery window = the last `recentWindow` rounds; highlighted on the charts.
  const recoveryStartRound = displayMetrics.length > 0
    ? displayMetrics[Math.max(0, displayMetrics.length - recentWindow)].round
    : 0;
  const lastRound = displayMetrics.length > 0 ? displayMetrics[displayMetrics.length - 1].round : 0;
  const recoveryLabelTtft = locale === "en"
    ? "Revisit recovery · 6.79× lower wait time"
    : "重访恢复窗口 · 重访等待时间降低 6.79×";
  const recoveryLabelHit = locale === "en"
    ? "Revisit recovery · 8.7× higher hit rate"
    : "重访恢复窗口 · 缓存命中率提升 8.7×";

  // Demo view hides the live config / run / progress / raw-data panels (presentation mode).
  const SHOW_CONTROLS = false;

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
              <Activity className="w-8 h-8 text-violet-500" />
              <span>{tr("demo.stress.title")}</span>
            </h1>
            <p className="text-slate-500 text-base mt-2 leading-relaxed max-w-5xl">
              {tr("demo.stress.description.a")}<span className="font-semibold text-slate-900">{tr("demo.stress.description.time")}</span>{tr("demo.stress.description.b")}<span className="font-semibold text-emerald-700">{tr("demo.stress.description.window")}</span>{tr("demo.stress.description.c")}<span className="font-semibold text-slate-600">{tr("demo.stress.description.dram")}</span>{tr("demo.stress.description.d")}<span className="font-semibold text-sky-700">{tr("demo.stress.description.ssd")}</span>{tr("demo.stress.description.e")}
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

        <AgentWorkloadPanel />
        <ExperimentConfigBanner workloadLabel={tr("demo.stress.workload")} />

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

        {displayMetrics.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-2xl p-6 md:p-7 shadow-sm">
            <div className="mb-5 flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h3 className="text-2xl font-black text-slate-900 tracking-tight">{locale === "en" ? "Key Metrics: Overall vs Long-Context Revisit Recovery" : "关键指标：整体 vs 长上下文重访恢复"}</h3>
                <p className="mt-1 max-w-3xl text-sm text-slate-500 leading-relaxed">{locale === "en"
                  ? `"Overall" averages all ${displayMetrics.length} rounds; "revisit recovery" focuses on the last ${recentWindow} rounds, after the agent has been revisiting tasks for a while.`
                  : `「整体」是全部 ${displayMetrics.length} 轮的平均；「长上下文重访恢复」重点看后 ${recentWindow} 轮——Agent 反复重访、进入稳定阶段后的恢复表现。`}</p>
              </div>
              <span className="self-start text-xs font-mono font-semibold px-2.5 py-1 rounded-md bg-slate-100 text-slate-600 border border-slate-200 whitespace-nowrap">{locale === "en" ? "Model" : "模型"} {modelLabel}</span>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {[
                {
                  scope: locale === "en" ? `Overall (all ${displayMetrics.length} rounds)` : `整体（全部 ${displayMetrics.length} 轮）`,
                  hero: false,
                  tiles: [
                    { label: locale === "en" ? "TTFT speedup" : "TTFT 优化", gain: speedupGlobal, sub: `${lmAvgTtftGlobal.toFixed(2)}s → ${ikAvgTtftGlobal.toFixed(2)}s` },
                    { label: locale === "en" ? "QPS gain" : "QPS 提升", gain: qpsUpliftGlobal, sub: `${lmEstimatedQpsGlobal.toFixed(2)} → ${ikEstimatedQpsGlobal.toFixed(2)}` },
                  ],
                },
                {
                  scope: locale === "en" ? `Revisit recovery (last ${recentWindow})` : `长上下文重访恢复（最后 ${recentWindow} 轮）`,
                  hero: true,
                  tiles: [
                    { label: locale === "en" ? "TTFT speedup" : "TTFT 优化", gain: speedup, sub: `${lmAvgTtftRecent.toFixed(2)}s → ${ikAvgTtftRecent.toFixed(2)}s` },
                    { label: locale === "en" ? "QPS gain" : "QPS 提升", gain: qpsUplift, sub: `${lmEstimatedQps.toFixed(2)} → ${ikEstimatedQps.toFixed(2)}` },
                  ],
                },
              ].map((col, ci) => (
                <div key={ci} className={`rounded-2xl border p-4 ${col.hero ? "border-2 border-emerald-300 bg-emerald-50/70" : "border-slate-200 bg-slate-50"}`}>
                  <div className="mb-3 flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${col.hero ? "bg-emerald-500" : "bg-slate-400"}`} />
                    <span className={`text-sm font-black ${col.hero ? "text-emerald-800" : "text-slate-700"}`}>{col.scope}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {col.tiles.map((tile, ti) => (
                      <div key={ti} className={`rounded-xl border bg-white px-3 py-3 ${col.hero ? "border-emerald-200" : "border-slate-200"}`}>
                        <div className={`text-xs font-black uppercase tracking-wide ${col.hero ? "text-emerald-700" : "text-slate-500"}`}>{tile.label}</div>
                        <div className="mt-1 flex items-end gap-0.5">
                          <span className={`text-4xl font-black leading-none ${col.hero ? "text-emerald-700" : "text-slate-900"}`}>{tile.gain > 0 ? tile.gain.toFixed(2) : "--"}</span>
                          <span className={`mb-0.5 text-xl font-black ${col.hero ? "text-emerald-700" : "text-slate-900"}`}>×</span>
                        </div>
                        <div className="mt-1.5 font-mono text-sm font-bold text-slate-500">{tile.sub}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {SHOW_CONTROLS && (<>
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
                      : "上传 3~10 份不同 PDF/TXT/MD，每轮选择 1 份文档会话做 QA。长跑后工作集总 KV Cache 超过 DRAM 容量，LMCache-DRAM 会出现淘汰与重新 prefill；InfiniKV 通过 SSD 层复用被淘汰的 KV Cache。"}
                  </div>
                </div>

                <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Paperclip className="w-4 h-4 text-sky-500" />
                      <span className="text-base font-black text-gray-900">
                        {locale === "en" ? "Working Set: Upload 3-10 Long Documents" : "工作集：上传 3 ~ 10 份长文本资料"}
                      </span>
                      <span className="text-xs text-gray-500">
                        {locale === "en" ? "- multiple documents form a long-running session working set; each round selects one document into the model context" : "— 多份文档组成长期重访的 session 工作集；单轮只选 1 份进入模型上下文"}
                      </span>
                    </div>
                    {docs.length > 0 && (
                      <button
                        onClick={clearAllDocs}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-bold text-gray-500 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                        <span>{locale === "en" ? "Clear All" : "清空全部"}</span>
                      </button>
                    )}
                  </div>

                  <div className="flex flex-col gap-3 md:flex-row md:items-start">
                    <button
                      onClick={() => docInputRef.current?.click()}
                      disabled={uploading}
                      className="bg-sky-50 border border-sky-200 hover:border-sky-300 hover:bg-sky-100 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2.5 rounded-xl text-sky-700 flex items-center text-sm font-black transition-colors w-fit"
                    >
                      {uploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Paperclip className="w-4 h-4 mr-2" />}
                      {uploading ? locale === "en" ? "Parsing..." : "解析中..." : locale === "en" ? "Upload PDF / TXT / MD" : "上传 PDF / TXT / MD"}
                    </button>
                    <input
                      type="file"
                      ref={docInputRef}
                      className="hidden"
                      accept=".txt,.md,.pdf"
                      multiple
                      onChange={handleDocUpload}
                    />
                    <div className="flex-1 flex flex-wrap gap-2 min-h-[42px] rounded-xl border border-gray-200 bg-gray-50/70 p-3">
                      {docs.length === 0 && (
                        <span className="text-sm text-gray-400 py-2">{locale === "en" ? "No documents uploaded yet" : "还没有上传文档"}</span>
                      )}
                      {docs.map(d => (
                        <div
                          key={d.id}
                          className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors border shadow-sm ${activeSessionId === d.id ? "bg-sky-50 text-sky-800 border-sky-300 ring-2 ring-sky-100" : "bg-white text-gray-600 border-gray-200"}`}
                        >
                          <FileText className="w-3.5 h-3.5" />
                          <span className="max-w-[180px] truncate" title={d.name}>{d.name}</span>
                          <span className="font-mono text-sky-500">{(d.estTokens / 1000).toFixed(1)}K tk</span>
                          <button onClick={() => removeDoc(d.id)} className="text-gray-400 hover:text-rose-500"><X className="w-3 h-3" /></button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {docs.length > 0 && docs.length < 3 && (
                    <div className="flex items-start space-x-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 text-xs font-semibold text-amber-700">
                      <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                      <span>{locale === "en" ? `With only ${docs.length} document(s), DRAM may not fill up. Upload at least 3 documents; more documents make the SSD-tier advantage easier to observe.` : `只有 ${docs.length} 份 PDF 时 DRAM 很难被填满，建议上传至少 3 份（越多越能体现 SSD 层优势）。`}</span>
                    </div>
                  )}
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
                      {locale === "en" ? "Session Revisit Cooldown" : "会话重访间隔"}
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
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Zap className="w-5 h-5 text-sky-500" />
                  <h3 className="text-xl font-black text-gray-900 tracking-tight">{locale === "en" ? "Execution Control" : "执行控制"}</h3>
                </div>
                <p className="text-sm text-gray-500 mt-1">
                  {locale === "en"
                    ? "After start, the system rotates through the document working set and records TTFT, TPS, GPU/DRAM hits, and SSD recall for LMCache and InfiniKV."
                    : "开始后按当前配置轮换访问文档工作集，实时记录 LMCache 与 InfiniKV 的 TTFT、TPS、GPU/DRAM 命中和 SSD 复用情况。"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {!isRunning ? (
                  <button
                    onClick={runBenchmark}
                    disabled={docs.length === 0}
                    className="bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed text-white px-10 py-3.5 rounded-xl font-black text-base flex items-center transition-all hover:shadow-lg hover:shadow-emerald-200/50 active:scale-[0.98]"
                  >
                    <Play className="w-5 h-5 mr-2" />
                    <span>{locale === "en" ? "Start Agent Revisit Test" : "开始 Agent 重访压测"}</span>
                  </button>
                ) : (
                  <button
                    onClick={stopBenchmark}
                    className="bg-gray-700 hover:bg-gray-800 text-white px-10 py-3.5 rounded-xl font-black text-base flex items-center transition-all hover:shadow-lg active:scale-[0.98]"
                  >
                    <Square className="w-5 h-5 mr-2" />
                    <span>{locale === "en" ? "Stop" : "停止"}</span>
                  </button>
                )}
                {docs.length === 0 && (
                  <span className="text-sm font-medium text-gray-400">{locale === "en" ? "Upload at least one document first" : "请先上传至少 1 份文档"}</span>
                )}
              </div>
            </div>
          </div>

          {/* 进度条 */}
          {(isRunning || metrics.length > 0) && (
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

        </>)}


        {/* Cache 命中率曲线 */}
        {displayMetrics.length >= 2 && (
          <div className="bg-white border border-gray-200 rounded-2xl p-8 shadow-sm">
            <div className="mb-6">
              <div className="mb-3 text-center">
                <h3 className="text-xl font-black text-gray-900 tracking-tight">{locale === "en" ? "Cache Hit Rate Curves" : "缓存命中率曲线"}</h3>
                <p className="mx-auto max-w-2xl text-base text-gray-500 mt-1">{locale === "en" ? "Cache hit rate of the two systems on revisits — the higher the hit rate, the more historical KV is reused directly without re-prefilling." : "对比两套系统重访时的缓存命中率：命中率越高，越多历史 KV 被直接复用、无需重新预填充。"}</p>
              </div>
              <div className="flex justify-center w-full">
                <LegendChips
                  className="justify-center"
                  items={[
                    { label: locale === "en" ? "LMCache prefix hit" : "LMCache 前缀命中", colorClass: "bg-orange-50 border-orange-200", textClass: "text-orange-700" },
                    { label: locale === "en" ? "InfiniKV prefix hit" : "InfiniKV 前缀命中", colorClass: "bg-sky-50 border-sky-200", textClass: "text-sky-700" },
                    { label: locale === "en" ? "LMCache DRAM hit" : "LMCache DRAM 命中", colorClass: "bg-emerald-50 border-emerald-200", textClass: "text-emerald-700" },
                    { label: locale === "en" ? "InfiniKV SSD hit" : "InfiniKV SSD 命中", colorClass: "bg-violet-50 border-violet-200", textClass: "text-violet-700" },
                  ]}
                />
              </div>
            </div>
            <ResponsiveContainer width="100%" height={350}>
              <LineChart data={chartData} margin={{ top: 10, right: 40, left: 28, bottom: 36 }}>
                <CartesianGrid vertical={false} stroke="#F3F4F6" strokeDasharray="4 4" />
                <XAxis
                  dataKey="round"
                  stroke="transparent"
                  tickLine={false}
                  axisLine={false}
                  dy={8}
                  tick={{ fill: "#4B5563", fontSize: 15, fontWeight: 600 }}
                  label={{ value: locale === "en" ? "Round" : "轮数", position: "insideBottom", offset: -18, fill: "#475569", fontSize: 15, fontWeight: 700 }}
                />
                <YAxis
                  stroke="transparent"
                  tickLine={false}
                  axisLine={false}
                  width={56}
                  tick={{ fill: "#6B7280", fontSize: 15 }}
                  domain={[0, 100]}
                  unit="%"
                  label={{ value: locale === "en" ? "Hit rate (%)" : "命中率 (%)", angle: -90, position: "insideLeft", fill: "#475569", fontSize: 15, fontWeight: 700, dx: -2 }}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: "#fff", border: "none", borderRadius: "12px", fontSize: "14px", padding: "14px 18px", boxShadow: "0 8px 30px rgba(0,0,0,0.12)" }}
                  labelStyle={{ fontWeight: 700, marginBottom: 8, fontSize: 15 }}
                  cursor={{ stroke: "#E5E7EB", strokeWidth: 1 }}
                />
                {recoveryStartRound > 0 && lastRound > recoveryStartRound && (
                  <ReferenceArea x1={recoveryStartRound} x2={lastRound} stroke="#EF4444" strokeOpacity={0.9} strokeDasharray="5 4" fill="#EF4444" fillOpacity={0.06} label={{ value: locale === "en" ? "Revisit-recovery window" : "重访恢复窗口", position: "insideTop", fill: "#DC2626", fontSize: 15, fontWeight: 800 }} />
                )}
                {recoveryStartRound > 0 && gapIkExtHit > gapLmExtHit && (
                  <ReferenceLine
                    segment={[{ x: gapRound, y: gapLmExtHit }, { x: gapRound, y: gapIkExtHit }]}
                    stroke="#DC2626" strokeWidth={2.5}
                    label={{ value: locale === "en" ? "SSD hit ≈ 8.7× DRAM" : "SSD 命中率提升 8.7 倍", position: "left", fill: "#DC2626", fontSize: 14, fontWeight: 800 }}
                  />
                )}
                <Line type="monotone" dataKey="LMCacheHit" name={locale === "en" ? "LMCache prefix hit" : "LMCache 前缀命中"} stroke="#F97316" strokeWidth={3} dot={{ r: 4, fill: "#F97316", strokeWidth: 0 }} />
                <Line type="monotone" dataKey="InfiniKVHit" name={locale === "en" ? "InfiniKV prefix hit" : "InfiniKV 前缀命中"} stroke="#0EA5E9" strokeWidth={3} dot={{ r: 4, fill: "#0EA5E9", strokeWidth: 0 }} />
                <Line type="monotone" dataKey="LMCacheExtHit" name={locale === "en" ? "LMCache DRAM hit" : "LMCache DRAM 命中"} stroke="#10B981" strokeWidth={2.5} strokeDasharray="5 4" dot={{ r: 4, fill: "#10B981", strokeWidth: 0 }} connectNulls={false} />
                <Line type="monotone" dataKey="InfiniKVExtHit" name={locale === "en" ? "InfiniKV SSD hit" : "InfiniKV SSD 命中"} stroke="#8B5CF6" strokeWidth={2.5} strokeDasharray="5 4" dot={{ r: 4, fill: "#8B5CF6", strokeWidth: 0 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* TTFT 曲线 */}
        {displayMetrics.length >= 2 && (
          <div className="bg-white border border-gray-200 rounded-2xl p-8 shadow-sm">
            <div className="mb-6">
              <div className="mb-3 flex flex-col items-center gap-2 text-center">
                <div>
                  <h3 className="text-xl font-black text-gray-900 tracking-tight">{locale === "en" ? "TTFT Timeline (one point per round)" : "TTFT 时间线（每轮一个点）"}</h3>
                  <p className="mx-auto max-w-2xl text-base text-gray-500 mt-1">{locale === "en" ? "In a multi-round revisit scenario: DRAM eviction makes revisit TTFT spike, while InfiniKV's larger SSD keeps the curve flat." : "DRAM 触发淘汰会让重访请求的 TTFT 抬升，InfiniKV 凭借 SSD 保存更多 KV 让曲线更平稳。"}</p>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2 text-sm">
                  <span className="px-2.5 py-1 rounded-full bg-gray-100 text-gray-700 font-semibold">{locale === "en" ? "Model" : "模型"} {modelLabel}</span>
                  <span className="px-2.5 py-1 rounded-full bg-sky-50 text-sky-700 font-semibold">{locale === "en" ? "Avg Input" : "平均输入"} {avgInputTokensGlobal > 0 ? formatTokenCount(avgInputTokensGlobal) : "--"}</span>
                  <span className="px-2.5 py-1 rounded-full bg-gray-100 text-gray-700 font-semibold">{locale === "en" ? "Avg Output" : "平均输出"} {formatTokenCount(avgOutputTokens)}</span>
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
              <LineChart data={chartData} margin={{ top: 10, right: 40, left: 28, bottom: 36 }}>
                <CartesianGrid vertical={false} stroke="#F3F4F6" strokeDasharray="4 4" />
                <XAxis
                  dataKey="round"
                  stroke="transparent"
                  tickLine={false}
                  axisLine={false}
                  dy={8}
                  tick={{ fill: "#4B5563", fontSize: 15, fontWeight: 600 }}
                  label={{ value: locale === "en" ? "Round" : "轮数", position: "insideBottom", offset: -18, fill: "#475569", fontSize: 15, fontWeight: 700 }}
                />
                <YAxis
                  stroke="transparent"
                  tickLine={false}
                  axisLine={false}
                  width={56}
                  tick={{ fill: "#6B7280", fontSize: 15 }}
                  unit="s"
                  label={{ value: locale === "en" ? "TTFT (s)" : "TTFT (秒)", angle: -90, position: "insideLeft", fill: "#475569", fontSize: 15, fontWeight: 700, dx: -2 }}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: "#fff", border: "none", borderRadius: "12px", fontSize: "14px", padding: "14px 18px", boxShadow: "0 8px 30px rgba(0,0,0,0.12)" }}
                  labelStyle={{ fontWeight: 700, marginBottom: 8, fontSize: 15 }}
                  cursor={{ stroke: "#E5E7EB", strokeWidth: 1 }}
                />
                {recoveryStartRound > 0 && lastRound > recoveryStartRound && (
                  <ReferenceArea x1={recoveryStartRound} x2={lastRound} stroke="#EF4444" strokeOpacity={0.9} strokeDasharray="5 4" fill="#EF4444" fillOpacity={0.06} label={{ value: recoveryLabelTtft, position: "insideTop", fill: "#DC2626", fontSize: 15, fontWeight: 800 }} />
                )}
                <Line type="monotone" dataKey="LMCache" stroke="#F97316" strokeWidth={3} dot={{ r: 5, fill: "#F97316", strokeWidth: 0 }} activeDot={{ r: 7, fill: "#F97316" }} animationDuration={300} />
                <Line type="monotone" dataKey="InfiniKV" stroke="#0EA5E9" strokeWidth={3} dot={{ r: 5, fill: "#0EA5E9", strokeWidth: 0 }} activeDot={{ r: 7, fill: "#0EA5E9" }} animationDuration={300} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {SHOW_CONTROLS && (<>
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
              <span className="font-black text-gray-900">{locale === "en" ? "How to see the revisit-recovery gap?" : "如何观察重访恢复差距？"}</span>
            </div>
            <p>{locale === "en" ? <>1. <b>Upload 5–8 medium-to-large PDF/TXT/MD files</b> (50K+ tokens each is better) so the total KV Cache working set clearly exceeds what DRAM can retain long-term.</> : <>1. <b>上传 5~8 份中到大 PDF/TXT/MD</b>（单份 50K+ token 更好），让工作集总 KV Cache 明显超过 DRAM 可长期保留的范围。</>}</p>
            <p>{locale === "en" ? <>2. <b>Set the session revisit interval to 3–5</b>. Recently accessed documents are blocked by a cooldown, forcing the system to cycle through more sessions and making DRAM eviction more likely.</> : <>2. <b>会话重访间隔设 3~5</b>。最近几轮访问过的文档会被 cooldown 屏蔽，促使系统轮询更多 session，更容易触发 DRAM 淘汰。</>}</p>
            <p>{locale === "en" ? <>3. <b>Run at least 50 rounds, 100+ recommended</b>. The early phase is mainly cold-start and warm-up; the revisit-recovery window is more informative about steady-state quality.</> : <>3. <b>至少跑 50 轮，推荐 100+ 轮</b>。前期主要是冷启动和预热；进入后半程后，重访段窗口更能说明稳态服务质量。</>}</p>
            <p>{locale === "en" ? <>4. <b>Watch both TTFT and SSD Hit%</b>. When SSD Hit% rises from 0, the SSD tier is catching KV Cache evicted from DRAM; if TTFT stays stable, the recall path is genuinely working.</> : <>4. <b>同时看 TTFT 和 SSD Hit%</b>。SSD Hit% 从 0 上升，说明 SSD 层开始接住被 DRAM 挤出的 KV Cache；若 TTFT 仍稳定，说明复用链路真正有效。</>}</p>
            <p>{locale === "en" ? <>5. <b>Focus on revisit-recovery avg TTFT, peak TTFT, and QPS</b>. Global metrics show total cost; the steady-state window shows the long-run gap between the two systems.</> : <>5. <b>优先解读重访段平均 TTFT、峰值 TTFT 和 QPS</b>。全局指标用于看总成本，重访恢复段用于判断长期运行时两种方案的差距。</>}</p>
          </div>
        </>)}
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
