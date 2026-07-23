import { runHotspots } from "../pipeline/commands";
import { createInsightCommand } from "./insight-command";

export const hotspotsCommand = createInsightCommand({
    name: "hotspots",
    desc: "Rank files by change frequency and complexity to surface the refactor shortlist",
    run: runHotspots,
});
