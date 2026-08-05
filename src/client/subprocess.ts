/**
 * Cursor CLI (agent) Subprocess Manager.
 *
 * Spawns `cursor-agent -p --mode ask --output-format stream-json --stream-partial-output`
 * and emits normalized events: content_delta, result, error, close.
 *
 * Supports two-phase use for warm pooling:
 *   prepare(options) → run(prompt)
 * Or one-shot:
 *   start(prompt, options)
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { existsSync } from "fs";

const IS_WIN = process.platform === "win32";
const DEFAULT_TIMEOUT = 300_000; // 5 minutes

export type AgentMode = "ask" | "plan" | "agent";

function resolveAgentMode(): AgentMode {
  const raw = (process.env.AGENT_MODE || "ask").toLowerCase();
  if (raw === "plan" || raw === "agent" || raw === "ask") return raw;
  return "ask";
}

// Try multiple possible agent CLI locations
function findAgentCli(): string {
  const paths = [
    process.env.CURSOR_AGENT_BIN,
    "/Users/lizhenhe/.local/share/cursor-agent/versions/2026.07.23-e383d2b/cursor-agent",
    "/Users/lizhenhe/.cursor-dev/resources/app/out/cursor-agent",
    "agent", // fallback to PATH
  ].filter(Boolean) as string[];

  for (const path of paths) {
    try {
      if (existsSync(path)) return path;
    } catch {}
  }
  return "agent";
}

export const AGENT_BIN = findAgentCli();
console.log(`[CursorGateway] Using agent CLI: ${AGENT_BIN}`);

export interface SubprocessOptions {
  model: string;
  apiKey?: string;
  cwd?: string;
  timeout?: number;
  /** Override AGENT_MODE for this spawn */
  mode?: AgentMode;
}

export interface ContentDeltaEvent {
  text: string;
}

export interface ResultEvent {
  text: string;
  model: string;
}

// CLI message types
interface SystemInit { type: "system"; model?: string; }
interface AssistantMsg { type: "assistant"; message: { content: Array<{ type: string; text?: string }> }; }
interface ToolCallMsg { type: "tool_call"; }
interface ResultMsg { type: "result"; result?: string; }
type CliMessage = SystemInit | AssistantMsg | ToolCallMsg | ResultMsg;

export function buildAgentArgs(options: SubprocessOptions): string[] {
  const mode = options.mode ?? resolveAgentMode();
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
  ];

  // ask/plan are read-only Q&A; agent mode keeps tool execution (--yolo/--force)
  if (mode === "ask" || mode === "plan") {
    args.push("--mode", mode, "--trust");
  } else {
    args.push("--yolo", "--trust");
  }

  if (options.model && options.model !== "auto") {
    args.push("--model", options.model);
  }
  return args;
}

export function buildAgentEnv(apiKey?: string): NodeJS.ProcessEnv {
  const agentDir = AGENT_BIN.includes("/") ? AGENT_BIN.split("/").slice(0, -1).join("/") : undefined;
  const env: NodeJS.ProcessEnv = agentDir
    ? { ...process.env, PATH: `${agentDir}:${process.env.PATH || ""}` }
    : { ...process.env };

  if (apiKey) {
    env.CURSOR_API_KEY = apiKey;
  } else {
    delete env.CURSOR_API_KEY;
  }
  return env;
}

