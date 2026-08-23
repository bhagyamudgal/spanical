import {
    Activity,
    Flame,
    GitFork,
    GitPullRequest,
    History,
    Scaling,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export const SITE_NAME = "spanical";
export const SITE_TAGLINE = "Code insights from git history";
export const GITHUB_URL = "https://github.com/bhagyamudgal/spanical";

export type Feature = {
    icon: LucideIcon;
    title: string;
    description: string;
};

export const FEATURES: Feature[] = [
    {
        icon: Activity,
        title: "Throughput churn",
        description:
            "Added plus deleted lines and commit counts per period, with a per-developer breakdown when you want the people view.",
    },
    {
        icon: Flame,
        title: "Hotspot ranking",
        description:
            "Files that change often and carry complexity at once float up as a refactor shortlist. Bulk reformats sink.",
    },
    {
        icon: GitFork,
        title: "Ownership and bus factor",
        description:
            "git blame at HEAD shows who wrote the lines that survived, and which directories ride on one person.",
    },
    {
        icon: History,
        title: "Auto-narrated timeline",
        description:
            "A month-by-month story of your window: dominant commits, churn spikes, and removal periods, detected for you.",
    },
    {
        icon: Scaling,
        title: "Size and complexity trends",
        description:
            "Monthly snapshots from scc at each month-end commit, so history reads as it was, not as a later cleanup made it look.",
    },
    {
        icon: GitPullRequest,
        title: "Optional ticket layer",
        description:
            "Pull request flow, cycle time, thrash, review load and review coverage from GitHub, synced into the same local cache.",
    },
];

export type Step = {
    number: number;
    title: string;
    description: string;
    command: string;
};

export const STEPS: Step[] = [
    {
        number: 1,
        title: "Run a report",
        description: "One command inside any git repo",
        command: "spanical report",
    },
    {
        number: 2,
        title: "Find the risk",
        description: "The refactor shortlist",
        command: "spanical hotspots",
    },
    {
        number: 3,
        title: "See who knows what",
        description: "Blame-based ownership map",
        command: "spanical ownership",
    },
    {
        number: 4,
        title: "Add the ticket layer",
        description: "GitHub flow and review coverage",
        command: "spanical tickets",
    },
];

export const INSTALL_SCRIPT =
    "curl -fsSL https://raw.githubusercontent.com/bhagyamudgal/spanical/main/install.sh | bash";

export type InstallMethod = {
    id: string;
    label: string;
    lines: string[];
};

export const INSTALL_METHODS: InstallMethod[] = [
    { id: "script", label: "Quick install", lines: [INSTALL_SCRIPT] },
    {
        id: "source",
        label: "From source",
        lines: [
            "git clone https://github.com/bhagyamudgal/spanical",
            "cd spanical && bun install",
        ],
    },
];
