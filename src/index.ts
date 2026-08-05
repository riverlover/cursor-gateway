/**
 * Cursor Gateway - Main Entry Point
 *
 * A lightweight proxy that exposes Cursor IDE's backend APIs as OpenAI-compatible endpoints.
 *
 * Architecture:
 *   - JWT Token (Auth0) → api2.cursor.sh via HTTP/JSON for /api/usage, /v1/models
 *   - Warm AgentPool (ask-mode CLI) → local `agent` binary for /v1/chat/completions
 *
 * Usage:
 *   export CURSOR_JWT="<your-jwt-from-state.vscdb>"
 *   npx tsx src/index.ts
 */

import express from "express";
import type { Server } from "http";
import { DashboardClient } from "./client/dashboard.js";
import { getAgentPool } from "./client/agent-pool.js";
import {
  handleChatCompletions,
  handleUsage,
  handleModels,
  handleHealth,
} from "./api/routes.js";

const PORT = parseInt(process.env.PORT || "4647", 10);
const CURSOR_JWT = process.env.CURSOR_JWT;

function getJwtToken(): string {
  if (!CURSOR_JWT) {
    console.error("❌ CURSOR_JWT environment variable is required");
    console.error("   Extract from: ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb");
    console.error("   SQL: SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'");
    process.exit(1);
  }
  return CURSOR_JWT;
}

async function main() {
  const jwt = getJwtToken();
  const dashboard = new DashboardClient(jwt);
  const pool = getAgentPool();
  await pool.start();

  const app = express();

  app.use(express.json({ limit: "10mb" }));

  // CORS
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    next();
  });
  app.options("*", (_req, res) => res.sendStatus(204));

  // Routes
  app.get("/health", (req, res) => handleHealth(req, res, dashboard));
  app.get("/api/usage", (req, res) => handleUsage(req, res, dashboard));
  app.get("/v1/models", (req, res) => handleModels(req, res, dashboard));
  app.post("/v1/chat/completions", (req, res) => handleChatCompletions(req, res, dashboard));

  app.use((_req, res) => {
    res.status(404).json({ error: { message: "Not found", type: "invalid_request_error", code: "not_found" } });
  });

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(PORT, () => {
      console.log(`✅ Cursor Gateway running on http://localhost:${PORT}`);
      console.log(`   /health          - Health check + token validation`);
      console.log(`   /api/usage       - Cursor account usage (JWT auth)`);
      console.log(`   /v1/models       - Available models (OpenAI-compatible)`);
      console.log(`   /v1/chat/completions - Chat completions (warm agent pool)`);
      console.log("");
      console.log(`   Agent pool: ${JSON.stringify(pool.stats())} mode=${process.env.AGENT_MODE || "ask"}`);
      console.log(`   Usage as OpenAI proxy:`);
      console.log(`     BASE_URL=http://localhost:${PORT}/v1`);
      console.log(`     API_KEY=not-needed`);
      resolve(s);
    });
  });

  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] Shutting down...`);
    await pool.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  return server;
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
