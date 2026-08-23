export type DocsNavItem = {
    href: string;
    title: string;
};

export type DocsNavSection = {
    label: string;
    items: DocsNavItem[];
};

export const docsNav: DocsNavSection[] = [
    {
        label: "Getting started",
        items: [
            { href: "/docs", title: "Introduction" },
            { href: "/docs/installation", title: "Installation" },
            { href: "/docs/quickstart", title: "Quickstart" },
            { href: "/docs/configuration", title: "Configuration" },
            { href: "/docs/global-flags", title: "Global flags" },
            { href: "/docs/time-windows", title: "Time windows" },
        ],
    },
    {
        label: "Commands",
        items: [
            { href: "/docs/report", title: "report" },
            { href: "/docs/churn", title: "churn" },
            { href: "/docs/contributors", title: "contributors" },
            { href: "/docs/size", title: "size" },
            { href: "/docs/ownership", title: "ownership" },
            { href: "/docs/hotspots", title: "hotspots" },
            { href: "/docs/tickets", title: "tickets" },
            { href: "/docs/reviews", title: "reviews" },
            { href: "/docs/timeline", title: "timeline" },
            { href: "/docs/cache", title: "cache" },
            { href: "/docs/update", title: "update" },
        ],
    },
];

export const flatDocsItems: DocsNavItem[] = docsNav.flatMap(
    (section) => section.items
);

export function getDocsNeighbors(pathname: string): {
    previous?: DocsNavItem;
    next?: DocsNavItem;
} {
    const index = flatDocsItems.findIndex((item) => item.href === pathname);
    if (index === -1) return {};
    return {
        previous: index > 0 ? flatDocsItems[index - 1] : undefined,
        next:
            index < flatDocsItems.length - 1
                ? flatDocsItems[index + 1]
                : undefined,
    };
}
