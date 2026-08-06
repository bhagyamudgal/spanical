import { runTickets } from "../pipeline/commands";
import { createInsightCommand } from "./insight-command";

export const ticketsCommand = createInsightCommand({
    name: "tickets",
    desc: "Show per-dev pull request and issue flow, cycle time and thrash (GitHub)",
    run: runTickets,
    unsupported: {
        name: "period",
        message:
            "--period is not supported by tickets: counts, cycle time and thrash are reported once for the whole window, never split by period. Drop --period, or narrow the window with --since and --until.",
    },
});
