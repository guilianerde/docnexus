const $ = (id) => document.getElementById(id);
const state = { category: "", page: 1, size: 20, revision: "", etag: "", selected: "", snapshot: null, busy: false };
const statuses = { active: "有效", scheduled: "待生效", expired: "已到期", superseded: "已替代", withdrawn: "已撤回" };
let requestNumber = 0;
let controller;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function date(value, full = false) {
  return new Date(value).toLocaleString("zh-CN", full ? { dateStyle: "medium", timeStyle: "short" } : { month: "2-digit", day: "2-digit" });
}
function setBusy(busy) {
  state.busy = busy;
  $("refresh").disabled = busy;
  $("documents").setAttribute("aria-busy", String(busy));
  $("previous").disabled = busy || state.page <= 1;
  $("next").disabled = busy || !state.snapshot?.pagination?.has_more;
}

async function load({ reset = false, poll = false } = {}) {
  if (poll && state.busy) return;
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  const number = ++requestNumber;
  if (reset) { state.page = 1; state.revision = ""; }
  setBusy(true);
  if (!poll) $("sync-status").textContent = "正在读取…";
  let changed = false;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const params = new URLSearchParams({ page: String(state.page), page_size: String(state.size) });
      if (state.category) params.set("category", state.category);
      if (state.revision) params.set("revision", state.revision);
      const headers = poll && state.snapshot && state.etag ? { "If-None-Match": state.etag } : {};
      const response = await fetch(`/api/documents?${params}`, { signal, headers, cache: "no-store" });
      if (number !== requestNumber) return;
      if (response.status === 304) {
        $("error").hidden = true;
        $("sync-status").textContent = `已同步 ${date(new Date().toISOString(), true)}`;
        return;
      }
      const output = await response.json();
      if (number !== requestNumber) return;
      if (response.status === 409 && output.error === "document_revision_changed") {
        state.page = 1;
        state.revision = "";
        state.snapshot = null;
        $("documents").replaceChildren(element("p", "empty", "文档已更新，正在重新读取…"));
        $("detail").replaceChildren();
        changed = true;
        continue;
      }
      if (!response.ok) throw new Error(output.message || "暂时无法读取文档，请点击刷新重试。");
      // A model may merge, rename or remove the selected category.
      if (state.category && !output.categories.some((category) => category.id === state.category)) {
        state.category = "";
        state.page = 1;
        state.revision = output.revision;
        changed = true;
        continue;
      }
      const needsRender = !poll || output.revision !== state.snapshot?.revision || changed;
      state.snapshot = output;
      state.revision = output.revision;
      state.etag = response.headers.get("etag") || "";
      $("error").hidden = true;
      if (needsRender) render();
      $("sync-status").textContent = changed ? "知识已更新 · 已回到第一页" : `已同步 ${date(output.generated_at, true)}`;
      return;
    }
    throw new Error("文档正在连续更新，请稍后点击刷新重试。");
  } catch (error) {
    if (error.name === "AbortError" || number !== requestNumber) return;
    // Never leave a stale page looking current after a failed consistency check.
    state.snapshot = null;
    $("documents").replaceChildren(element("p", "empty", "读取失败，点击右上角刷新重试。"));
    $("detail").replaceChildren();
    $("error").textContent = `读取失败。请检查项目文档后点击刷新重试。\n${error.message}`;
    $("error").hidden = false;
    $("sync-status").textContent = "同步失败";
  } finally {
    if (number === requestNumber) setBusy(false);
  }
}

function render() {
  const snapshot = state.snapshot;
  const project = snapshot.project_root.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || "项目文档";
  $("project-name").textContent = project;
  $("project-path").textContent = snapshot.project_root;
  document.title = `${project} · DocNexus`;
  $("categories").replaceChildren();
  for (const category of [{ id: "", label: "全部文档", count: snapshot.total_documents }, ...snapshot.categories]) {
    const button = element("button", "category");
    button.setAttribute("aria-current", String(category.id === state.category));
    button.append(element("span", "label", category.label), element("span", "count", String(category.count)));
    button.onclick = () => { state.category = category.id; load({ reset: true }); };
    $("categories").append(button);
  }
  $("list-title").textContent = snapshot.categories.find((category) => category.id === state.category)?.label || "全部文档";
  $("document-count").textContent = String(snapshot.total);
  const start = snapshot.documents.length ? (state.page - 1) * state.size + 1 : 0;
  $("list-position").textContent = `${start}–${start ? start + snapshot.documents.length - 1 : 0} / ${snapshot.total}`;
  $("page-label").textContent = snapshot.total ? `${state.page} / ${snapshot.pagination.total_pages}` : "0 / 0";
  if (!snapshot.documents.some((document) => document.id === state.selected)) state.selected = snapshot.documents[0]?.id || "";
  renderList();
  renderDetail();
}

