import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("npm package contract", () => {
  it("publishes the scoped package through the docnexus executable with packaged skills", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const cliSource = await readFile("src/cli.ts", "utf8");
    const packagedModel = await stat("models/BAAI/bge-small-zh-v1.5/onnx/model_quantized.onnx");

    expect(packageJson.name).toBe("@docnexus/docnexus");
    expect(packageJson.private).toBe(false);
    expect(packageJson.engines).toEqual({ node: ">=22.13.0" });
    expect(packageJson.bin).toEqual({ docnexus: "./dist/src/cli.js" });
    expect(packageJson.files).toEqual(
      expect.arrayContaining(["dist/src", "models", "skills", "README.md", "README.zh-CN.md", "docPlan.md"])
    );
    expect(packagedModel.size).toBeGreaterThan(1_000_000);
    expect(packageJson.scripts.build).toContain("rmSync('dist'");
    expect(packageJson.scripts.prepack).toBe("npm run build");
    expect(packageJson.scripts["audit:prod"]).toBe("npm audit --omit=dev --audit-level=high");
    expect(packageJson.dependencies["@huggingface/transformers"]).toBe("^3.8.1");
    expect(packageJson.dependencies).not.toHaveProperty("@xenova/transformers");
    expect(cliSource.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("builds an executable CLI entrypoint", async () => {
    const cliStat = await stat("dist/src/cli.js");

    expect(cliStat.mode & 0o111).not.toBe(0);
  });
});
