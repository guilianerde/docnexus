# DocNexus Product Brief

DocNexus helps coding agents retain project decisions, conventions and explanations across sessions. Current knowledge and source timelines are plain text committed beside the code; skills find and read the relevant documents.

## Core workflows

- Remember a decision: refine a draft, review it, save current knowledge and its source timeline.
- Explain a convention: find files, read current knowledge and relevant history, answer with citations.
- Change a decision: read existing knowledge, merge new material and replace explicitly superseded conclusions with authorization.
- Work on another machine: clone the text workspace and read immediately, with immediate text lookup and automatic local index rebuilding for semantic recall.
- Adopt hand edits: review the edited page, preserve the original source and append an edit event.
- Store a code-review report as `codeReview`: accept the caller's category for this write, skip model classification, and seal/review that category with the document before ingestion.

## Implemented scope

Project workspaces, six skills, sealed drafts, document storage and deletion, keyword/name lookup, keyword/vector hybrid recall and one-hop graph context, full document and timeline reads, document/concept directories, skill links and version refresh, content hashes, path boundaries and read-only diagnostics.

The agent compiles current knowledge; the CLI saves complete documents without inferring contradictions or supersession. Timeline entries contain save dates, summaries and sources, not every prior compiled document version.

Calling skills can supply an exact category with `draft seal --category <name>` and an optional basis. Without an explicit category, skills classify from project context. The selection is not a permanent lock. A local read-only viewer supports categorized, paginated reading and ETag/304 polling, preserving unchanged views while retaining canonical integrity and fact-time checks.

The quality suite separates source-supported project questions, unsupported questions and explicit simulations, with development/holdout target families. Retrieval and budgeted evidence retention are measured separately; these checks do not establish host-agent answer or abstention quality.

## Boundaries and acceptance

The local CLI uses PostgreSQL + pgvector for document/chunk, vector and typed relationship projections: embedded PGLite by default or an existing Postgres server configured with `DOCNEXUS_DATABASE_URL`. Ordinary writes reuse unchanged vectors and maintain HNSW incrementally; each document projection commits in one database transaction. A packaged BGE q8 ONNX model provides offline embeddings. The CLI makes no answer-generation calls. `search` is model-independent literal lookup; `recall` fuses keyword/vector document ranks with RRF and provides one-hop graph evidence. `--mode vector` retains the original vector mode. Entity aliases and explicit facts carry canonical identity, provenance, effective time, expiry, replacement and withdrawal. Facts are defined once in owner metadata and rendered through Markdown id references, following effective replacements and validity. Drafts include sealed generated previews. Synthesis, free-prose maintenance and evidence judgment belong to the agent. History requires an explicit timeline read. Writes and deletion require authorization; reads may be proactive. A local project lock and durable text journal recover interrupted memory writes, deletion and draft receipts before CLI reads; external editors, Git and other machines are outside that coordination.

Automatic conversation capture, file watching and old-format migration are outside scope. Integrity checks detect missing text, unadopted edits and hash mismatches. Recovery and locking cover local CLI processes; external editors, Git and other machines do not participate in that lock.

Release acceptance covers offline tarball installation, the capture/search/read workflow, Chinese and code-identifier lookup, clone reads and index rebuilding, timeline updates, deletion, project isolation, sealed-draft tampering and path boundaries.
