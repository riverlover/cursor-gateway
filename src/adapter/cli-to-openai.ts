/**
 * Cursor CLI output -> OpenAI response converter.
 */

export function createStreamChunk(requestId: string, model: string, text: string, isFirst: boolean): any {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: { role: isFirst ? "assistant" : undefined, content: text },
      finish_reason: null,
    }],
  };
}

export function createDoneChunk(requestId: string, model: string): any {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
}

export function createChatResponse(requestId: string, model: string, text: string): any {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
