/**
 * API route handlers — OpenAI-compatible endpoints backed by Cursor.
 *
 * Architecture:
 *   /api/usage  → DashboardClient (HTTP/JSON to api2.cursor.sh with JWT)
 *   /v1/models  → Static model list from known Cursor models
 *   /v1/chat    → AgentPool (warm ask-mode CLI workers)
 *   /health     → Health check with token validation + pool stats
 */

import { v4 as uuidv4 } from "uuid";
import type { Request, Response } from "express";
import { CursorSubprocess } from "../client/subprocess.js";
import type { ContentDeltaEvent, ResultEvent } from "../client/subprocess.js";
import { getAgentPool } from "../client/agent-pool.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import { createStreamChunk, createDoneChunk, createChatResponse } from "../adapter/cli-to-openai.js";
import { verifyCursorCli } from "../client/subprocess.js";
import type { DashboardClient as DashboardClientType } from "../client/dashboard.js";
import type { ChatCompletionRequest } from "../types/index.js";

const KNOWN_MODELS = [
  "auto", "composer-1.5", "composer-1", "composer-2.5", "composer-2", "composer-2-fast", "composer-2.5-fast",
  "opus-4.6-thinking", "opus-4.6", "opus-4.5-thinking", "opus-4.5",
  "sonnet-4.5-thinking", "sonnet-4.5",
  "gpt-5.3-codex", "gpt-5.3-codex-low", "gpt-5.3-codex-high", "gpt-5.3-codex-xhigh", "gpt-5.3-codex-fast",
  "gpt-5.3-codex-low-fast", "gpt-5.3-codex-high-fast", "gpt-5.3-codex-xhigh-fast",
  "gpt-5.2", "gpt-5.2-codex", "gpt-5.2-codex-high", "gpt-5.2-codex-low", "gpt-5.2-codex-xhigh",
  "gpt-5.1-codex-max", "gemini-3-pro", "gemini-3-flash", "grok",
  "vega", "vega-medium", "vega-high", "vega-xhigh",
  "grok-4.5", "cursor-grok-4.5-low", "cursor-grok-4.5-medium", "cursor-grok-4.5-high",
];

// Default server port — kept in sync with src/index.ts
const DEFAULT_PORT = 4647;

let cachedCliVersion: string | undefined;
let cachedAutoModels: string[] | undefined;

const PLACEHOLDER_API_KEYS = new Set([
  "not-needed",
  "no-key",
  "none",
  "null",
  "undefined",
  "your-api-key",
  "sk-xxx",
  "sk-test",
  "",
]);

function extractApiKey(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token && !PLACEHOLDER_API_KEYS.has(token.toLowerCase())) return token;
  }
  return undefined;
}

// ─── Chat Completions ────────────────────────────────────────────────────────

export async function handleChatCompletions(
  req: Request, res: Response,
  _dashboardClient: DashboardClientType
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as ChatCompletionRequest;
  const stream = body.stream === true;
  const pool = getAgentPool();
  let worker: CursorSubprocess | null = null;

  try {
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        error: { message: "messages is required", type: "invalid_request_error", code: "invalid_messages" },
      });
      return;
    }

    const { prompt, model } = openaiToCli(body);
    const apiKey = extractApiKey(req);
    console.log(
      `[chat] id=${requestId} model=${body.model} -> cli=${model} stream=${stream} apiKey=${apiKey ? "provided" : "none(local-oauth)"} pool=${JSON.stringify(pool.stats())}`
    );

    try {
      worker = await pool.acquire({ model, apiKey });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(503).json({
        error: { message: msg, type: "server_error", code: "agent_pool_unavailable" },
      });
      return;
    }

    if (stream) {
      await handleStreaming(res, worker, prompt, model, requestId);
    } else {
      await handleNonStreaming(res, worker, prompt, model, requestId);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[chat] Error:", msg);
    if (!res.headersSent) res.status(500).json({ error: { message: msg, type: "server_error", code: null } });
  } finally {
    if (worker) pool.release(worker);
  }
}

// ─── Usage ───────────────────────────────────────────────────────────────────

export async function handleUsage(
  req: Request, res: Response,
  dashboardClient: DashboardClientType
): Promise<void> {
  try {
    // Force refresh if ?refresh=1
    if (req.query.refresh === "1") dashboardClient.invalidateCache();
    const usage = await dashboardClient.getUsage();
    res.json(usage);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[usage] Error:", msg);
    res.status(502).json({ error: { message: msg, type: "upstream_error", code: null } });
  }
}

// ─── Models ──────────────────────────────────────────────────────────────────

