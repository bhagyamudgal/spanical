import { runReviews } from "../pipeline/commands";
import { createInsightCommand } from "./insight-command";

export const reviewsCommand = createInsightCommand({
    name: "reviews",
    desc: "Show per-dev review load, review latency and team review coverage (GitHub)",
    run: runReviews,
});
