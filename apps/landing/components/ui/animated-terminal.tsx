"use client";

import { cn } from "@/lib/utils";

type TerminalLine = {
    text: string;
    type: "command" | "output" | "blank";
};

const TERMINAL_LINES: TerminalLine[] = [
    { text: "cd repo-alpha", type: "command" },
    { text: "spanical report", type: "command" },
    {
        text: "  last 12m (2025-08 → 2026-08) · monthly · 1 repo · UTC",
        type: "output",
    },
    { text: "", type: "blank" },
    {
        text: "  Net growth        +104 LOC     Total now      93 LOC",
        type: "output",
    },
    { text: "", type: "blank" },
    { text: "Top hotspots (refactor shortlist)", type: "output" },
    {
        text: "  src/core/engine.ts  churn 3 · cx 0 · owners 3",
        type: "output",
    },
    { text: "", type: "blank" },
    { text: "spanical hotspots", type: "command" },
];

type AnimatedTerminalProps = {
    className?: string;
};

export function AnimatedTerminal({ className }: AnimatedTerminalProps) {
    return (
        <div
            className={cn(
                "overflow-hidden rounded-xl border border-primary/20 bg-[oklch(0.11_0.008_230)] terminal-glow",
                className
            )}
        >
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
                <div className="flex gap-1.5">
                    <span className="h-3 w-3 rounded-full bg-red-500/80" />
                    <span className="h-3 w-3 rounded-full bg-yellow-500/80" />
                    <span className="h-3 w-3 rounded-full bg-teal-500/80" />
                </div>
                <span className="ml-2 font-mono text-xs text-white/50">
                    Terminal
                </span>
            </div>

            <div className="p-5 font-mono text-sm leading-relaxed">
                {TERMINAL_LINES.map((line, index) => {
                    if (line.type === "blank") {
                        return (
                            <div
                                key={index}
                                className="h-4 animate-fade-in-up"
                                style={{ animationDelay: `${index * 0.2}s` }}
                            />
                        );
                    }

                    return (
                        <div
                            key={index}
                            className="animate-fade-in-up"
                            style={{ animationDelay: `${index * 0.2}s` }}
                        >
                            {line.type === "command" ? (
                                <span>
                                    <span className="text-teal-400">$ </span>
                                    <span className="text-white">
                                        {line.text}
                                    </span>
                                </span>
                            ) : (
                                <span className="text-white/60">
                                    {line.text}
                                </span>
                            )}
                        </div>
                    );
                })}
                <div
                    className="mt-1 animate-fade-in-up"
                    style={{
                        animationDelay: `${TERMINAL_LINES.length * 0.2}s`,
                    }}
                >
                    <span className="text-teal-400">$ </span>
                    <span className="inline-block h-4 w-2 translate-y-0.5 animate-blink-caret bg-teal-400" />
                </div>
            </div>
        </div>
    );
}