function renderList() {
  $("documents").replaceChildren();
  if (!state.snapshot.documents.length) {
    $("documents").append(element("p", "empty", state.snapshot.total_documents ? "此分类暂无文档。" : "项目还没有文档。保存第一份知识后会自动出现在这里。"));
  }
  for (const document of state.snapshot.documents) {
    const button = element("button", "document-card");
    button.setAttribute("aria-pressed", String(document.id === state.selected));
    const top = element("span", "card-top");
    top.append(element("span", "badge", document.category_label), element("span", "card-date", date(document.updated_at)));
    button.append(top, element("span", "card-title", document.title), element("span", "card-summary", document.summary));
    button.onclick = () => {
      state.selected = document.id;
      renderList(); renderDetail();
      if (window.matchMedia("(max-width: 600px)").matches) $("reader").scrollIntoView({ block: "start" });
      $("reader").focus({ preventScroll: true });
    };
    $("documents").append(button);
  }
}

function renderDetail() {
  const doc = state.snapshot.documents.find((item) => item.id === state.selected);
  $("detail").replaceChildren();
  $("document-path").textContent = doc?.library_path || "文档阅读";
  if (!doc) {
    const empty = element("div", "reader-empty");
    empty.append(element("span", "eyebrow", "YOUR PROJECT, IN CONTEXT"), element("h2", "", "等待第一份项目知识"), element("p", "", "通过 DocNexus 保存文档后，即可在这里按分类阅读。"));
    $("detail").append(empty);
    return;
  }
  const article = element("article", "document-detail");
  article.append(element("span", "badge", doc.category_label), element("h1", "", doc.title), element("p", "document-summary", doc.summary));
  const meta = element("div", "document-meta");
  meta.append(element("span", "", `更新于 ${date(doc.updated_at, true)}`));
  for (const tag of doc.tags) meta.append(element("span", "tag", tag));
  article.append(meta);
  const classification = element("div", "classification");
  classification.append(element("strong", "", "分类依据"), element("p", "", doc.category_reason || "尚未记录分类依据。"));
  article.append(classification);
  const body = element("div", "markdown");
  // Only this server-generated, HTML-disabled Markdown rendering uses innerHTML.
  body.innerHTML = doc.html;
  const heading = body.firstElementChild;
  if (heading?.tagName === "H1" && heading.textContent.trim() === doc.title.trim()) heading.remove();
  article.append(body);
  if (doc.facts.length) {
    const facts = element("details", "facts");
    facts.append(element("summary", "", `事实与来源 · ${doc.facts.length} 条`));
    for (const fact of doc.facts) {
      const item = element("div", "fact");
      item.append(element("span", "badge", statuses[fact.status] || fact.status), element("p", "", fact.text));
      item.append(element("p", "provenance", `来源：${fact.provenance}\n所属文档：${fact.source_path}\n生效：${date(fact.valid_from, true)}${fact.valid_until ? `\n到期：${date(fact.valid_until, true)}` : ""}${fact.withdrawn_at ? `\n撤回：${date(fact.withdrawn_at, true)}${fact.withdrawal_reason ? ` · ${fact.withdrawal_reason}` : ""}` : ""}${fact.replaced_by ? `\n替代事实：${fact.replaced_by}` : ""}`));
      item.append(element("span", "fact-id", fact.id));
      facts.append(item);
    }
    article.append(facts);
  }
  $("detail").append(article);
}

$("refresh").onclick = () => load();
$("previous").onclick = () => { state.page--; load(); };
$("next").onclick = () => { state.page++; load(); };
$("page-size").onchange = () => { state.size = Number($("page-size").value); load({ reset: true }); };
document.addEventListener("visibilitychange", () => { if (!document.hidden) load({ poll: true }); });
setInterval(() => { if (!document.hidden) load({ poll: true }); }, 15000);
load();
