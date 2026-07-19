import { run } from "@drizzle-team/brocli";
import { cacheCommand } from "./commands/cache";
import { reportCommand } from "./commands/report";
import pkg from "../package.json";

run([reportCommand, cacheCommand], {
    name: "spanical",
    description: pkg.description,
    version: pkg.version,
});
