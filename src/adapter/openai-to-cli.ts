/**
 * OpenAI -> Cursor CLI prompt converter.
 */

import type { ChatCompletionRequest } from "../types/index.js";

const KNOWN_MODELS = new Set([
  "auto", "composer-1.5", "composer-1",
  "opus-4.6-thinking", "opus-4.6", "opus-4.5-thinking", "opus-4.5",
  "sonnet-4.5-thinking", "sonnet-4.5",
  "gpt-5.3-codex", "gpt-5.3-codex-low", "gpt-5.3-codex-high", "gpt-5.3-codex-xhigh", "gpt-5.3-codex-fast",
  "gpt-5.3-codex-low-fast", "gpt-5.3-codex-high-fast", "gpt-5.3-codex-xhigh-fast",
  "gpt-5.2", "gpt-5.2-codex", "gpt-5.2-codex-high", "gpt-5.2-codex-low", "gpt-5.2-codex-xhigh",
  "gpt-5.1-codex-max", "gemini-3-pro", "gemini-3-flash", "grok",
  "composer-2.5", "composer-2", "composer-2-fast", "composer-2.5-fast",
  "vega", "vega-medium", "vega-high", "vega-xhigh",
  "vega-fast-medium", "vega-fast-high", "vega-fast-xhigh",
  "grok-4.5", "cursor-grok-4.5-low", "cursor-grok-4.5-medium", "cursor-grok-4.5-high",
  "cursor-grok-4.5-low-fast", "cursor-grok-4.5-medium-fast", "cursor-grok-4.5-high-fast",
  "grok-4.5-medium", "grok-4.5-fast-medium",
  "grok-4.5-high", "grok-4.5-fast-high",
  "grok-4.5-xhigh", "grok-4.5-fast-xhigh",
]);

/**
 * Normalize a model string to a known CLI model name.
 * Handles various input formats:
 *   - "auto" / "default" → "auto"
 *   - "cursor/composer-2" → "composer-2"
 *   - "cursor-composer-2" → "composer-2"
 *   - "composer-2" → "composer-2" (exact match)
 *   - "gpt-4" → "auto" (unknown model falls back)
 */
export function extractModel(model: string): string {
  if (!model) return "auto";
  const raw = model.trim();

  // Direct match
  if (KNOWN_MODELS.has(raw)) return raw;

  // Handle "cursor/xxx" or "cursor_xxx" or "cursor-xxx" prefix
  for (const prefix of ["cursor/", "cursor_", "cursor-"]) {
    if (raw.toLowerCase().startsWith(prefix)) {
      const rest = raw.slice(prefix.length);
      if (rest && KNOWN_MODELS.has(rest)) return rest;
      if (rest) return rest; // Return as-is even if unknown
    }
  }

  // Handle "claude-xxx" → map to opus/sonnet
  const claudeMap: Record<string, string> = {
    "claude-sonnet-4.5": "sonnet-4.5",
    "claude-opus-4.5": "opus-4.5",
    "claude-3.5-sonnet": "sonnet-4.5",
    "claude-3.5-haiku": "auto",
    "claude-3-opus": "opus-4.6",
  };
  const lower = raw.toLowerCase();
  if (claudeMap[lower]) return claudeMap[lower];

  // Handle "gpt-xxx" → map to gpt variants
  const gptMap: Record<string, string> = {
    "gpt-4o": "gpt-5.3-codex",
    "gpt-4o-mini": "gpt-5.3-codex-low",
    "gpt-4": "gpt-5.2",
    "gpt-3.5-turbo": "auto",
  };
  if (gptMap[lower]) return gptMap[lower];

  // Handle "llama" models
  if (lower.startsWith("llama")) return "grok";

  // Handle "default" as "auto"
  if (raw.toLowerCase() === "default") return "auto";

  // Fallback to auto
  return "auto";
}

export function openaiToCli(request: ChatCompletionRequest): CliInput {
  const messages = request.messages.filter(m => {
    const text = typeof m.content === "string" ? m.content :
      m.content?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
    return text.length > 0;
  });

  if (messages.length === 1 && messages[0].role === "user") {
    return { prompt: typeof messages[0].content === "string" ? messages[0].content : "", model: extractModel(request.model || "auto") };
  }

  const parts: string[] = [];
  for (const msg of messages) {
    const text = typeof msg.content === "string" ? msg.content :
      msg.content?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
    switch (msg.role) {
      case "system": parts.push(`[System]\n${text}`); break;
      case "user": parts.push(`[User]\n${text}`); break;
      case "assistant": parts.push(`[Assistant]\n${text}`); break;
    }
  }
  return { prompt: parts.join("\n\n"), model: extractModel(request.model || "auto") };
}
