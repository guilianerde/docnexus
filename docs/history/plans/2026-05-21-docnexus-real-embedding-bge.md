# DocNexus Real Embedding (bge-small-zh-v1.5) Implementation Plan

> Goal: Replace hash embedding with local real embedding (`BAAI/bge-small-zh-v1.5`) using Node in-process inference, while preserving current MCP/CLI contracts and lifecycle semantics.

## Scope

In scope:

- Replace default embedder implementation with real local embedding.
- Keep indexing and recall command surface unchanged.
- Keep LadybugDB graph/vector write and recall flow intact.
- Add focused tests for real embedder integration path.

Out of scope:

- Model switching.
- Multi-model index coexistence.
- Auto migration/rebuild.
- Recall ranking strategy redesign.

## Task Checklist

### Task 1: Dependency and Runtime Preparation

- [ ] Confirm existing embedding-related dependencies and runtime constraints in `package.json`.
- [ ] Add required Node in-process embedding dependencies for `bge-small-zh-v1.5` inference.
- [ ] Ensure dependency install and lockfile update complete successfully.

Verify:

- [ ] `npm install` succeeds.
- [ ] `npm ls` shows required embedding packages resolved.

### Task 2: Implement Real Embedder Module

- [ ] Add `src/embedder-real.ts` implementing the existing embedder contract (text -> fixed-dimension vector).
- [ ] Load model `BAAI/bge-small-zh-v1.5` with local inference runtime.
- [ ] Enforce vector dimension validation against `EMBEDDING_DIMENSION`.
- [ ] Keep implementation deterministic and stable for repeated indexing behavior.

Verify:

- [ ] New module compiles under TypeScript.
- [ ] Dimension mismatch throws explicit error.

### Task 3: Wire Default Embedder to Real Implementation

- [ ] Update `src/embedder.ts` export/wiring so real embedder is default.
- [ ] Keep call sites in `src/file-index.ts` and `src/recall.ts` minimally changed (only dependency wiring if needed).
- [ ] Ensure no MCP/CLI contract changes.

Verify:

- [ ] Existing API signatures remain unchanged.
- [ ] `index upsert` and `recall` compile and run with real embedder path.

### Task 4: Tests Update

- [ ] Add/adjust unit tests for real embedder output dimension and stability.
- [ ] Update integration tests touching index and recall path where assumptions depended on hash embedding behavior.
- [ ] Keep test scope narrow to requested change.

Verify:

- [ ] `npm test` passes.

### Task 5: Docs Update

- [ ] Update product brief docs to reflect default real embedding (`bge-small-zh-v1.5`) and note manual rebuild recommendation after rollout.
- [ ] Ensure docs do not claim model switching is implemented.

Verify:

- [ ] `docs/product-brief-docnexus-mvp.md`
- [ ] `docs/product-brief-docnexus-mvp.zh-CN.md`
- [ ] `docs/product-brief-docnexus-mvp.en.md`

### Task 6: Final Verification

- [ ] Run full regression gates.

Commands:

```bash
npm test
npm run typecheck
npm run build
```

- [ ] Run CLI smoke recall with Chinese query and confirm result structure includes chunk/context/graph fields.

## Risks and Handling

- Model cold-start latency:
  - Accept in this phase; no preload/cache optimization yet.
- Native/runtime incompatibility in local environment:
  - Keep rollback path by reverting embedder wiring commit if required.
- Mixed old/new vector quality:
  - Document manual rebuild as rollout recommendation.

## Completion Criteria

- Hash embedding is no longer default.
- Real embedding (`bge-small-zh-v1.5`) is used in index and recall path.
- MCP/CLI contracts remain unchanged.
- Tests/typecheck/build all pass.
- Docs reflect implemented state accurately.
