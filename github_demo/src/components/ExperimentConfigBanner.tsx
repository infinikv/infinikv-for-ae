"use client";

import React from "react";

export default function ExperimentConfigBanner({
    workloadLabel,
    className = "",
}: {
    workloadLabel: string;
    className?: string;
}) {
    return (
        <div className={`bg-white border border-gray-200 rounded-2xl p-5 shadow-sm ${className}`}>
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="text-sm text-gray-500 font-semibold">实验配置与存储成本（{workloadLabel}）</div>
                <div className="text-xs font-mono text-gray-400">统一对照口径</div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                    <div className="text-xs text-amber-700 font-semibold">LMCache-DRAM</div>
                    <div className="text-sm font-bold text-gray-900 mt-1">卸载介质：64GB DRAM</div>
                    <div className="text-xs text-gray-600 mt-1">云服务器存储成本：3.8 元 / 小时</div>
                </div>
                <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3">
                    <div className="text-xs text-sky-700 font-semibold">InfiniKV (SSD)</div>
                    <div className="text-sm font-bold text-gray-900 mt-1">卸载介质：512GB SSD</div>
                    <div className="text-xs text-gray-600 mt-1">云服务器存储成本：0.28 元 / 小时</div>
                </div>
            </div>
        </div>
    );
}
