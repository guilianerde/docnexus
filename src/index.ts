#!/usr/bin/env node
import { runMcpServer } from "./mcp.js";

if (process.argv.slice(2).length !== 0) {
  throw new Error("Usage: docnexus mcp");
}

await runMcpServer();
