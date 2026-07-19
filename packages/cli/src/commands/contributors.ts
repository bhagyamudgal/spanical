import { runContributors } from "../pipeline/commands";
import { createInsightCommand } from "./insight-command";

export const contributorsCommand = createInsightCommand({
    name: "contributors",
    desc: "Show per-dev activity across the whole window",
    run: runContributors,
});
