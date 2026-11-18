const $ = (id) => document.getElementById(id);
const state = { category: "", query: "", page: 1, size: 20, revision: "", selected: "", snapshot: null };
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
  $("refresh").disabled = busy;
  $("documents").setAttribute("aria-busy", String(busy));
  $("detail").setAttribute("aria-busy", String(busy));
  $("previous").disabled = busy || state.page <= 1;
  $("next").disabled = busy || !state.snapshot?.pagination?.has_more;
}

async function load({ reset = false } = {}) {
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  const number = ++requestNumber;
  if (reset) { state.page = 1; state.revision = ""; }
  setBusy(true);
  $("sync-status").textContent = "正在读取…";
  let changed = false;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const params = new URLSearchParams({ page: String(state.page), page_size: String(state.size) });
      if (state.category) params.set("category", state.category);
      if (state.query) params.set("q", state.query);
      if (state.revision) params.set("revision", state.revision);
      const response = await fetch(`/api/documents?${params}`, { signal, cache: "no-store" });
      if (number !== requestNumber) return;
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
      state.snapshot = output;
      state.revision = output.revision;
      $("error").hidden = true;
      render();
      $("sync-status").textContent = changed ? "知识已更新 · 已回到第一页" : `已同步 ${date(output.generated_at, true)}`;
      return;
    }
    throw new Error("文档正在连续更新，请稍后点击刷新重试。");
  } catch (error) {
    if (error.name === "AbortError" || number !== requestNumber) return;
    // Never leave a stale page looking current after a failed consistency check.
    state.snapshot = null;
    $("document-count").textContent = "—";
    $("list-position").textContent = "";
    $("page-label").textContent = "—";
    $("search-result").textContent = "";
    $("document-path").textContent = "文档阅读";
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
  $("project-path").title = snapshot.project_root;
  document.title = `${project} · DocNexus`;
  const focusedCategory = document.activeElement?.closest("#categories button")?.value;
  $("categories").replaceChildren();
  for (const category of [{ id: "", label: "全部文档", count: snapshot.total_documents }, ...snapshot.categories]) {
    const button = element("button", "category");
    button.type = "button";
    button.value = category.id;
    button.setAttribute("aria-current", String(category.id === state.category));
    const row = element("span", "category-row");
    row.append(element("span", "label", category.label), element("span", "count", String(category.count)));
    button.append(row);
    if (category.id) {
      const share = element("meter", "category-share");
      share.max = snapshot.total_documents;
      share.value = category.count;
      share.setAttribute("aria-hidden", "true");
      button.append(share);
    }
    button.onclick = () => { state.category = category.id; return load({ reset: true }); };
    $("categories").append(button);
    if (category.id === focusedCategory) button.focus({ preventScroll: true });
  }
  $("list-title").textContent = snapshot.categories.find((category) => category.id === state.category)?.label || "全部文档";
  $("document-count").textContent = String(snapshot.total);
  $("search-result").textContent = state.query ? `找到 ${snapshot.total} 篇文档` : "";
  const start = snapshot.documents.length ? (state.page - 1) * state.size + 1 : 0;
  $("list-position").textContent = `${start}–${start ? start + snapshot.documents.length - 1 : 0} / ${snapshot.total}`;
  $("page-label").textContent = snapshot.total ? `${state.page} / ${snapshot.pagination.total_pages}` : "0 / 0";
  if (!snapshot.documents.some((document) => document.id === state.selected)) {
    state.selected = snapshot.documents[0]?.id || "";
    $("reader").scrollTop = 0;
  }
  renderList();
  renderDetail();
}

