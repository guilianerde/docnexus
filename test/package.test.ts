import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("npm package contract", () => {
  it("publishes the scoped package through the docnexus executable with packaged skills", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const cliSource = await readFile("src/cli.ts", "utf8");

    expect(packageJson.name).toBe("@docnexus/docnexus");
    expect(packageJson.private).toBe(false);
    expect(packageJson.bin).toEqual({ docnexus: "./dist/src/cli.js" });
    expect(packageJson.files).toEqual(expect.arrayContaining(["dist/src", "skills", "README.md", "README.zh-CN.md"]));
    expect(packageJson.scripts.build).toContain("rmSync('dist'");
    expect(packageJson.scripts.prepack).toBe("npm run build");
    expect(cliSource.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("builds an executable CLI entrypoint", async () => {
    const cliStat = await stat("dist/src/cli.js");

    expect(cliStat.mode & 0o111).not.toBe(0);
  });
});
