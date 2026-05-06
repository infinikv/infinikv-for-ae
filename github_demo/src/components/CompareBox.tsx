"use client";

import React from "react";

export default function CompareBox({ backendName, metrics, output }: { backendName: string, metrics: any, output: string }) {
    const isError = metrics.status === "oom" || metrics.status === "error";

    return (
        <div className="flex flex-col h-full w-full space-y-4">
            {/* Metrics Row */}
            <div className="grid grid-cols-4 gap-2 border-b pb-4">
                <div className="flex flex-col">
                    <span className="text-xs text-gray-500 font-semibold uppercase tracking-wider">TTFT</span>
                    <span className={`text-xl font-mono ${isError ? 'text-red-500' : 'text-gray-900 font-bold'}`}>
                        {metrics.ttft > 0 ? `${metrics.ttft} s` : '--'}
                    </span>
                </div>
                <div className="flex flex-col">
                    <span className="text-xs text-gray-500 font-semibold uppercase tracking-wider">Speed</span>
                    <span className="text-xl font-mono font-bold text-gray-900">
                        {metrics.tokensPerSec > 0 ? `${metrics.tokensPerSec} t/s` : '--'}
                    </span>
                </div>
                <div className="flex flex-col">
                    <span className="text-xs text-gray-500 font-semibold uppercase tracking-wider">Tokens</span>
                    <span className="text-xl font-mono text-gray-900">
                        {metrics.outTokens > 0 ? metrics.outTokens : '--'}
                    </span>
                </div>
                <div className="flex flex-col">
                    <span className="text-xs text-gray-500 font-semibold uppercase tracking-wider">Total Time</span>
                    <span className="text-xl font-mono text-gray-900">
                        {metrics.totalTime > 0 ? `${metrics.totalTime} s` : '--'}
                    </span>
                </div>
            </div>

            {/* Terminal / Output Area */}
            <div className={`flex-1 relative rounded bg-gray-50 p-4 font-mono text-sm overflow-y-auto ${isError ? 'bg-red-50/50 text-red-600' : 'text-gray-800'}`}>
                {metrics.status === 'running' && (
                    <div className="absolute inset-0 bg-white/50 flex flex-col items-center justify-center pointer-events-none z-10">
                        <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                        <span className="mt-2 font-mono text-xs font-bold text-blue-600">Generating Next Token...</span>
                    </div>
                )}
                {output}
            </div>
        </div>
    );
}
