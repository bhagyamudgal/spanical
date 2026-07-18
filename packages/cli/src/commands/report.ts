import { command } from "@drizzle-team/brocli";

export const reportCommand = command({
    name: "report",
    desc: "Generate an engineering insights report (not yet implemented)",
    handler: () => {
        console.log("not yet implemented");
    },
});
