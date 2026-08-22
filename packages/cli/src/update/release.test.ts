import { expect, test } from "bun:test";
import { getAssetName } from "./release";

test("getAssetName maps supported platforms and rejects the rest", () => {
    expect(getAssetName("darwin", "arm64")).toBe("spanical-darwin-arm64");
    expect(getAssetName("darwin", "x64")).toBe("spanical-darwin-x64");
    expect(getAssetName("linux", "arm64")).toBe("spanical-linux-arm64");
    expect(getAssetName("linux", "x64")).toBe("spanical-linux-x64");
    expect(getAssetName("win32", "x64")).toBeNull();
    expect(getAssetName("linux", "riscv64")).toBeNull();
});
