import { runTickets } from "../pipeline/commands";
import { createInsightCommand } from "./insight-command";

export const ticketsCommand = createInsightCommand({
    name: "tickets",
    desc: "Show per-dev pull request and issue flow, cycle time and thrash (GitHub)",
    run: runTickets,
});
