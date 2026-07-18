import { z } from "zod";

const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_EXCLUDE = ["**/*.lock", "**/dist/**", "**/.next/**", "**/*.snap"];
const DEFAULT_MIGRATIONS_PATH = "**/migrations/**";
const DEFAULT_MIN_FILE_LINES = 50;
const DEFAULT_BUS_FACTOR_THRESHOLD = 0.8;
const DEFAULT_REWORK_WINDOW_DAYS = 21;
const GITHUB_TOKEN_ENV_REF = "env:GITHUB_TOKEN";

function isValidTimeZone(timeZone: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone });
        return true;
    } catch {
        return false;
    }
}

const repoSchema = z.strictObject({
    name: z.string().min(1),
    path: z.string().min(1),
    branch: z.string().min(1).optional(),
});

const authorSchema = z.strictObject({
    emails: z.array(z.string().min(1)).min(1),
    github: z.array(z.string().min(1)).optional(),
});

const ticketsSchema = z.strictObject({
    source: z.literal("github"),
    github: z.strictObject({
        repos: z.array(z.string().min(1)).min(1),
        token: z.literal(GITHUB_TOKEN_ENV_REF),
        includeIssues: z.boolean().default(true),
    }),
    attribution: z.enum(["assignee", "author", "closer"]).default("assignee"),
});

export const configSchema = z.strictObject({
    repos: z
        .array(repoSchema)
        .min(1)
        .refine(
            (repos) =>
                new Set(repos.map((repo) => repo.name)).size === repos.length,
            "repo names must be unique"
        ),
    since: z.iso.date().optional(),
    timezone: z
        .string()
        .min(1)
        .refine(isValidTimeZone, "must be a valid IANA timezone")
        .default(DEFAULT_TIMEZONE),
    exclude: z.array(z.string()).default(DEFAULT_EXCLUDE),
    migrationsPath: z.string().min(1).default(DEFAULT_MIGRATIONS_PATH),
    authors: z.record(z.string(), authorSchema).default({}),
    hotspot: z
        .strictObject({
            minFileLines: z
                .number()
                .int()
                .positive()
                .default(DEFAULT_MIN_FILE_LINES),
            busFactorThreshold: z
                .number()
                .min(0)
                .max(1)
                .default(DEFAULT_BUS_FACTOR_THRESHOLD),
        })
        .default({
            minFileLines: DEFAULT_MIN_FILE_LINES,
            busFactorThreshold: DEFAULT_BUS_FACTOR_THRESHOLD,
        }),
    reworkWindowDays: z
        .number()
        .int()
        .positive()
        .default(DEFAULT_REWORK_WINDOW_DAYS),
    tickets: ticketsSchema.optional(),
});

export type SpanicalConfig = z.infer<typeof configSchema>;
export type SpanicalUserConfig = z.input<typeof configSchema>;
