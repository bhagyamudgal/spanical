import { command, test as runFlags } from "@drizzle-team/brocli";
import { expect, test } from "bun:test";
import { globalFlags } from "./global-flags";

const probe = command({
    name: "probe",
    options: globalFlags,
    handler: () => {},
});

test("parses --last and --tz into their string values", async () => {
    const result = await runFlags(probe, "--last 30d --tz UTC");
    expect(result.type).toBe("handler");
    if (result.type === "handler") {
        expect(result.options.last).toBe("30d");
        expect(result.options.tz).toBe("UTC");
    }
});

test("parses --this enum and the --ytd boolean flag", async () => {
    const result = await runFlags(probe, "--this quarter --ytd");
    expect(result.type).toBe("handler");
    if (result.type === "handler") {
        expect(result.options.this).toBe("quarter");
        expect(result.options.ytd).toBe(true);
    }
});

test("parses the literal --no-cache flag", async () => {
    const result = await runFlags(probe, "--no-cache");
    expect(result.type).toBe("handler");
    if (result.type === "handler") {
        expect(result.options["no-cache"]).toBe(true);
    }
});

test("rejects a --format value outside the enum", async () => {
    const result = await runFlags(probe, "--format bad");
    expect(result.type).toBe("error");
});

test("parses --by and --format enums together", async () => {
    const result = await runFlags(probe, "--by dev --format json");
    expect(result.type).toBe("handler");
    if (result.type === "handler") {
        expect(result.options.by).toBe("dev");
        expect(result.options.format).toBe("json");
    }
});
