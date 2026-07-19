import { runOwnership } from "../pipeline/commands";
import { createInsightCommand } from "./insight-command";

export const ownershipCommand = createInsightCommand({
    name: "ownership",
    desc: "Show surviving-line ownership and bus-factor risk from git blame at HEAD",
    run: runOwnership,
});
