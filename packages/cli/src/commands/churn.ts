import { runChurn } from "../pipeline/commands";
import { createInsightCommand } from "./insight-command";

export const churnCommand = createInsightCommand({
    name: "churn",
    desc: "Show commit volume and churn per period, or per dev with --by dev",
    run: runChurn,
});