export async function handleModels(
  req: Request, res: Response,
  dashboardClient: DashboardClientType
): Promise<void> {
  try {
    // Try to get autoBucketModels from dashboard API
    const usage = await dashboardClient.getUsage();
    const autoModels = usage.autoBucketModels || cachedAutoModels || [];
    if (autoModels.length > 0) cachedAutoModels = autoModels;

    // Merge known models with dynamic ones from API
    const allIds = [...new Set([...autoModels, ...KNOWN_MODELS])];

    res.json({
      object: "list",
      data: allIds.map(id => ({
        id,
        object: "model" as const,
        created: Math.floor(Date.now() / 1000),
        owned_by: "cursor",
      })),
    });
  } catch (error) {
    // Fallback to static model list
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.warn("[models] Dashboard error, using static list:", msg);
    res.json({
      object: "list",
      data: KNOWN_MODELS.map(id => ({
        id,
        object: "model" as const,
        created: Math.floor(Date.now() / 1000),
        owned_by: "cursor",
      })),
    });
  }
}

// ─── Health ──────────────────────────────────────────────────────────────────

export async function handleHealth(
  req: Request, res: Response,
  dashboardClient: DashboardClientType
): Promise<void> {
  const health: any = {
    status: "healthy",
    provider: "cursor-gateway",
    port: parseInt(process.env.PORT || String(DEFAULT_PORT), 10),
    timestamp: new Date().toISOString(),
    agent_pool: getAgentPool().stats(),
    agent_mode: process.env.AGENT_MODE || "ask",
  };

  try {
    const validation = await dashboardClient.validateToken();
    health.cursor_token_valid = validation.valid;
    health.token_email = validation.valid ? "token decoded" : undefined;
    if (!validation.valid) {
      health.token_error = validation.error;
      health.status = "degraded";
    }
  } catch {
    health.cursor_token_valid = false;
    health.status = "degraded";
  }

  try {
    const cli = await verifyCursorCli();
    if (cli) {
      health.agent_cli_status = cli.ok ? "connected" : "disconnected";
      health.cli_version = cli.version;
      if (cli.ok) cachedCliVersion = cli.version;
    }
  } catch {
    health.agent_cli_status = "disconnected";
  }

  const pool = health.agent_pool;
  if (pool && pool.idle < 1 && pool.inFlight < 1) {
    health.status = "degraded";
  }

  const code = health.status === "healthy" || health.status === "degraded" ? 200 : 503;
  res.status(code).json(health);
}

// ─── Streaming helpers ───────────────────────────────────────────────────────

async function handleStreaming(
  res: Response, subprocess: CursorSubprocess,
  prompt: string, model: string, requestId: string
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);
  res.flushHeaders();

  return new Promise<void>((resolve) => {
    let isFirst = true;
    let lastModel = model;
    let isComplete = false;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    res.on("close", () => {
      if (!isComplete) subprocess.kill();
      finish();
    });

    subprocess.on("content_delta", (delta: ContentDeltaEvent) => {
      if (delta.text && !res.writableEnded) {
        const chunk = createStreamChunk(requestId, lastModel, delta.text, isFirst);
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        isFirst = false;
      }
    });

    subprocess.on("result", (result: ResultEvent) => {
      isComplete = true;
      if (result.model) lastModel = result.model;
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(createDoneChunk(requestId, lastModel))}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      finish();
    });

    subprocess.on("error", (error: Error) => {
      console.error("[stream] Error:", error.message);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: { message: error.message, type: "server_error", code: null } })}\n\n`);
        res.end();
      }
      finish();
    });

    subprocess.on("close", (_code: number | null) => {
      if (!res.writableEnded && !isComplete) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
      finish();
    });

    subprocess.run(prompt).catch((err) => {
      console.error("[stream] Run error:", err);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err), type: "server_error", code: null } })}\n\n`);
        res.end();
      }
      finish();
    });
  });
}

async function handleNonStreaming(
  res: Response, subprocess: CursorSubprocess,
  prompt: string, model: string, requestId: string
): Promise<void> {
  return new Promise<void>((resolve) => {
    let finalResult: ResultEvent | null = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    subprocess.on("result", (result: ResultEvent) => { finalResult = result; });
    subprocess.on("error", (error: Error) => {
      console.error("[non-stream] Error:", error.message);
      if (!res.headersSent) res.status(500).json({ error: { message: error.message, type: "server_error", code: null } });
      finish();
    });

    subprocess.on("close", () => {
      if (finalResult) {
        if (!res.headersSent) {
          res.json(createChatResponse(requestId, finalResult.model || model, finalResult.text));
        }
      } else if (!res.headersSent) {
        res.status(500).json({ error: { message: "CLI exited without result", type: "server_error", code: null } });
      }
      finish();
    });

    subprocess.run(prompt).catch((error) => {
      if (!res.headersSent) {
        res.status(500).json({
          error: { message: error instanceof Error ? error.message : String(error), type: "server_error", code: null },
        });
      }
      finish();
    });
  });
}
