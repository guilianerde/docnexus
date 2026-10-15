# Contextual classification

The model running the project skills owns classification judgment. Categories are project-defined names, not a fixed list. The CLI validates and persists the decision; read/query commands never invoke a model or silently reorganize documents.

## When to review

Review classification while extracting/updating knowledge, when a project direction or document purpose changes, when related pages reveal duplicate category meanings, or when the user asks to organize knowledge. Focus on affected documents; an unrelated small coding task does not justify reorganizing the whole library.

## Ground the decision

1. Read the project's README and relevant project instructions to understand its purpose and vocabulary.
2. Run `docnexus document query --page 1 --page-size 20`. Inspect global `categories[]`, document summaries and existing `category_reason`; retain the revision for changes based on this context. Read more pages or use search/recall to select related documents rather than loading every full document by default.
3. Read the candidate's current document/template and relevant neighboring documents. Compare actual purpose and content with how the project already groups similar material.
4. Prefer an existing category **id** when its meaning fits. Display labels may differ from legacy ids; do not create a synonymous category just because the label looks different. If no existing category fits, choose a short meaningful name in the project's working language, such as `接口契约`, `部署与运维`, or `用户研究`. Avoid a new category for each file, cosmetic renaming and classification based only on filenames.
5. Record one primary `category` plus a concise `category_reason` grounded in the project and documents actually read. Use tags for cross-cutting topics. Explicit user corrections take priority. Use `uncategorized` only when the available context cannot support a useful grouping.

## Apply and evolve

For a new/updated document, put category and reason in the extraction draft metadata. Keep canonical facts, aliases and relationships intact.

For an existing document whose content is already correct, use the category-only operation:

```bash
./node_modules/.bin/docnexus document classify --id <document_id> \
  --category "接口契约" \
  --reason "项目 API 规范及相关端点文档都以请求和响应约定组织，本文应归入该组" \
  --revision <query_revision>
```

This changes only classification metadata, its record hash/timestamp and audit history. It preserves source, Markdown, facts, aliases and relationships. Identical decisions are no-ops. A stale revision requires fresh context before deciding again.

Categories can be renamed, merged or split by reclassifying the affected documents. Read those documents and prepare a concrete list of changes and reasons first; this operation never moves files, splits document content or deletes facts. Work within the user's authorized capture/update/classification scope, including standing authorization already given. When that authorization covers category maintenance, apply relevant category-only changes and report them without asking again. A read-only browse alone grants no new write authorization.

After each classification write, fetch a new revision before the next guarded update. After finishing, query again and report changed document ids, old/new categories and the basis. Counts are derived from metadata; unused categories disappear automatically. There is no separate taxonomy store or background classification daemon.