export class CursorSubprocess extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer = "";
  private timeoutId: NodeJS.Timeout | null = null;
  private isKilled = false;
  private detectedModel = "cursor-auto";
  private turnBuffer = "";
  private prepared = false;
  private running = false;
  private options: SubprocessOptions | null = null;

  /** Model this worker was prepared with (for pool matching). */
  get model(): string {
    return this.options?.model || "auto";
  }

  get apiKey(): string | undefined {
    return this.options?.apiKey;
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }

  get isPrepared(): boolean {
    return this.prepared && !this.running && !this.isKilled && !!this.process;
  }

  /**
   * Spawn the agent and leave stdin open (warm idle).
   * Call `run(prompt)` later to feed the prompt.
   */
  async prepare(options: SubprocessOptions): Promise<void> {
    if (this.prepared || this.process) {
      throw new Error("Subprocess already prepared");
    }
    this.options = options;
    const args = buildAgentArgs(options);
    const env = buildAgentEnv(options.apiKey);

    return new Promise<void>((resolve, reject) => {
      try {
        console.log(`[subprocess] Preparing: ${AGENT_BIN} ${args.join(" ")}`);

        this.process = spawn(AGENT_BIN, args, {
          cwd: options.cwd ?? process.cwd(),
          env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: IS_WIN,
        });

        this.process.on("error", (err) => {
          this.clearTimer();
          this.prepared = false;
          if (!this.running) {
            reject(new Error(`Failed to start agent: ${err.message}`));
          } else {
            this.emit("error", new Error(`Failed to start agent: ${err.message}`));
          }
        });

        this.process.stdout?.on("data", (chunk: Buffer) => {
          this.buffer += chunk.toString();
          this.processBuffer();
        });

        this.process.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString().trim();
          if (text) console.log(`[subprocess stderr] ${text.slice(0, 500)}`);
        });

        this.process.on("close", (code) => {
          this.clearTimer();
          if (this.buffer.trim()) this.processBuffer();
          this.prepared = false;
          this.running = false;
          this.emit("close", code);
        });

        this.prepared = true;
        // Resolve on next tick so the process is actually spawned
        setImmediate(() => resolve());
      } catch (err) {
        this.clearTimer();
        reject(err);
      }
    });
  }

  /**
   * Feed prompt into a prepared worker and start the request timeout.
   */
  async run(prompt: string): Promise<void> {
    if (!this.process || !this.prepared) {
      throw new Error("Subprocess not prepared; call prepare() first");
    }
    if (this.running) {
      throw new Error("Subprocess already running");
    }

    const timeout = this.options?.timeout ?? DEFAULT_TIMEOUT;
    this.running = true;
    this.isKilled = false;
    this.turnBuffer = "";
    this.detectedModel = this.options?.model && this.options.model !== "auto"
      ? this.options.model
      : "cursor-auto";

    this.timeoutId = setTimeout(() => {
      if (!this.isKilled) {
        this.isKilled = true;
        this.process?.kill("SIGTERM");
        this.emit("error", new Error(`Request timed out after ${timeout}ms`));
      }
    }, timeout);

    this.process.stdin?.write(prompt);
    this.process.stdin?.end();
  }

  /** One-shot: prepare + run (fallback when pool is unavailable). */
  async start(prompt: string, options: SubprocessOptions): Promise<void> {
    await this.prepare(options);
    await this.run(prompt);
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg: CliMessage = JSON.parse(trimmed);
        this.handleMessage(msg);
      } catch { /* skip malformed JSON */ }
    }
  }

  private handleMessage(msg: CliMessage): void {
    if (msg.type === "system" && (msg as SystemInit).model) {
      this.detectedModel = (msg as SystemInit).model!;
      return;
    }

    if (msg.type === "assistant") {
      const text = (msg as AssistantMsg).message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      if (!text) return;
      if (text === this.turnBuffer) return;
      if (text.startsWith(this.turnBuffer)) {
        const diff = text.slice(this.turnBuffer.length);
        if (diff) this.emit("content_delta", { text: diff });
        this.turnBuffer = text;
        return;
      }
      this.emit("content_delta", { text });
      this.turnBuffer += text;
      return;
    }

    if (msg.type === "tool_call") {
      this.turnBuffer = "";
      return;
    }

    if (msg.type === "result") {
      this.emit("result", {
        text: (msg as ResultMsg).result ?? "",
        model: this.detectedModel,
      });
      return;
    }
  }

  private clearTimer(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  kill(): void {
    if (!this.isKilled && this.process) {
      this.isKilled = true;
      this.clearTimer();
      this.process.kill("SIGTERM");
    }
  }
}

export async function verifyCursorCli(): Promise<{ ok: boolean; error?: string; version?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(AGENT_BIN, ["--version"], { stdio: "pipe", shell: IS_WIN });
    let output = "";
    proc.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    proc.on("error", () => resolve({ ok: false, error: `agent not found at ${AGENT_BIN}` }));
    proc.on("close", (code) => {
      if (code === 0) resolve({ ok: true, version: output.trim() });
      else resolve({ ok: false, error: `agent exited with code ${code}` });
    });
  });
}
