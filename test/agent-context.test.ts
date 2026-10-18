import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasAgentContext, installAgentContext, removeAgentContext } from "../src/agent-context.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docnexus-context-"));
  roots.push(root);
  return root;
}

describe("agent context", () => {
  it("adds one idempotent block that loads the short category map and removes it cleanly", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "CLAUDE.md"), "# Project\n\nExisting rules.\n");

    await expect(installAgentContext(root, "claude")).resolves.toBe("CLAUDE.md");
    await installAgentContext(root, "claude");
    const claude = await readFile(join(root, "CLAUDE.md"), "utf8");
    expect(claude.startsWith("# Project\n\nExisting rules.\n\n<!-- docnexus:start -->")).toBe(true);
    expect(claude.match(/docnexus:start/g)).toHaveLength(1);
    expect(claude).toContain("@docnexus/CONCEPTS.md");
    expect(claude).toContain("`docnexus-recall` skill on your own");
    expect(claude).toContain("A topic missing from the map is not a reason to skip.");
    expect(claude).toContain("`docnexus/concepts/`");

    await installAgentContext(root, "codex");
    await expect(readFile(join(root, "AGENTS.md"), "utf8")).resolves.toContain("a short map; read it when useful");
    await expect(hasAgentContext(root, "codex")).resolves.toBe(true);

    await expect(removeAgentContext(root)).resolves.toEqual(["CLAUDE.md", "AGENTS.md"]);
    await expect(readFile(join(root, "CLAUDE.md"), "utf8")).resolves.toBe("# Project\n\nExisting rules.\n");
    await expect(readFile(join(root, "AGENTS.md"), "utf8")).rejects.toThrow();
  });
});