function renderList() {
  $("documents").replaceChildren();
  if (!state.snapshot.documents.length) {
    $("documents").append(element("p", "empty", state.query ? "没有匹配的文档。试试其他关键词，或切换到全部文档。" :
      state.snapshot.total_documents ? "此分类暂无文档。" : "项目还没有文档。保存文档后，点击刷新查看。"));
  }
  let selectedButton;
  for (const document of state.snapshot.documents) {
    const button = element("button", "document-card");
    button.type = "button";
    button.setAttribute("aria-pressed", String(document.id === state.selected));
    if (document.id === state.selected) selectedButton = button;
    const top = element("span", "card-top");
    top.append(element("span", "badge", document.category_label), element("span", "card-date", date(document.updated_at)));
    button.append(top, element("span", "card-title", document.title), element("span", "card-summary", document.summary));
    button.onclick = () => {
      state.selected = document.id;
      selectedButton?.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-pressed", "true");
      selectedButton = button;
      renderDetail();
      $("reader").scrollTop = 0;
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
    empty.append(element("h2", "", state.query ? "没有匹配的文档" : "暂无文档可读"));
    $("detail").append(empty);
    return;
  }
  const article = element("article", "document-detail");
  article.append(element("span", "badge", doc.category_label), element("h1", "", doc.title), element("p", "document-summary", doc.summary));
  const meta = element("div", "document-meta");
  meta.append(element("span", "", `更新于 ${date(doc.updated_at, true)}`));
  for (const tag of doc.tags) meta.append(element("span", "tag", tag));
  article.append(meta);
  if (doc.category_reason) {
    const classification = element("details", "classification");
    classification.open = true;
    classification.append(element("summary", "", "分类依据"), element("p", "", doc.category_reason));
    article.append(classification);
  }
  const body = element("div", "markdown");
  // Only this server-generated, HTML-disabled Markdown rendering uses innerHTML.
  body.innerHTML = doc.html;
  const heading = body.firstElementChild;
  if (heading?.tagName === "H1" && heading.textContent.trim() === doc.title.trim()) heading.remove();
  const headings = [...body.querySelectorAll("h1, h2, h3, h4, h5, h6")].filter((item) => item.textContent.trim());
  if (headings.length) {
    const outline = element("details", "outline");
    outline.append(element("summary", "", "正文目录"));
    outline.open = headings.length <= 6;
    const links = element("nav", "outline-links");
    links.setAttribute("aria-label", "正文目录");
    const firstLevel = Math.min(...headings.map((item) => Number(item.tagName[1])));
    headings.forEach((item, index) => {
      item.id = `section-${index + 1}`;
      item.tabIndex = -1;
      const level = Math.min(Number(item.tagName[1]) - firstLevel, 2);
      const link = element("a", `outline-level-${level}`, item.textContent.trim());
      link.href = `#${item.id}`;
      link.onclick = (event) => {
        event.preventDefault();
        item.scrollIntoView({ block: "start" });
        item.focus({ preventScroll: true });
      };
      links.append(link);
    });
    outline.append(links);
    article.append(outline);
  }
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

function search(query) {
  state.query = query;
  $("query").value = query;
  $("search-feedback").hidden = !query;
  $("search-result").textContent = query ? "正在搜索…" : "";
  return load({ reset: true });
}

$("document-search").onsubmit = (event) => { event.preventDefault(); return search($("query").value.trim()); };
$("clear-search").onclick = () => { $("query").focus(); return search(""); };
$("toggle-navigation").onclick = () => {
  const sidebar = $("category-panel");
  const library = $("library");
  const collapsed = !sidebar.hidden;
  sidebar.hidden = library.hidden = $("back-to-list").hidden = collapsed;
  const toggle = $("toggle-navigation");
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.textContent = collapsed ? "展开左栏" : "收起左栏";
  if (window.matchMedia("(max-width: 900px)").matches) {
    if (collapsed) {
      toggle.parentElement.scrollIntoView({ block: "start" });
    } else {
      library.scrollIntoView({ block: "start" });
      library.focus({ preventScroll: true });
    }
  }
};
$("refresh").onclick = () => load();
$("previous").onclick = () => { state.page--; load(); };
$("next").onclick = () => { state.page++; load(); };
$("page-size").onchange = () => { state.size = Number($("page-size").value); load({ reset: true }); };
load();
