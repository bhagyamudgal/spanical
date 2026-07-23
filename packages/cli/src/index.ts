import { run } from "@drizzle-team/brocli";
import { cacheCommand } from "./commands/cache";
import { churnCommand } from "./commands/churn";
import { contributorsCommand } from "./commands/contributors";
import { hotspotsCommand } from "./commands/hotspots";
import { ownershipCommand } from "./commands/ownership";
import { reportCommand } from "./commands/report";
import { sizeCommand } from "./commands/size";
import pkg from "../package.json";

run(
    [
        reportCommand,
        churnCommand,
        contributorsCommand,
        sizeCommand,
        ownershipCommand,
        hotspotsCommand,
        cacheCommand,
    ],
    {
        name: "spanical",
        description: pkg.description,
        version: pkg.version,
    }
);
