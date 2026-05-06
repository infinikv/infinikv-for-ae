"use client";

import React from "react";

type SideMetrics = {
    label: string;
    avgTtft: number;
    totalTtft?: number;
    qps: number;
    avgInputTokens?: number;
    avgOutputTokens?: number;
    accent: "amber" | "sky";
};

const toTokenText = (value: number) => (value > 0 ? `${Math.round(value).toLocaleString()} tk` : "--");
const toSec = (value: number) => (value > 0 ? `${value.toFixed(3)}s` : "--");
const toQps = (value: number) => (value > 0 ? value.toFixed(2) : "--");

export default function ModelMetricsPanel({
    model,
    lm,
    ik,
    qpsGainPct,
    title = "核心指标总览",
}: {
    model: string;
    lm: SideMetrics;
    ik: SideMetrics;
    qpsGainPct: number;
    title?: string;
}) {
    const lmTone = "border-amber-200 bg-amber-50 text-amber-700";
    const ikTone = "border-sky-200 bg-sky-50 text-sky-700";
    const toneMap: Record<SideMetrics["accent"], string> = {
        amber: lmTone,
        sky: ikTone,
    };
    const gainReady = lm.qps > 0 && ik.qps > 0;

    return (
        <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
            <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="text-sm text-gray-500 font-semibold">{title}</div>
                <div className="flex items-center gap-2 text-xs font-mono">
                    <span className="px-2.5 py-1 rounded-md bg-gray-50 border border-gray-200 text-gray-600">模型 {model}</span>
                    <span className={`px-2.5 py-1 rounded-md border ${gainReady ? (qpsGainPct >= 0 ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-rose-50 border-rose-200 text-rose-700") : "bg-gray-50 border-gray-200 text-gray-500"}`}>
                        {gainReady ? `QPS 提升 ${qpsGainPct >= 0 ? "+" : ""}${qpsGainPct.toFixed(1)}%` : "QPS 提升 --"}
                    </span>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
                <div className={`rounded-xl border px-4 py-3 ${toneMap[lm.accent]}`}>
                    <div className="text-xs font-semibold">{lm.label}</div>
                    <div className="grid grid-cols-5 gap-3 mt-2 text-sm">
                        <div>
                            <div className="text-[11px] text-gray-500">平均 TTFT</div>
                            <div className="font-mono font-bold text-gray-900">{toSec(lm.avgTtft)}</div>
                        </div>
                        <div>
                            <div className="text-[11px] text-gray-500">累计 TTFT</div>
                            <div className="font-mono font-bold text-gray-900">{lm.totalTtft && lm.totalTtft > 0 ? `${lm.totalTtft.toFixed(2)}s` : "--"}</div>
                        </div>
                        <div>
                            <div className="text-[11px] text-gray-500">估算 QPS</div>
                            <div className="font-mono font-bold text-gray-900">{toQps(lm.qps)}</div>
                        </div>
                        <div>
                            <div className="text-[11px] text-gray-500">平均输入</div>
                            <div className="font-mono font-bold text-gray-900">{toTokenText(lm.avgInputTokens || 0)}</div>
                        </div>
                        <div>
                            <div className="text-[11px] text-gray-500">平均输出</div>
                            <div className="font-mono font-bold text-gray-900">{toTokenText(lm.avgOutputTokens || 0)}</div>
                        </div>
                    </div>
                </div>

                <div className={`rounded-xl border px-4 py-3 ${toneMap[ik.accent]}`}>
                    <div className="text-xs font-semibold">{ik.label}</div>
                    <div className="grid grid-cols-5 gap-3 mt-2 text-sm">
                        <div>
                            <div className="text-[11px] text-gray-500">平均 TTFT</div>
                            <div className="font-mono font-bold text-gray-900">{toSec(ik.avgTtft)}</div>
                        </div>
                        <div>
                            <div className="text-[11px] text-gray-500">累计 TTFT</div>
                            <div className="font-mono font-bold text-gray-900">{ik.totalTtft && ik.totalTtft > 0 ? `${ik.totalTtft.toFixed(2)}s` : "--"}</div>
                        </div>
                        <div>
                            <div className="text-[11px] text-gray-500">估算 QPS</div>
                            <div className="font-mono font-bold text-gray-900">{toQps(ik.qps)}</div>
                        </div>
                        <div>
                            <div className="text-[11px] text-gray-500">平均输入</div>
                            <div className="font-mono font-bold text-gray-900">{toTokenText(ik.avgInputTokens || 0)}</div>
                        </div>
                        <div>
                            <div className="text-[11px] text-gray-500">平均输出</div>
                            <div className="font-mono font-bold text-gray-900">{toTokenText(ik.avgOutputTokens || 0)}</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
