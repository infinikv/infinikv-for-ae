"use client";

import React from "react";

export default function LegendChips({
    items,
    className = "",
}: {
    items: Array<{ label: string; colorClass: string; textClass?: string }>;
    className?: string;
}) {
    return (
        <div className={`flex flex-wrap items-center gap-2 ${className}`}>
            {items.map(item => (
                <span
                    key={item.label}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-sm font-semibold ${item.textClass || "text-gray-700"} ${item.colorClass}`}
                >
                    <span className="w-2.5 h-2.5 rounded-sm bg-current" />
                    {item.label}
                </span>
            ))}
        </div>
    );
}
