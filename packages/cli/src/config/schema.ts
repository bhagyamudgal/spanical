import { z } from "zod";

const DEFAULT_TIMEZONE = "Europe/Zurich";
const DEFAULT_EXCLUDE = ["**/*.lock", "**/dist/**", "**/.next/**", "**/*.snap"];
const DEFAULT_MIGRATIONS_PATH = "**/migrations/**";
const DEFAULT_MIN_FILE_LINES = 50;
const DEFAULT_BUS_FACTOR_THRESHOLD = 0.8;
const DEFAULT_REWORK_WINDOW_DAYS = 21;
const ENV_TOKEN_PATTERN = /^env:[A-Z_][A-Z0-9_]*$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const repoSchema = z.object({
    name: z.string().min(1),
    path: z.string().min(1),
    branch: z.string().min(1).optional(),
});

const authorSchema = z.object({
    emails: z.array(z.string().min(1)).min(1),
    github: z.array(z.string().min(1)).optional(),
});

const ticketsSchema = z.object({
    source: z.literal("github"),
    github: z.object({
        repos: z.array(z.string().min(1)).min(1),
        token: z
            .string()
            .regex(
                ENV_TOKEN_PATTERN,
                'must be an env reference like "env:GITHUB_TOKEN"'
            ),
        includeIssues: z.boolean().default(true),
    }),
    attribution: z.enum(["assignee", "author", "closer"]).default("assignee"),
});

export const configSchema = z.object({
    repos: z.array(repoSchema).min(1),
    since: z
        .string()
        .regex(ISO_DATE_PATTERN, 'must be an ISO date like "2025-07-01"')
        .optional(),
    timezone: z.string().min(1).default(DEFAULT_TIMEZONE),
    exclude: z.array(z.string()).default(DEFAULT_EXCLUDE),
    migrationsPath: z.string().min(1).default(DEFAULT_MIGRATIONS_PATH),
    authors: z.record(z.string(), authorSchema).default({}),
    hotspot: z
        .object({
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
