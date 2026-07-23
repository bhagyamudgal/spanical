import { runTimeline } from "../pipeline/commands";
import { createInsightCommand } from "./insight-command";

export const timelineCommand = createInsightCommand({
    name: "timeline",
    desc: "Show a per-period narrative with auto-detected events per period",
    run: runTimeline,
});
