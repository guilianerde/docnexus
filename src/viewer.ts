import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import { DocumentRevisionChangedError, queryDocuments, type DocumentQueryInput } from "./document-query.js";
import { requireInitializedProject } from "./project.js";
import { isDocumentCategory } from "./types.js";

const markdown = new MarkdownIt({ html: false, linkify: false });
markdown.core.ruler.before("inline", "viewer-fact-markers", (state) => {
  for (const token of state.tokens) {
    // Keep literal examples inside code blocks unchanged.
    if (token.type === "inline") token.content = token.content.replace(/^[ \t]*<!-- (?:docnexus:fact fact_[A-Za-z0-9_-]+|\/docnexus:fact) -->[ \t]*\r?$/gm, "");
  }
});
// Never load document images, or turn local/file/script URLs into browser navigation.
markdown.renderer.rules.image = (tokens, index) => `<span class="image-note">[图片：${markdown.utils.escapeHtml(tokens[index].content)}]</span>`;
markdown.core.ruler.push("viewer-links", (state) => {
  for (const block of state.tokens) {
    const tokens = block.children ?? [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.type !== "link_open") continue;
      if (/^https?:\/\//i.test(String(token.attrGet("href") ?? ""))) {
        token.attrSet("target", "_blank");
        token.attrSet("rel", "noopener noreferrer");
      } else {
        token.tag = "span";
        token.attrs = [["class", "local-link"]];
        const close = tokens.slice(index + 1).find((item) => item.type === "link_close");
        if (close) close.tag = "span";
      }
    }
  }
});

export function renderViewerMarkdown(document: string): string {
  return markdown.render(document);
}

export interface DocumentViewer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

/** One fixed project per server. Each query acquires its own short-lived project lock. */
export async function startDocumentViewer(projectRoot: string, port = 0): Promise<DocumentViewer> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer between 0 and 65535");
  const root = await requireInitializedProject(projectRoot);
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const compiledAssets = resolve(moduleDirectory, "../../viewer");
  const assets = existsSync(resolve(compiledAssets, "index.html")) ? compiledAssets : resolve(moduleDirectory, "../viewer");
  const routes = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["/style.css", ["style.css", "text/css; charset=utf-8"]]
  ]);
  // Load once, fail at startup if the installed package is incomplete.
  const files = new Map(await Promise.all([...routes].map(async ([path, [file, type]]) => [path, { body: await readFile(resolve(assets, file)), type }] as const)));
  let origin = "";
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : JSON.stringify(value));
    };
    if (request.headers.host !== new URL(origin).host ||
        (request.headers.origin !== undefined && request.headers.origin !== origin) ||
        (request.headers["sec-fetch-site"] !== undefined && !["same-origin", "none"].includes(String(request.headers["sec-fetch-site"])))) {
      json(403, { error: "local_access_only", message: "Open the viewer using its printed local URL." });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      json(405, { error: "read_only", message: "The document viewer is read-only." });
      return;
    }
    let url: URL;
    try { url = new URL(request.url ?? "/", origin); }
    catch { json(400, { error: "invalid_url" }); return; }
    const file = files.get(url.pathname);
    if (file) {
      response.writeHead(200, { "Content-Type": file.type });
      response.end(request.method === "HEAD" ? undefined : file.body);
      return;
    }
    if (url.pathname !== "/api/documents") {
      json(404, { error: "not_found" });
      return;
    }
    let input: DocumentQueryInput;
    try {
      input = parseViewerQuery(url.searchParams);
    } catch (error) {
      json(400, { error: "invalid_query", message: (error as Error).message });
      return;
    }
    try {
      const snapshot = await queryDocuments(root, input);
      json(200, { ...snapshot, documents: snapshot.documents.map((document) => ({ ...document, html: renderViewerMarkdown(document.document) })) });
    } catch (error) {
      if (error instanceof DocumentRevisionChangedError) {
        json(409, { error: error.code, current_revision: error.current_revision });
      } else {
        json(503, { error: "documents_unavailable", message: (error as Error).message });
      }
    }
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); accept(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Viewer did not bind to a local port");
  origin = `http://127.0.0.1:${address.port}`;
  return { server, url: origin, close: () => new Promise((accept, reject) => {
    server.close((error) => error ? reject(error) : accept());
    server.closeIdleConnections();
  }) };
}

function parseViewerQuery(params: URLSearchParams): DocumentQueryInput {
  for (const key of params.keys()) {
    if (!["all", "page", "page_size", "category", "revision"].includes(key) || params.getAll(key).length !== 1) throw new Error(`Invalid or repeated query parameter: ${key}`);
  }
  const input: DocumentQueryInput = {};
  if (params.has("all")) {
    if (params.get("all") !== "true") throw new Error("all must be true");
    input.all = true;
  }
  for (const key of ["page", "page_size"] as const) {
    if (!params.has(key)) continue;
    const value = Number(params.get(key));
    if (!Number.isSafeInteger(value) || value < 1 || (key === "page_size" && value > 100)) throw new Error(`Invalid ${key}`);
    input[key] = value;
  }
  if (input.all && (input.page !== undefined || input.page_size !== undefined)) throw new Error("all cannot be combined with pagination");
  if (!Number.isSafeInteger(((input.page ?? 1) - 1) * (input.page_size ?? 20))) throw new Error("page offset is too large");
  if (params.has("category")) {
    const value = params.get("category")!;
    if (!isDocumentCategory(value)) throw new Error("Invalid category");
    input.category = value;
  }
  if (params.has("revision")) {
    const value = params.get("revision")!;
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid revision");
    input.revision = value;
  }
  return input;
}
