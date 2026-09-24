import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("npm package contract", () => {
  it("publishes the scoped package through the docnexus executable with packaged skills", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const cliSource = await readFile("src/cli.ts", "utf8");
    const packagedModel = await stat("models/BAAI/bge-small-zh-v1.5/onnx/model_quantized.onnx");

    expect(packageJson.name).toBe("@rowansenne/docnexus");
    expect(packageJson.version).toBe("0.3.0");
    expect(packageJson.private).toBe(false);
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/guilianerde/docnexus.git"
    });
    expect(packageJson.bugs).toEqual({ url: "https://github.com/guilianerde/docnexus/issues" });
    expect(packageJson.engines).toEqual({ node: ">=22.13.0" });
    expect(packageJson.bin).toEqual({ docnexus: "dist/src/cli.js" });
    expect(packageJson.publishConfig).toEqual({ access: "public" });
    expect(packageJson.files).toEqual(
      expect.arrayContaining([
        "dist/src",
        "models",
        "skills",
        "README.md",
        "README.zh-CN.md",
        "CHANGELOG.md",
        "LICENSE",
        "SECURITY.md",
        "docs"
      ])
    );
    expect(packagedModel.size).toBeGreaterThan(1_000_000);
    expect(packageJson.scripts.build).toContain("rmSync('dist'");
    expect(packageJson.scripts.prepack).toBe("npm run build");
    expect(packageJson.scripts["audit:prod"]).toBe("npm audit --omit=dev --audit-level=high");
    expect(packageJson.dependencies["@huggingface/transformers"]).toBe("^3.8.1");
    expect(packageJson.dependencies).not.toHaveProperty("@xenova/transformers");
    expect(cliSource.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("configures the built CLI entrypoint as executable", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));

    expect(packageJson.scripts.build).toContain("chmodSync('dist/src/cli.js', 0o755)");
  });
});
