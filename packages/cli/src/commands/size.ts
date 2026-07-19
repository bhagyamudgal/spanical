import { runSize } from "../pipeline/commands";
import { createInsightCommand } from "./insight-command";

export const sizeCommand = createInsightCommand({
    name: "size",
    desc: "Show code size and complexity trend from monthly scc snapshots",
    run: runSize,
});
