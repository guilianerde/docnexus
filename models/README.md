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

DocNexus never downloads models at runtime. To override the packaged model in an initialized project, install a prepared local model directory with:

```bash
docnexus embeddings install --from /path/to/BAAI/bge-small-zh-v1.5
```
