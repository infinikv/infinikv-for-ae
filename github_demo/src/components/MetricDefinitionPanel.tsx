"use client";

import React from "react";

export default function MetricDefinitionPanel() {
    return (
        <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
            <h3 className="text-lg font-black text-gray-900 tracking-tight mb-3">指标释义</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
                    <div className="text-xs font-semibold text-gray-500">TTFT</div>
                    <div className="text-base font-bold text-gray-900 mt-1">首字延迟</div>
                    <div className="text-xs text-gray-600 mt-1">从请求发出到首个输出 token 返回的时间，越低越好。</div>
                </div>
                <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
                    <div className="text-xs font-semibold text-gray-500">TPS</div>
                    <div className="text-base font-bold text-gray-900 mt-1">生成吞吐</div>
                    <div className="text-xs text-gray-600 mt-1">模型生成阶段每秒输出 token 数，越高越好。</div>
                </div>
                <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
                    <div className="text-xs font-semibold text-gray-500">QPS</div>
                    <div className="text-base font-bold text-gray-900 mt-1">系统处理速率</div>
                    <div className="text-xs text-gray-600 mt-1">基于 TTFT 与生成时间估算的请求吞吐，越高越好。</div>
                </div>
            </div>
        </div>
    );
}
