#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const smokeRoot = await realpath(await mkdtemp(join(tmpdir(), "docnexus-tarball-smoke-")));
const packDirectory = join(smokeRoot, "pack");
const projectDirectory = join(smokeRoot, "project");
const installationDirectory = join(projectDirectory, ".docnexus");
const npmEnvironment = { ...process.env };
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const sourceManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const packageNameParts = sourceManifest.name.split("/");

try {
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(installationDirectory, { recursive: true })
  ]);

  const packed = await run(npmExecutable, ["pack", "--json", "--pack-destination", packDirectory], {
    cwd: repositoryRoot, env: npmEnvironment
  });
  const [{ filename, integrity }] = JSON.parse(packed.stdout);
  if (!filename) {
    throw new Error("npm pack did not report a tarball filename");
  }

  const tarballPath = join(packDirectory, filename);
  // Exercise the release tarball against the same dependency versions verified in CI.
  const dependency = `file:${tarballPath}`;
  const lock = JSON.parse(await readFile(join(repositoryRoot, "package-lock.json"), "utf8"));
  lock.name = "docnexus-smoke";
  lock.version = "1.0.0";
  lock.packages[""] = { name: lock.name, version: lock.version, dependencies: { [sourceManifest.name]: dependency } };
  lock.packages[`node_modules/${sourceManifest.name}`] = {
    version: sourceManifest.version,
    resolved: dependency,
    integrity: `sha512-${createHash("sha512").update(await readFile(tarballPath)).digest("base64")}`,
    dependencies: sourceManifest.dependencies,
    bin: sourceManifest.bin,
    engines: sourceManifest.engines,
    hasInstallScript: true
  };
  await writeFile(join(installationDirectory, "package.json"), JSON.stringify({
    name: lock.name, version: lock.version, private: true,
    dependencies: { [sourceManifest.name]: dependency }, overrides: sourceManifest.overrides
  }));
  await writeFile(join(installationDirectory, "package-lock.json"), JSON.stringify(lock));
  const legacyWorkspace = join(projectDirectory, "docnexus");
  await mkdir(join(legacyWorkspace, "library"), { recursive: true });
  await writeFile(join(legacyWorkspace, "project.json"), JSON.stringify({ format_version: 6, initialized_at: "2026-01-01T00:00:00Z" }));
  await writeFile(join(legacyWorkspace, "library", "legacy.md"), "Remove this old-version knowledge during installation");
  await run(npmExecutable, ["ci", "--prefix", installationDirectory, "--offline", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: projectDirectory, env: npmEnvironment
  });

  assert(!await stat(legacyWorkspace).then(() => true).catch(() => false), "npm installation did not remove legacy DocNexus data");

  const packageDirectory = join(installationDirectory, "node_modules", ...packageNameParts);
  const cliPath = join(installationDirectory, "node_modules", ".bin", process.platform === "win32" ? "docnexus.cmd" : "docnexus");
  const installedPackagePath = await realpath(packageDirectory);
  const installedCliPath = await realpath(cliPath);
  const workspacePath = await realpath(repositoryRoot);

  if (installedPackagePath.startsWith(`${workspacePath}/`)) {
    throw new Error(`tarball package unexpectedly resolves inside the workspace: ${installedPackagePath}`);
  }
  if (!installedCliPath.startsWith(`${installedPackagePath}/`)) {
    throw new Error(`installed docnexus bin does not resolve into the tarball package: ${installedCliPath}`);
  }

  await verifyPackageContents(packageDirectory);

  const cliEnvironment = { ...process.env };
  delete cliEnvironment.NODE_PATH;
  delete cliEnvironment.DOCNEXUS_EMBEDDER;
  delete cliEnvironment.DOCNEXUS_DATABASE_URL;

  const initialized = await runJson(cliPath, ["init", "--agent", "codex"], projectDirectory, cliEnvironment);
  assert(initialized.initialized === true, "init did not report an initialized project");
  assert(initialized.workspace === join(await realpath(projectDirectory), "docnexus"), "init did not create the docnexus workspace");
  for (const entry of ["package.json", "package-lock.json", "node_modules"]) {
    assert(!await stat(join(projectDirectory, entry)).then(() => true).catch(() => false), `installation polluted the host root with ${entry}`);
  }
  assert(!await stat(join(installationDirectory, "docnexus")).then(() => true).catch(() => false), "init created a nested docnexus workspace");
  const initializedExplicitly = await runJson(cliPath, ["--project-root", projectDirectory, "init"], smokeRoot, cliEnvironment);
  assert(initializedExplicitly.created === false && initializedExplicitly.workspace === initialized.workspace, "explicit project root did not reuse the same workspace");
  await stat(join(projectDirectory, ".docnexus", "skills", "docnexus", "SKILL.md"));
  await stat(join(projectDirectory, ".agents", "skills", "docnexus", "SKILL.md"));
  const agentsInstructions = await readFile(join(projectDirectory, "AGENTS.md"), "utf8");
  assert(agentsInstructions.includes("docnexus/CONCEPTS.md"), "init did not add the DocNexus block to AGENTS.md");

  const doctor = await runJson(cliPath, ["doctor"], projectDirectory, cliEnvironment);
  assert(doctor.checks?.project?.initialized === true, "doctor did not recognize the initialized project");
  assert(doctor.result === "ok", "doctor reported issues in the text workspace");

  const draft = await runJson(cliPath, ["draft", "new", "--slug", "smoke"], projectDirectory, cliEnvironment);
  await Promise.all([
    writeFile(join(projectDirectory, draft.artifacts.source), "The installed DocNexus tarball provides local project memory."),
    writeFile(
      join(projectDirectory, draft.artifacts.document),
      "# Installed package\n\n{{fact:fact_tarball_old}}\n"
    ),
    writeFile(
      join(projectDirectory, draft.artifacts.metadata),
      JSON.stringify({
        title: "Installed package smoke test",
        category: "reference",
        summary: "Verifies document storage and recall through the CLI installed from the release tarball.",
        tags: ["release", "smoke"],
        entities: [
          {
            name: "DocNexus tarball",
            type: "component",
            description: "The npm artifact installed and executed by the release smoke test.",
            aliases: ["ReleaseBundle"]
          }
        ],
        relationships: [],
        facts: [
          { id: "fact_tarball_old", text: "Old release package marker.", provenance: "Smoke fixture initial policy", entity: "DocNexus tarball", valid_from: "2020-01-01T00:00:00Z" },
          { id: "fact_tarball_current", text: "The installed DocNexus tarball provides local project memory.", provenance: "Smoke fixture revised policy", entity: "ReleaseBundle", valid_from: "2020-01-02T00:00:00Z", replaces: "fact_tarball_old" }
        ]
      })
    )
  ]);

  const sealed = await runJson(
    cliPath,
    ["draft", "seal", "--id", draft.draft_id, "--file", "release/smoke.md", "--category", "codeReview", "--category-reason", "Caller-selected release review"],
    projectDirectory,
    cliEnvironment
  );
  assert(sealed.result === "draft_ready", "draft seal did not report a ready draft");
  const protocol = await runJson(cliPath, ["protocol"], projectDirectory, cliEnvironment);
  assert(protocol.protocol_version === 1 && protocol.errors.target_changed.retryable === false, "installed CLI did not expose the shared operator contract");
  assert(sealed.preview_file, "fact-backed draft did not produce a reviewable preview");
  assert((await readFile(join(projectDirectory, sealed.preview_file), "utf8")).includes("local project memory"), "draft preview did not render the canonical fact");
  const preview = await runJson(cliPath, ["draft", "preview", "--id", draft.draft_id], projectDirectory, cliEnvironment);
  assert(preview.result === "draft_preview" && preview.sealed_version === sealed.sealed_version, "installed preview lost its sealed version");
  assert(preview.document.includes("local project memory") && preview.document_hash === createHash("sha256").update(preview.document).digest("hex"), "installed preview lost its complete fact-backed content or hash");

  const added = await runJson(cliPath, ["document", "add", "--draft", draft.draft_id], projectDirectory, cliEnvironment);
  assert(added.operation === "created", "document add did not create the managed document");
  assert(added.sealed_version === preview.sealed_version, "installed ingestion did not identify the previewed version");

  const listed = await runJson(cliPath, ["document", "list"], projectDirectory, cliEnvironment);
  assert(listed.records?.[0]?.id === added.id, "project-local document list did not find the document");
  let catalog = await runJson(cliPath, ["document", "query", "--all"], projectDirectory, cliEnvironment);
  assert(catalog.schema_version === 1 && catalog.pagination === null && catalog.total === 1, "full document query did not return a complete snapshot");
  assert(catalog.documents[0].category === "codeReview" && catalog.documents[0].category_reason === "Caller-selected release review" && catalog.documents[0].document.includes("local project memory"), "document query lost caller classification or generated content");
  const queryScript = join(projectDirectory, ".docnexus/skills/docnexus-library/scripts/query-documents.mjs");
  const page = await runJson(process.execPath, [queryScript, "--project-root", projectDirectory, "--page", "1", "--page-size", "1", "--category", "codeReview", "--revision", catalog.revision], smokeRoot, cliEnvironment);
  assert(page.documents[0].id === added.id && page.pagination.page_size === 1 && page.revision === catalog.revision, "orchestration query script did not delegate the stable paginated query");
  const classified = await runJson(cliPath, ["document", "classify", "--id", added.id, "--category", "发布与分发", "--reason", "结合项目 npm 分发流程与安装包验证文档统一归类", "--revision", catalog.revision], projectDirectory, cliEnvironment);
  assert(classified.operation === "reclassified", "category-only operation did not persist the model's judgment");
  catalog = await runJson(process.execPath, [queryScript, "--project-root", projectDirectory, "--all", "--category", "发布与分发"], smokeRoot, cliEnvironment);
  assert(catalog.documents[0].id === added.id && catalog.documents[0].category_reason === classified.category_reason, "query adapter did not return a model-defined category and basis");
  assert(catalog.categories.length === 1 && catalog.categories[0].id === "发布与分发", "category navigation remained constrained to the legacy taxonomy");

  const currentAssets = await runJson(cliPath, ["document", "get", "--id", added.id, "--include", "template,metadata"], projectDirectory, cliEnvironment);
  const packet = await runJson(cliPath, ["recall", "installed DocNexus tarball", "--category", "发布与分发", "--return-unit", "page", "--context-budget", "8000"], projectDirectory, cliEnvironment);
  assert(packet.protocol_version === 1 && packet.evidence.some(block => block.document_id === added.id), "installed CLI did not deliver canonical evidence");
  assert(packet.delivery.estimated_tokens === Buffer.byteLength(JSON.stringify(packet, null, 2) + "\n") && packet.delivery.estimated_tokens <= 8000, "installed evidence exceeded its declared complete-response estimate");
  assert(packet.as_of && packet.snapshot_revision && !packet.context_groups && !packet.results, "installed evidence duplicated unbudgeted contexts or omitted its snapshot");
  assert((await runJson(cliPath, ["search", "installed DocNexus tarball", "--category", "missing"], projectDirectory, cliEnvironment)).results.length === 0, "installed search ignored the category filter");
  assert((await runJson(cliPath, ["recall", "installed DocNexus tarball", "--mode", "vector", "--category", "missing"], projectDirectory, cliEnvironment)).results.length === 0, "installed vector recall ignored the category filter");
  let missingCode;
  try { await runJson(cliPath, ["--json", "document", "get", "--id", "doc_0000000000000000"], projectDirectory, cliEnvironment); }
  catch (error) { missingCode = JSON.parse(error.cause.stdout).code; }
  assert(missingCode === "document_not_found", "installed CLI did not return a stable JSON error code");
  assert(/^[a-f0-9]{64}$/.test(currentAssets.record_version), "installed reader did not return the extraction version");
  const staleDraft = await runJson(cliPath, ["draft", "new", "--slug", "stale"], projectDirectory, cliEnvironment);
  await Promise.all([
    writeFile(join(projectDirectory, staleDraft.artifacts.source), "Staged update before a newer classification"),
    writeFile(join(projectDirectory, staleDraft.artifacts.document), `${currentAssets.template}\n\nStale draft marker.`),
    writeFile(join(projectDirectory, staleDraft.artifacts.metadata), JSON.stringify(currentAssets.metadata))
  ]);
  let versionRequired = false;
  try { await runJson(cliPath, ["draft", "seal", "--id", staleDraft.draft_id, "--file", "release/smoke.md"], projectDirectory, cliEnvironment); }
  catch (error) { versionRequired = error.message.includes("requires --base-version"); }
  assert(versionRequired, "installed seal accepted an update without its extraction version");
  await runJson(cliPath, ["draft", "seal", "--id", staleDraft.draft_id, "--file", "release/smoke.md", "--base-version", currentAssets.record_version], projectDirectory, cliEnvironment);
  const newerReason = "维护者修正依据：安装包发布与离线验证属于同一交付流程";
  await runJson(cliPath, ["document", "classify", "--id", added.id, "--category", "发布与分发", "--reason", newerReason], projectDirectory, cliEnvironment);
  let staleRefused = false;
  try { await runJson(cliPath, ["document", "add", "--draft", staleDraft.draft_id, "--replace"], projectDirectory, cliEnvironment); }
  catch (error) { staleRefused = error.message.includes("target changed since sealing"); }
  assert(staleRefused, "installed CLI did not reject a stale draft target");
  catalog = await runJson(cliPath, ["document", "query", "--all"], projectDirectory, cliEnvironment);
  assert(catalog.documents[0].category_reason === newerReason && !catalog.documents[0].document.includes("Stale draft marker"), "stale rejection did not preserve newer knowledge");

  const viewerSmoke = join(smokeRoot, "viewer-smoke.mjs");
  await writeFile(viewerSmoke, `
import { pathToFileURL } from 'node:url';
const { startDocumentViewer } = await import(pathToFileURL(process.argv[2]).href);
const { RealEmbedder } = await import(new URL('./embedder-real.js', pathToFileURL(process.argv[2])));
const { bundledEmbeddingModelsPath } = await import(new URL('./embedding-models.js', pathToFileURL(process.argv[2])));
const { chunkText } = await import(new URL('./chunker.js', pathToFileURL(process.argv[2])));
const embedder = new RealEmbedder({ localModelPath: bundledEmbeddingModelsPath() });
const budget = await embedder.tokenBudget();
if (budget.maxTokens !== 512) throw new Error('Installed tokenizer lost its model limit');
const content = '发布时检查常规项目文件和各项运行记录。'.repeat(70) + '最后确认失败任务已经重新投递。';
const chunks = chunkText(content, { tokenBudget: budget });
if (chunks.length < 2 || chunks.some(chunk => budget.countTokens(chunk.text) > 256) || !chunks.at(-1).text.includes('失败任务已经重新投递')) throw new Error('Installed chunker lost bounded ending content');
await embedder.embed(chunks.at(-1).text);
let oversizedRefused = false;
try { await embedder.embed(content); } catch (error) { oversizedRefused = error.message.includes('exceeds model token limit'); }
if (!oversizedRefused) throw new Error('Installed embedder silently truncated an oversized input');
const viewer = await startDocumentViewer(process.argv[3]);
try {
  for (const route of ['/', '/app.js', '/style.css']) {
    const response = await fetch(viewer.url + route);
    if (!response.ok || !(await response.text()).length) throw new Error('Missing packaged viewer asset: ' + route);
  }
  const response = await fetch(viewer.url + '/api/documents?all=true');
  const snapshot = await response.json();
  if (!response.ok || snapshot.documents[0].category !== '发布与分发' || !snapshot.documents[0].html.includes('local project memory')) throw new Error('Packaged viewer lost canonical content');
  if ((await fetch(viewer.url + '/api/documents', { method: 'POST' })).status !== 405) throw new Error('Packaged viewer allowed writes');
} finally { await viewer.close(); }
`);
  await run(process.execPath, [viewerSmoke, join(packageDirectory, "dist/src/viewer.js"), projectDirectory], { cwd: smokeRoot, env: cliEnvironment });

  const recalled = await runJson(
    cliPath,
    ["search", "installed DocNexus tarball", "--limit", "1"],
    projectDirectory,
    cliEnvironment
  );
  assert(recalled.results?.length === 1, "recall did not return the installed-package document");
  assert(
    recalled.results?.[0]?.file_path === "release/smoke.md",
    "recall did not cite the managed document from the smoke project"
  );

  const concepts = await runJson(cliPath, ["concepts"], projectDirectory, cliEnvironment);
  assert(concepts.concepts?.[0]?.name === "DocNexus tarball", "concepts did not list the ingested entity");
  const conceptIndex = await readFile(join(projectDirectory, "docnexus", "CONCEPTS.md"), "utf8");
  const conceptShard = conceptIndex.match(/`docnexus\/(concepts\/[^`]+\.md)`/)?.[1];
  assert(conceptShard, "CONCEPTS.md did not route to a category concept file");
  const conceptShardText = await readFile(join(projectDirectory, "docnexus", conceptShard), "utf8");
  assert(conceptShardText.includes("**DocNexus tarball**"), "category concept file was not regenerated after ingestion");

  const document = await runJson(cliPath, ["document", "get", "--id", added.id, "--include", "document,template,timeline"], projectDirectory, cliEnvironment);
  assert(document.document.includes("local project memory"), "document get did not return full current knowledge");
  assert(document.timeline.includes("local project memory"), "document get did not return the source timeline");
  assert(document.template.includes("{{fact:fact_tarball_old}}"), "document get lost its author-owned fact reference");
  assert(document.document.includes("<!-- docnexus:fact fact_tarball_old -->"), "document get did not generate a fact block");
  assert(!document.document.includes("Old release package marker"), "generated Markdown revived a superseded fact");
  assert((await runJson(cliPath, ["document", "render"], projectDirectory, cliEnvironment)).rendered_documents === 0, "unchanged fact views were needlessly regenerated");
  const semantic = await runJson(cliPath, ["recall", "installed DocNexus tarball", "--limit", "1"], projectDirectory, cliEnvironment);
  assert(semantic.results?.[0]?.document_ref?.document_id === added.id, "semantic recall did not find the saved document");
  assert(semantic.results[0].ranking?.primary === "rrf", "default recall did not fuse retrieval ranks");
  assert(semantic.context_groups[0].matches?.some(match => match.anchor.document_id === added.id && /^[a-f0-9]{64}$/.test(match.anchor.record_version)), "recall lost versioned source anchors");
  assert(semantic.context_groups[0].facts?.some((fact) => fact.id === "fact_tarball_old" && fact.status === "superseded"), "recall lost superseded fact status");
  const facts = await runJson(cliPath, ["facts", "list", "--entity", "ReleaseBundle"], projectDirectory, cliEnvironment);
  assert(facts.facts?.length === 1 && facts.facts[0].id === "fact_tarball_current", "alias fact lookup did not filter inactive claims");
  const historical = await runJson(cliPath, ["facts", "list", "--at", "2020-01-01T12:00:00Z"], projectDirectory, cliEnvironment);
  assert(historical.facts?.length === 1 && historical.facts[0].id === "fact_tarball_old", "effective-time lookup did not preserve earlier knowledge");
  const drafts = await runJson(cliPath, ["draft", "list", "--status", "ingested"], projectDirectory, cliEnvironment);
  assert(drafts.drafts?.[0]?.document_id === added.id, "transaction did not persist its draft receipt");
  await stat(join(projectDirectory, ".docnexus/store/brain.pglite"));

  const cloneDirectory = join(smokeRoot, "clone");
  await mkdir(cloneDirectory);
  await cp(join(projectDirectory, "docnexus"), join(cloneDirectory, "docnexus"), {
    recursive: true, filter: source => source !== join(installationDirectory, "node_modules")
  });
  await cp(installationDirectory, join(cloneDirectory, ".docnexus"), {
    recursive: true, filter: source => source !== join(installationDirectory, "node_modules")
  });
  await rm(join(cloneDirectory, ".docnexus/store"), { recursive: true, force: true });
  const sourceOnly = await runJson(cliPath, ["document", "query", "--all"], cloneDirectory, cliEnvironment);
  assert(sourceOnly.documents[0].id === added.id && sourceOnly.revision === catalog.revision, "document query depended on retrieval stores or changed the text snapshot");
  assert(!await stat(join(cloneDirectory, ".docnexus/store")).then(() => true).catch(() => false), "document query recreated derived stores");
  const recovered = await runJson(cliPath, ["recall", "installed DocNexus tarball", "--limit", "1"], cloneDirectory, cliEnvironment);
  assert(recovered.results?.[0]?.document_ref?.document_id === added.id, "text clone could not rebuild semantic memory");
  await runJson(cliPath, ["document", "delete", "--id", added.id, "--force"], cloneDirectory, cliEnvironment);
  const empty = await runJson(cliPath, ["recall", "installed DocNexus tarball"], cloneDirectory, cliEnvironment);
  assert(empty.results.length === 0, "deleted memory remained searchable");

  for (const [file, title, body] of [
    ["search/generic.md", "文档说明", "保存当前知识。"],
    ["search/long.md", "检索评估", "长文回归检查末尾结论。"]
  ]) {
    const draft = await runJson(cliPath, ["draft", "new", "--slug", "chinese-search"], cloneDirectory, cliEnvironment);
    await Promise.all([
      writeFile(join(cloneDirectory, draft.artifacts.source), "Chinese precision smoke fixture"),
      writeFile(join(cloneDirectory, draft.artifacts.document), body),
      writeFile(join(cloneDirectory, draft.artifacts.metadata), JSON.stringify({ title, summary: title, tags: [], entities: [], relationships: [] }))
    ]);
    await runJson(cliPath, ["draft", "seal", "--id", draft.draft_id, "--file", file], cloneDirectory, cliEnvironment);
    await runJson(cliPath, ["document", "add", "--draft", draft.draft_id], cloneDirectory, cliEnvironment);
  }
  const chinese = await runJson(cliPath, ["search", "长文", "--limit", "5"], cloneDirectory, cliEnvironment);
  assert(chinese.results.length === 1 && chinese.results[0].file_path === "search/long.md", "installed Chinese search admitted a single-character distraction");
  assert(chinese.results[0].matched_terms.includes("长文") && chinese.results[0].snippet.includes("长文"), "installed search did not expose full phrase evidence");

  const usageBefore = await runJson(cliPath, ["usage", "status"], projectDirectory, cliEnvironment);
  assert(usageBefore.enabled === false && usageBefore.events === 0, "usage recording was not opt-in");
  await runJson(cliPath, ["usage", "enable"], projectDirectory, cliEnvironment);
  await runJson(cliPath, ["search", "installed DocNexus tarball", "--limit", "1"], projectDirectory, cliEnvironment);
  await runJson(cliPath, ["usage", "feedback", "--rating", "useful"], projectDirectory, cliEnvironment);
  const usageReport = await runJson(cliPath, ["usage", "export"], projectDirectory, cliEnvironment);
  assert(usageReport.events.length === 2 && usageReport.events[0].result_count === 1, "installed usage collector lost its query");
  assert(usageReport.events[1].target_event_id === usageReport.events[0].event_id, "installed feedback lost its target");
  assert(!JSON.stringify(usageReport).includes("installed DocNexus tarball"), "installed usage export leaked query text");
  await runJson(cliPath, ["usage", "disable"], projectDirectory, cliEnvironment);

  const reset = await runJson(cliPath, ["reset", "--force"], projectDirectory, cliEnvironment);
  assert(reset.preserved_installation === true, "reset did not preserve the workspace-local npm installation");
  await stat(cliPath);
  await stat(join(installationDirectory, "package.json"));
  await stat(join(installationDirectory, "package-lock.json"));
  const reinitialized = await runJson(cliPath, ["init", "--agent", "codex"], projectDirectory, cliEnvironment);
  assert(reinitialized.created === true && reinitialized.workspace === initialized.workspace, "installed CLI could not initialize after reset");
  assert((await runJson(cliPath, ["document", "list"], projectDirectory, cliEnvironment)).records.length === 0, "reset retained project knowledge");
  assert((await runJson(cliPath, ["usage", "status"], projectDirectory, cliEnvironment)).events === 0, "reset retained usage records");

  const configured = await runJson(cliPath, ["init", "--git-remote", "https://example.com/team/knowledge.git"], projectDirectory, cliEnvironment);
  assert(configured.git?.branch === "main", "installed Git setup did not pin main");
  const git = args => run("git", ["-C", configured.git.repository, ...args], { cwd: projectDirectory, env: cliEnvironment });
  assert((await git(["remote", "get-url", "origin"])).stdout.trim() === configured.git.remote, "installed setup lost its knowledge origin");
  await git(["symbolic-ref", "HEAD", "refs/heads/other"]);
  let branchRefused = false;
  try { await runJson(cliPath, ["status", "--json"], projectDirectory, cliEnvironment); }
  catch (error) { branchRefused = error.message.includes("git_branch_mismatch"); }
  assert(branchRefused, "installed CLI did not reject a changed knowledge branch");
  await git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  const gitReset = await runJson(cliPath, ["reset", "--force"], projectDirectory, cliEnvironment);
  assert(gitReset.preserved_git && gitReset.preserved_installation, "installed reset did not preserve Git and the npm runtime");
  await stat(join(configured.git.repository, ".git", "docnexus-branch.json"));
  await runJson(cliPath, ["init"], projectDirectory, cliEnvironment);
  assert((await git(["symbolic-ref", "HEAD"])).stdout.trim() === "refs/heads/main", "reinitialization lost the pinned branch");

  process.stdout.write(`Tarball smoke test passed: ${filename}\nIntegrity: ${integrity}\n`);
} finally {
  await rm(smokeRoot, { recursive: true, force: true });
}

async function verifyPackageContents(packageDirectory) {
  const requiredFiles = [
    "README.md",
    "README.zh-CN.md",
    "CHANGELOG.md",
    "LICENSE",
    "SECURITY.md",
    "docs/README.md",
    "docs/architecture/overview.zh-CN.md",
    "docs/architecture/document-query.zh-CN.md",
    "docs/operations/knowledge-evaluation.zh-CN.md",
    "docs/operations/usage-observation.zh-CN.md",
    "viewer/index.html",
    "viewer/app.js",
    "viewer/style.css",
    "docs/product/mvp.zh-CN.md",
    "docs/product/mvp.en.md",
    "docs/roadmap/current.zh-CN.md",
    "docs/operations/release-checklist.md",
    "skills/docnexus/SKILL.md",
    "skills/docnexus-extract/SKILL.md",
    "skills/docnexus-extract/references/facts.md",
    "skills/docnexus-ingest/SKILL.md",
    "skills/docnexus-recall/SKILL.md",
    "skills/docnexus-library/SKILL.md",
    "skills/docnexus-library/scripts/query-documents.mjs",
    "skills/docnexus-library/references/classification.md",
    "skills/docnexus-extract/references/capture-resolution.md",
    "skills/docnexus-maintain/SKILL.md"

  ];

  for (const relativePath of requiredFiles) {
    const details = await stat(join(packageDirectory, relativePath));
    assert(details.isFile() && details.size > 0, `packaged file is missing or empty: ${relativePath}`);
  }

  const model = await stat(join(packageDirectory, "models/BAAI/bge-small-zh-v1.5/onnx/model_quantized.onnx"));
  assert(model.size > 1_000_000, "bundled embedding model is missing or a placeholder");
  await stat(join(packageDirectory, "dist/src/retrieval-index.js"));
  await stat(join(packageDirectory, "dist/src/postgres-engine.js"));
  await stat(join(packageDirectory, "dist/src/postgres-store.js"));
  await stat(join(packageDirectory, "dist/src/viewer.js"));
  for (const file of ["project-lock", "text-transaction", "workspace-io", "workspace-git", "knowledge", "hybrid-recall", "fact-renderer", "document-query", "usage", "usage-metrics"]) await stat(join(packageDirectory, `dist/src/${file}.js`));

  const packagedManifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  assert(["@electric-sql/pglite", "@electric-sql/pglite-pgvector", "postgres", "@huggingface/transformers"].every(name => packagedManifest.dependencies?.[name]), "retrieval runtime dependencies are missing");
  assert(packagedManifest.bin?.docnexus === "dist/src/cli.js", "package bin does not expose dist/src/cli.js");
}

async function runJson(executable, args, cwd, env) {
  const result = await run(executable, args, { cwd, env });
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`command did not return JSON: ${executable} ${args.join(" ")}\n${result.stdout}`, { cause: error });
  }
}

async function run(executable, args, options) {
  try {
    return await execFileAsync(executable, args, { ...options, maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    throw new Error(`command failed: ${executable} ${args.join(" ")}\n${stdout}${stderr}`, { cause: error });
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
