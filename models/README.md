# DocNexus Embedding Models

DocNexus packages the default local embedding model assets under this directory using the Transformers.js local model layout:

```text
models/
  BAAI/
    bge-small-zh-v1.5/
      config.json
      tokenizer.json
      onnx/
        model_quantized.onnx
```

DocNexus never downloads models at runtime. To override the packaged model in an initialized project, install a prepared local model directory (it must be inside the project) with:

```bash
./node_modules/.bin/docnexus embeddings install --from path/to/BAAI/bge-small-zh-v1.5
```

The override is copied to `docnexus/store/models/` and takes precedence over this directory. `store/` is git-ignored, so each checkout installs its own override. After changing the model, run `./node_modules/.bin/docnexus index rebuild --force` so every document is re-embedded with it.
