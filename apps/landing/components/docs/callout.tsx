import { Info, Lightbulb, TriangleAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type CalloutVariant = "note" | "warning" | "tip";

type CalloutProps = {
    variant?: CalloutVariant;
    children: React.ReactNode;
};

const variantStyles: Record<
    CalloutVariant,
    { icon: LucideIcon; box: string; iconColor: string }
> = {
    note: {
        icon: Info,
        box: "border-primary/30 bg-primary/5",
        iconColor: "text-primary",
    },
    warning: {
        icon: TriangleAlert,
        box: "border-destructive/40 bg-destructive/10",
        iconColor: "text-destructive",
    },
    tip: {
        icon: Lightbulb,
        box: "border-chart-4/40 bg-chart-4/10",
        iconColor: "text-chart-4",
    },
};

export function Callout({ variant = "note", children }: CalloutProps) {
    const style = variantStyles[variant];
    const Icon = style.icon;

    return (
        <div className={cn("my-6 flex gap-3 rounded-lg border p-4", style.box)}>
            <Icon
                className={cn("mt-0.5 h-5 w-5 shrink-0", style.iconColor)}
                aria-hidden
            />
            <div className="min-w-0 text-sm leading-relaxed text-muted-foreground [&>p]:my-0 [&>p]:leading-relaxed">
                {children}
            </div>
        </div>
    );
}
