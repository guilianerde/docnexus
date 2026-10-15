import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import MarkdownIt from "markdown-it";
import { initializeProject } from "../src/project.js";
import { classifyManagedDocument, upsertManagedDocument } from "../src/managed-documents.js";
import { renderViewerMarkdown, startDocumentViewer, type DocumentViewer } from "../src/viewer.js";
import { runMain } from "../src/cli.js";
import { type DocumentQueryOutput } from "../src/document-query.js";

const roots: string[] = [];
const viewers: DocumentViewer[] = [];
async function snapshot(url: string): Promise<DocumentQueryOutput & { documents: Array<DocumentQueryOutput["documents"][number] & { html: string }> }> {
  return await (await fetch(url)).json() as Awaited<ReturnType<typeof snapshot>>;
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "docnexus-viewer-"));
  roots.push(root);
  await initializeProject(root);
  const viewer = await startDocumentViewer(root);
  viewers.push(viewer);
  return { root, viewer };
}
afterEach(async () => {
  await Promise.all(viewers.splice(0).map((viewer) => viewer.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function add(root: string, file = "policy.md") {
  return upsertManagedDocument(root, {
    file_path: file, source: "User decision", document: "# Policy\n\n{{fact:fact_viewer_policy}}\n",
    metadata: { title: "Policy", summary: "Current policy", category: "项目约定", category_reason: "项目已有约定类文档", tags: ["policy"], entities: [], relationships: [], facts: [{ id: "fact_viewer_policy", text: "Review changes", provenance: "Project owner", valid_from: "2020-01-01T00:00:00Z" }] }
  });
}

describe("read-only document viewer", () => {
  it("ships local assets and serves full or paginated canonical content without mutating text", async () => {
    const { root, viewer } = await setup();
    const record = await add(root);
    const bodyPath = join(root, "docnexus/library/policy.md");
    const before = await readFile(bodyPath, "utf8");
    for (const [path, type] of [["/", "text/html"], ["/app.js", "text/javascript"], ["/style.css", "text/css"]]) {
      const response = await fetch(viewer.url + path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(type);
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toBe("");
    }
    const output = await snapshot(`${viewer.url}/api/documents?page=1&page_size=1`);
    expect(output.documents[0]).toMatchObject({ id: record.id, category: "项目约定", category_reason: "项目已有约定类文档", html: expect.stringContaining("Review changes") });
    expect(output.documents[0].html).not.toContain("docnexus:fact");
    expect(output.documents[0].facts[0]).toMatchObject({ status: "active", provenance: "Project owner" });
    expect((await snapshot(`${viewer.url}/api/documents?all=true&revision=${output.revision}`)).pagination).toBeNull();
    expect(await readFile(bodyPath, "utf8")).toBe(before);
    expect((await snapshot(`${viewer.url}/api/documents?category=其他分类`)).documents).toEqual([]);
  });

  it("allows concurrent writes and returns 409 when classification changes a page snapshot", async () => {
    const { root, viewer } = await setup();
    const record = await add(root);
    const before = await snapshot(`${viewer.url}/api/documents`);
    await classifyManagedDocument(root, { id: record.id, category: "团队决策", reason: "结合项目决策目录调整分类" });
    const response = await fetch(`${viewer.url}/api/documents?page=2&revision=${before.revision}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "document_revision_changed", current_revision: expect.any(String) });
    const after = await snapshot(`${viewer.url}/api/documents`);
    expect(after.categories).toEqual([{ id: "团队决策", label: "团队决策", count: 1 }]);
    expect(after.documents[0].category_reason).toBe("结合项目决策目录调整分类");
  });

  it("returns an empty 304 without rendering HTML only for the same validated page and category", async () => {
    const { root, viewer } = await setup();
    const record = await add(root);
    const url = `${viewer.url}/api/documents?page=1&page_size=1`;
    const first = await fetch(url);
    const before = await first.json() as DocumentQueryOutput;
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const render = vi.spyOn(MarkdownIt.prototype, "render");
    const headers = { "If-None-Match": etag! };
    const unchanged = await fetch(`${url}&revision=${before.revision}`, { headers });
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("etag")).toBe(etag);
    expect(await unchanged.text()).toBe("");
    expect(render).not.toHaveBeenCalled();
    for (const suffix of ["page=2&page_size=1", "page=1&page_size=20", "page=1&page_size=1&category=项目约定"]) {
      const changedView = await fetch(`${viewer.url}/api/documents?${suffix}`, { headers });
      expect(changedView.status).toBe(200);
      expect(changedView.headers.get("etag")).not.toBe(etag);
    }
    await classifyManagedDocument(root, { id: record.id, category: "团队决策", reason: "Updated category" });
    expect((await fetch(`${url}&revision=${before.revision}`, { headers })).status).toBe(409);
    const changed = await fetch(url, { headers });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    const currentHeaders = { "If-None-Match": changed.headers.get("etag")! };
    await writeFile(join(root, "docnexus/library/policy.md"), "Unadopted edit");
    expect((await fetch(url, { headers: currentHeaders })).status).toBe(503);
  });

  it("invalidates conditional responses when a fact expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const { root, viewer } = await setup();
      await upsertManagedDocument(root, { file_path: "expiry.md", source: "Decision", document: "{{fact:fact_expiry}}", metadata: {
        title: "Expiry", summary: "Temporary policy", tags: [], entities: [], relationships: [], facts: [{ id: "fact_expiry", text: "Temporary assertion", provenance: "Owner", valid_from: "2020-01-01T00:00:00Z", valid_until: "2026-01-02T00:00:00Z" }]
      } });
      const first = await fetch(`${viewer.url}/api/documents`);
      const before = await first.json() as DocumentQueryOutput;
      const headers = { "If-None-Match": first.headers.get("etag")! };
      expect((await fetch(`${viewer.url}/api/documents?revision=${before.revision}`, { headers })).status).toBe(304);
      vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
      expect((await fetch(`${viewer.url}/api/documents?revision=${before.revision}`, { headers })).status).toBe(409);
      const after = await fetch(`${viewer.url}/api/documents`, { headers });
      expect(after.status).toBe(200);
      expect((await after.json() as DocumentQueryOutput).documents[0].facts[0].status).toBe("expired");
    } finally { vi.useRealTimers(); }
  });

  it("rejects writes, foreign origins, DNS rebinding, arbitrary files and malformed query options", async () => {
    const { viewer } = await setup();
    expect((await fetch(`${viewer.url}/api/documents`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${viewer.url}/api/documents`, { headers: { Origin: "https://example.com" } })).status).toBe(403);
    expect((await fetch(`${viewer.url}/api/documents`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect(await new Promise<number>((accept, reject) => {
      const req = request(viewer.url + "/api/documents", { headers: { Host: "attacker.example" } }, (response) => { response.resume(); accept(response.statusCode!); });
      req.on("error", reject); req.end();
    })).toBe(403);
    for (const path of ["/project.json", "/api/documents/policy.md", "/api/document/delete"]) expect((await fetch(viewer.url + path)).status).toBe(404);
    for (const query of ["page=0", "page_size=101", "all=false", "all=true&page=1", "revision=bad", "project_root=/tmp", "page=1&page=2", "category=%20"]) {
      expect((await fetch(`${viewer.url}/api/documents?${query}`)).status).toBe(400);
    }
    expect((await fetch(viewer.url, { method: "HEAD" })).status).toBe(200);
  });

  it("reports empty projects, corrupt source and uninitialized roots explicitly", async () => {
    const { root, viewer } = await setup();
    expect((await snapshot(`${viewer.url}/api/documents`)).total).toBe(0);
    await add(root);
    await writeFile(join(root, "docnexus/library/policy.md"), "Unadopted edit");
    expect((await fetch(`${viewer.url}/api/documents`)).status).toBe(503);
    await expect(startDocumentViewer(root, -1)).rejects.toThrow("--port");
    const empty = await mkdtemp(join(tmpdir(), "docnexus-viewer-empty-")); roots.push(empty);
    await expect(startDocumentViewer(empty)).rejects.toThrow("not initialized");
    await expect(runMain(["view", "--host", "0.0.0.0"], root)).rejects.toThrow("Usage");
    await expect(runMain(["view", "--port", "bad"], root)).rejects.toThrow("Usage");
  });

  it("renders Markdown tables and code while disabling HTML, unsafe URLs and image fetches", () => {
    const html = renderViewerMarkdown('# Heading\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1)) ![image](https://example.com/a.png) [file](file:///secret) [local](../other.md) [web](https://example.com)\n\n| A | B |\n|---|---|\n| one | two |\n\n```js\nconsole.log("hello")\n```');
    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("<table>");
    expect(html).toContain('<code class="language-js">');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/<script|<img|href="(?:javascript:|file:|\.\.)/);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('<span class="local-link">local</span>');
    expect(renderViewerMarkdown('```html\n<!-- docnexus:fact fact_example -->\n```')).toContain('&lt;!-- docnexus:fact fact_example --&gt;');
  });
});
