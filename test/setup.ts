process.env.DOCNEXUS_EMBEDDER = "hash";
// Ordinary tests must never target a developer's configured remote database.
delete process.env.DOCNEXUS_DATABASE_URL;
