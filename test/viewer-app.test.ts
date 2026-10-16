import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { expect, it, vi } from "vitest";

it("loads on demand without automatic refresh and recovers after a failed manual refresh", async () => {
  const node = () => ({ replaceChildren: vi.fn(), append: vi.fn(), setAttribute: vi.fn(), textContent: "", hidden: false });
  const nodes = new Map<string, ReturnType<typeof node>>();
  const document = {
    getElementById: (id: string) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    createElement: node, addEventListener: vi.fn()
  };
  const snapshot = { project_root: "/project", revision: "revision", generated_at: "2026-01-01T00:00:00Z", categories: [], documents: [], total: 0, total_documents: 0,
    pagination: { has_more: false, total_pages: 0 } };
  const full = () => ({ status: 200, ok: true, json: async () => snapshot });
  const fetch = vi.fn().mockResolvedValueOnce(full())
    .mockResolvedValueOnce({ status: 503, ok: false, json: async () => ({ message: "Invalid text" }) }).mockResolvedValueOnce(full());
  const setInterval = vi.fn();
  const context = createContext({ document, fetch, AbortController, URLSearchParams, Date, setInterval });
  await runInContext(await readFile(new URL("../viewer/app.js", import.meta.url), "utf8"), context);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(setInterval).not.toHaveBeenCalled();
  expect(document.addEventListener).not.toHaveBeenCalled();
  expect(runInContext("state.snapshot.revision", context)).toBe(snapshot.revision);
  await runInContext('$("refresh").onclick()', context);
  expect(runInContext("state.snapshot", context)).toBeNull();
  expect(nodes.get("error")!.hidden).toBe(false);
  await runInContext('$("refresh").onclick()', context);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(runInContext("state.snapshot.revision", context)).toBe(snapshot.revision);
  expect(nodes.get("error")!.hidden).toBe(true);
});
