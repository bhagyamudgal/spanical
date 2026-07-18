import { run } from "@drizzle-team/brocli";
import { reportCommand } from "./commands/report";
import pkg from "../package.json";

run([reportCommand], {
    name: "spanical",
    description: pkg.description,
    version: pkg.version,
});
