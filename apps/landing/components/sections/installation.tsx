"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { INSTALL_METHODS } from "@/lib/constants";

export function Installation() {
    const [copied, setCopied] = useState<string | null>(null);

    async function copyToClipboard(id: string, text: string) {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(id);
            setTimeout(() => setCopied(null), 2000);
        } catch (err) {
            console.error("Failed to copy to clipboard:", err);
        }
    }

    return (
        <section id="installation" className="py-32">
            <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
                <div className="text-center">
                    <h2 className="font-mono text-3xl font-bold tracking-tight text-foreground sm:text-4xl lg:text-5xl">
                        Get started in seconds
                    </h2>
                    <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
                        Install the released binary, or run from source
                    </p>
                </div>

                <div className="mx-auto mt-16 max-w-2xl">
                    <div className="overflow-hidden rounded-xl border border-primary/20 terminal-glow">
                        <div className="flex items-center gap-2 border-b border-white/10 bg-[oklch(0.11_0.008_230)] px-4 py-3">
                            <div className="flex gap-1.5">
                                <span className="h-3 w-3 rounded-full bg-red-500/80" />
                                <span className="h-3 w-3 rounded-full bg-yellow-500/80" />
                                <span className="h-3 w-3 rounded-full bg-teal-500/80" />
                            </div>
                            <span className="ml-2 font-mono text-xs text-white/50">
                                Install
                            </span>
                        </div>

                        <div className="bg-[oklch(0.11_0.008_230)] p-2">
                            <Tabs
                                defaultValue={INSTALL_METHODS[0]?.id}
                                className="w-full"
                            >
                                <TabsList className="w-full justify-start gap-0 rounded-none border-b border-white/10 bg-transparent p-0">
                                    {INSTALL_METHODS.map((method) => (
                                        <TabsTrigger
                                            key={method.id}
                                            value={method.id}
                                            className="rounded-none border-b-2 border-transparent px-4 py-2 font-mono text-xs text-white/60 data-[state=active]:border-teal-400 data-[state=active]:bg-transparent data-[state=active]:text-teal-400 data-[state=active]:shadow-none"
                                        >
                                            {method.label}
                                        </TabsTrigger>
                                    ))}
                                </TabsList>

                                {INSTALL_METHODS.map((method) => (
                                    <TabsContent
                                        key={method.id}
                                        value={method.id}
                                    >
                                        <div className="relative px-4 py-4">
                                            <pre className="overflow-x-auto pr-12 font-mono text-sm leading-relaxed">
                                                <code>
                                                    {method.lines.map(
                                                        (line, lineIndex) => (
                                                            <span
                                                                key={lineIndex}
                                                            >
                                                                <span className="text-teal-400">
                                                                    ${" "}
                                                                </span>
                                                                <span className="text-white">
                                                                    {line}
                                                                </span>
                                                                {lineIndex <
                                                                method.lines
                                                                    .length -
                                                                    1
                                                                    ? "\n"
                                                                    : null}
                                                            </span>
                                                        )
                                                    )}
                                                </code>
                                            </pre>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="absolute top-3 right-3 h-8 w-8 text-white/50 transition-colors hover:text-teal-400"
                                                onClick={() =>
                                                    copyToClipboard(
                                                        method.id,
                                                        method.lines.join(
                                                            " && "
                                                        )
                                                    )
                                                }
                                            >
                                                {copied === method.id ? (
                                                    <Check className="h-4 w-4 text-teal-400" />
                                                ) : (
                                                    <Copy className="h-4 w-4" />
                                                )}
                                            </Button>
                                        </div>
                                    </TabsContent>
                                ))}
                            </Tabs>
                        </div>
                    </div>

                    <p className="mt-4 text-center font-mono text-xs text-muted-foreground">
                        <span className="text-primary">Recommended:</span> Quick
                        install verifies the checksum and puts the binary on
                        your PATH
                    </p>

                    <div className="mt-6 flex flex-wrap justify-center gap-4">
                        {[
                            "darwin x64",
                            "darwin arm64",
                            "linux x64",
                            "linux arm64",
                        ].map((platform) => (
                            <span
                                key={platform}
                                className="font-mono text-xs text-muted-foreground"
                            >
                                <span className="text-primary/60">&gt;</span>{" "}
                                {platform}
                            </span>
                        ))}
                    </div>
                </div>
            </div>
        </section>
    );
}
