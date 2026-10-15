import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { expect, it, vi } from "vitest";

it("keeps the rendered page on 304 and requests full content after a failed poll", async () => {
  const node = () => ({ replaceChildren: vi.fn(), append: vi.fn(), setAttribute: vi.fn(), textContent: "", hidden: false });
  const nodes = new Map<string, ReturnType<typeof node>>();
  const document = {
    getElementById: (id: string) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    createElement: node, addEventListener: vi.fn()
  };
  const snapshot = { project_root: "/project", revision: "revision", generated_at: "2026-01-01T00:00:00Z", categories: [], documents: [], total: 0, total_documents: 0,
    pagination: { has_more: false, total_pages: 0 } };
  const full = () => ({ status: 200, ok: true, headers: new Headers({ ETag: 'W/"page"' }), json: async () => snapshot });
  const emptyJson = vi.fn(async () => { throw new Error("304 has no JSON body"); });
  const fetch = vi.fn().mockResolvedValueOnce(full()).mockResolvedValueOnce({ status: 304, json: emptyJson })
    .mockResolvedValueOnce({ status: 503, ok: false, json: async () => ({ message: "Invalid text" }) }).mockResolvedValueOnce(full());
  const context = createContext({ document, fetch, AbortController, URLSearchParams, Date, setInterval: vi.fn() });
  await runInContext(await readFile(new URL("../viewer/app.js", import.meta.url), "utf8"), context);
  const detail = nodes.get("detail")!.replaceChildren;
  detail.mockClear();
  await runInContext("load({ poll: true })", context);
  expect(fetch.mock.calls[1][1].headers).toEqual({ "If-None-Match": 'W/"page"' });
  expect(emptyJson).not.toHaveBeenCalled();
  expect(detail).not.toHaveBeenCalled();
  expect(runInContext("state.snapshot.revision", context)).toBe(snapshot.revision);
  await runInContext("load({ poll: true })", context);
  expect(runInContext("state.snapshot", context)).toBeNull();
  expect(nodes.get("error")!.hidden).toBe(false);
  await runInContext("load({ poll: true })", context);
  expect(fetch.mock.calls[3][1].headers).toEqual({});
  expect(runInContext("state.snapshot.revision", context)).toBe(snapshot.revision);
  expect(nodes.get("error")!.hidden).toBe(true);
});
