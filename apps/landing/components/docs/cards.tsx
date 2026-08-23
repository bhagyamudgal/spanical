import Link from "next/link";
import type { ReactNode } from "react";

type CardLinkProps = {
    title: string;
    href: string;
    children?: ReactNode;
};

type CardGroupProps = {
    children: ReactNode;
};

export function DocsCard({ title, href, children }: CardLinkProps) {
    return (
        <Link
            href={href}
            className="group rounded-xl border border-border bg-card p-5 transition-colors outline-none hover:border-primary/40 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
        >
            <span className="font-mono text-sm font-semibold text-foreground group-hover:text-primary">
                {title}
            </span>
            {children ? (
                <span className="mt-2 block text-sm leading-relaxed text-muted-foreground">
                    {children}
                </span>
            ) : null}
        </Link>
    );
}

export function DocsCardGroup({ children }: CardGroupProps) {
    return (
        <div className="my-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {children}
        </div>
    );
}
