/**
 * Warm agent CLI process pool.
 *
 * Keeps N prepared `cursor-agent -p --mode ask` processes with stdin open.
 * On acquire, feeds the prompt into a warm worker; after the process exits,
 * immediately spawns a replacement to keep the pool warm.
 */

import { CursorSubprocess } from "./subprocess.js";
import type { SubprocessOptions } from "./subprocess.js";

export interface AgentPoolStats {
  size: number;
  idle: number;
  pending: number;
  inFlight: number;
}

interface Waiter {
  model: string;
  apiKey?: string;
  resolve: (worker: CursorSubprocess) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_POOL_SIZE = 1;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 60_000;
const DEFAULT_WARM_MODEL = "auto";

export class AgentPool {
  private readonly targetSize: number;
  private readonly acquireTimeoutMs: number;
  private readonly warmModel: string;
  private readonly idle: CursorSubprocess[] = [];
  private readonly waiters: Waiter[] = [];
  private inFlight = 0;
  private started = false;
  private stopped = false;
  private refilling = 0;

  constructor(opts?: { size?: number; acquireTimeoutMs?: number; warmModel?: string }) {
    this.targetSize = Math.max(
      1,
      opts?.size ?? parseInt(process.env.AGENT_POOL_SIZE || String(DEFAULT_POOL_SIZE), 10)
    );
    this.acquireTimeoutMs = opts?.acquireTimeoutMs
      ?? parseInt(process.env.AGENT_ACQUIRE_TIMEOUT_MS || String(DEFAULT_ACQUIRE_TIMEOUT_MS), 10);
    this.warmModel = opts?.warmModel || process.env.AGENT_WARM_MODEL || DEFAULT_WARM_MODEL;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    console.log(
      `[agent-pool] Warming ${this.targetSize} worker(s) model=${this.warmModel} mode=${process.env.AGENT_MODE || "ask"}`
    );
    await this.warmup();
    console.log(`[agent-pool] Ready idle=${this.idle.length}/${this.targetSize}`);
  }

  async warmup(): Promise<void> {
    const missing = this.targetSize - this.idle.length - this.refilling;
    if (missing <= 0) return;
    await Promise.all(Array.from({ length: missing }, () => this.spawnIdle(this.warmModel)));
  }

  stats(): AgentPoolStats {
    return {
      size: this.targetSize,
      idle: this.idle.filter((w) => w.isPrepared).length,
      pending: this.waiters.length,
      inFlight: this.inFlight,
    };
  }

  /**
   * Borrow a warm worker. Prefers idle workers matching model and apiKey.
   * Falls back to spawning on demand; queues when at capacity.
   */
  async acquire(options: SubprocessOptions): Promise<CursorSubprocess> {
    if (this.stopped) {
      throw new Error("Agent pool is stopped");
    }

    const model = options.model || "auto";
    const apiKey = options.apiKey;

    // Dedicated path for custom API keys — never share pooled OAuth workers
    if (apiKey) {
      const worker = new CursorSubprocess();
      await worker.prepare({ ...options, model, apiKey });
      this.inFlight++;
      return worker;
    }

    // Prefer exact idle match
    const idx = this.idle.findIndex(
      (w) => w.isPrepared && w.model === model && !w.apiKey
    );
    if (idx >= 0) {
      const [worker] = this.idle.splice(idx, 1);
      this.inFlight++;
      this.scheduleRefill();
      return worker!;
    }

    // Warm auto worker can serve "auto" only; other models spawn fresh if capacity allows
    const canSpawnNow = this.inFlight + this.idle.length + this.refilling < this.targetSize * 2
      || this.idle.length === 0;

    if (canSpawnNow) {
      const worker = new CursorSubprocess();
      await worker.prepare({ ...options, model });
      this.inFlight++;
      return worker;
    }

    // Queue until a slot frees / idle appears
    return new Promise<CursorSubprocess>((resolve, reject) => {
      const waiter: Waiter = {
        model,
        apiKey,
        resolve: (worker) => {
          this.inFlight++;
          resolve(worker);
        },
        reject,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error(`Agent pool acquire timed out after ${this.acquireTimeoutMs}ms`));
        }, this.acquireTimeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /**
   * After a request finishes (process exits or was killed), refill the warm pool.
   */
  release(worker: CursorSubprocess): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    // Process is single-use; ensure it's dead
    if (worker.isPrepared || worker.pid) {
      worker.kill();
    }
    this.scheduleRefill();
    this.pumpWaiters();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error("Agent pool stopped"));
    }
    this.waiters.length = 0;
    for (const w of this.idle) {
      w.kill();
    }
    this.idle.length = 0;
    this.started = false;
    console.log("[agent-pool] Stopped");
  }

  private scheduleRefill(): void {
    if (this.stopped) return;
    const need = this.targetSize - this.idle.length - this.refilling;
    for (let i = 0; i < need; i++) {
      void this.spawnIdle(this.warmModel);
    }
  }

  private async spawnIdle(model: string): Promise<void> {
    if (this.stopped) return;
    this.refilling++;
    try {
      const worker = new CursorSubprocess();
      await worker.prepare({ model });

      // If process dies while idle, drop it and refill
      worker.on("close", () => {
        const i = this.idle.indexOf(worker);
        if (i >= 0) {
          this.idle.splice(i, 1);
          this.scheduleRefill();
        }
      });

      if (this.stopped) {
        worker.kill();
        return;
      }

      // Prefer waking a waiter that matches this model
      const waiterIdx = this.waiters.findIndex((w) => !w.apiKey && w.model === model);
      if (waiterIdx >= 0) {
        const [waiter] = this.waiters.splice(waiterIdx, 1);
        clearTimeout(waiter!.timer);
        waiter!.resolve(worker);
        return;
      }

      this.idle.push(worker);
      this.pumpWaiters();
    } catch (err) {
      console.error("[agent-pool] Failed to spawn idle worker:", err);
      // Retry shortly
      if (!this.stopped) {
        setTimeout(() => this.scheduleRefill(), 2000);
      }
    } finally {
      this.refilling = Math.max(0, this.refilling - 1);
    }
  }

  private pumpWaiters(): void {
    while (this.waiters.length > 0 && this.idle.length > 0) {
      const waiter = this.waiters[0]!;
      const idx = this.idle.findIndex(
        (w) => w.isPrepared && w.model === waiter.model && !w.apiKey
      );
      if (idx < 0) break;
      this.waiters.shift();
      const [worker] = this.idle.splice(idx, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(worker!);
      this.scheduleRefill();
    }
  }
}

/** Process-wide singleton used by the gateway. */
let sharedPool: AgentPool | null = null;

export function getAgentPool(): AgentPool {
  if (!sharedPool) {
    sharedPool = new AgentPool();
  }
  return sharedPool;
}

export function setAgentPool(pool: AgentPool | null): void {
  sharedPool = pool;
}
