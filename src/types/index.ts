/**
 * OpenAI-compatible API types for the Cursor Gateway proxy.
 */

// ─── Request Types ───────────────────────────────────────────────────────────

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// ─── Response Types ──────────────────────────────────────────────────────────

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Choice[];
  usage: UsageInfo;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChunkChoice[];
}

export interface Choice {
  index: number;
  message: AssistantMessage;
  finish_reason: 'stop' | 'length' | 'tool_calls' | null;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
}

export interface ChunkChoice {
  index: number;
  delta: Delta;
  finish_reason: 'stop' | 'length' | null;
}

export interface Delta {
  role?: 'assistant';
  content?: string | null;
  tool_calls?: ToolCall[];
}

export interface UsageInfo {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ModelInfo {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

// ─── Cursor Dashboard Types ──────────────────────────────────────────────────

export interface CursorPlanUsage {
  totalSpend: number;
  bonusSpend: number;
  remainingBonus: boolean;
  bonusTooltip?: string;
  autoPercentUsed: number;
  apiPercentUsed: number;
  totalPercentUsed: number;
}

export interface CursorSpendLimitUsage {
  pooledLimit: number;
  pooledRemaining: number;
  individualLimit: number;
  limitType: string;
  overallLimit: number;
  overallRemaining: number;
}

export interface CursorUsageResponse {
  billingCycleStart: string;
  billingCycleEnd: string;
  planUsage: CursorPlanUsage;
  spendLimitUsage: CursorSpendLimitUsage;
  displayThreshold: number;
  displayMessage: string;
  autoModelSelectedDisplayMessage: string;
  namedModelSelectedDisplayMessage: string;
  autoBucketModels?: string[];
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  cursor_token_valid: boolean;
  token_email?: string;
  agent_cli_status: 'connected' | 'disconnected';
  port: number;
}

// ─── CLI Subprocess Types ────────────────────────────────────────────────────

export interface CliMessage {
  type: string;
  [key: string]: any;
}
