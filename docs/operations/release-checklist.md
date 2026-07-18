# Release Checklist

Use this checklist before publishing `@rowansenne/docnexus`. A failed item blocks the release unless the exception and owner are recorded in the release notes.

## Maintainer-owned metadata

- [x] The minimum supported Node.js version is declared in `package.json`, and the supported Node 22/24 LTS lines are covered by CI.
- [x] The maintainer selected the MIT license and added the corresponding package metadata and license file.
- [x] The canonical repository URL and issue tracker are declared in `package.json`.
- [x] Security reports are directed to `rowansenne@gmail.com` in `SECURITY.md`.
- [x] Version `0.1.0` is intentional and was confirmed as unpublished before release.

## Automated gates

Run from a clean checkout of the release commit:

```bash
npm ci
npm test
npm run typecheck
npm run build
npm pack --dry-run
DOCNEXUS_EMBEDDER=hash node scripts/tarball-smoke.mjs
npm run audit:prod
```

- [ ] Tests, typechecking, build, and package dry run pass on every supported Node.js version.
- [ ] The test run includes `test/real-runtime-e2e.test.ts`; it must use the packaged ONNX model with remote loading disabled rather than the hash embedder or a mocked pipeline.
- [ ] The tarball smoke passes on Node.js 24. It must install the generated `.tgz` into a temporary prefix and run the installed `docnexus` bin through `init`, `doctor`, `document add`, and `recall`.
- [ ] The tarball contains both root READMEs, the current `docs/` set, every bundled skill, the default model manifest/tokenizer/config, and the quantized ONNX model.
- [ ] Production dependency audit has no unreviewed critical or high severity finding. Any accepted finding records its package path, exposure analysis, mitigation, owner, and review date.
- [ ] The separate offline real-model end-to-end gate passes with remote model loading disabled; the hash embedder smoke does not replace this gate.

## Publish and verify

- [ ] npm authentication, organization access, and the intended dist-tag have been confirmed by the publisher.
- [ ] The release commit and version match the source used by the passing tarball smoke test.
- [ ] After publication, install into a new temporary directory and verify `docnexus init`, `docnexus doctor`, document add, and recall from the registry package.
- [ ] Confirm the published package page shows the intended README, version, Node.js requirement, license, repository, issue tracker, and unpacked files.
