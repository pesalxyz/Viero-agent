/**
 * LLM provider/model abstraction.
 *
 * A single `LlmClient` interface backed by `OpenAiCompatibleClient`,
 * which talks to any OpenAI-compatible `/chat/completions` endpoint
 * (OpenRouter, LM Studio, vLLM, Ollama, etc.).
 *
 * Configuration is read from `VIERO_LLM_*` environment variables via
 * `readLlmConfig()`. Viero is an LLM-first product: an API key and a
 * reachable base URL are required. The base URL defaults to OpenRouter
 * so the typical "just give it an OpenRouter API key" workflow needs
 * only `VIERO_LLM_API_KEY`.
 *
 * Uses Node 20+ built-in `fetch`. No new npm packages are required.
 *
 * No trading, Telegram, or runtime-flow code is touched.
 */
import { z } from 'zod';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'openai/gpt-4o-mini';

const llmEnvSchema = z.object({
  VIERO_LLM_BASE_URL: z.string().min(1).optional(),
  VIERO_LLM_API_KEY: z.string().optional(),
  VIERO_LLM_MODEL: z.string().min(1).optional(),
  VIERO_LLM_MODEL_SCREENER: z.string().min(1).optional(),
  VIERO_LLM_MODEL_MANAGER: z.string().min(1).optional(),
  VIERO_LLM_MODEL_GENERAL: z.string().min(1).optional(),
  VIERO_LLM_TEMPERATURE: z.coerce.number().finite().min(0).max(2).optional(),
  VIERO_LLM_MAX_TOKENS: z.coerce.number().int().positive().optional(),
  VIERO_LLM_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
});

export type LlmToolChoice = 'auto' | 'required' | { name: string };

export type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type LlmTool = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

/**
 * Provider-agnostic chat request. The system prompt is a separate top-level
 * field so callers do not need to manage `system` role messages themselves.
 *
 * Either `model` or `role` should be set. When `role` is provided the
 * client resolves the model id from per-role env config; `model` is used
 * as a fallback when `role` is absent.
 */
export type ChatRequest = {
  model?: string;
  systemPrompt: string;
  messages: ChatMessage[];
  tools?: LlmTool[];
  toolChoice?: LlmToolChoice;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * Logical role key. The client resolves this to a model id using
   * the configured per-role overrides (`VIERO_LLM_MODEL_<ROLE>`) and
   * the default (`VIERO_LLM_MODEL`). Falls back to `model` when
   * `role` is not provided.
   */
  role?: Role;
};

export type ToolCall = {
  id: string;
  name: string;
  args: unknown;
};

export type ChatFinishReason = 'stop' | 'tool_calls' | 'length' | 'error';

export type ChatResponse = {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: ChatFinishReason;
  usage?: { promptTokens: number; completionTokens: number };
};

export type Role = 'SCREENER' | 'MANAGER' | 'GENERAL';

export type LlmConfig = {
  baseUrl: string;
  apiKey?: string;
  defaultModel: string;
  models: Record<Role, string>;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
};

export interface LlmClient {
  chat(req: ChatRequest): Promise<ChatResponse>;
  isEnabled(): boolean;
  providerLabel(): string;
}

/**
 * Parse and validate the `VIERO_LLM_*` environment variables.
 *
 * Required: `VIERO_LLM_API_KEY`. The base URL defaults to OpenRouter.
 * Throws `LLM_NOT_CONFIGURED` when the API key is missing.
 */
export function readLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const parsed = llmEnvSchema.parse(env);
  const apiKey = parsed.VIERO_LLM_API_KEY?.trim() || undefined;
  if (!apiKey) {
    throw new Error('LLM_NOT_CONFIGURED: VIERO_LLM_API_KEY is required');
  }
  const baseUrl = parsed.VIERO_LLM_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const defaultModel = parsed.VIERO_LLM_MODEL?.trim() || DEFAULT_MODEL;
  return {
    baseUrl,
    apiKey,
    defaultModel,
    models: {
      SCREENER: parsed.VIERO_LLM_MODEL_SCREENER?.trim() || defaultModel,
      MANAGER: parsed.VIERO_LLM_MODEL_MANAGER?.trim() || defaultModel,
      GENERAL: parsed.VIERO_LLM_MODEL_GENERAL?.trim() || defaultModel,
    },
    temperature: parsed.VIERO_LLM_TEMPERATURE ?? 0.2,
    maxTokens: parsed.VIERO_LLM_MAX_TOKENS ?? 1024,
    timeoutMs: parsed.VIERO_LLM_TIMEOUT_MS ?? 90_000,
  };
}

/**
 * Pick the right model id for a role using the per-role override → default
 * fallback chain. Pure function — safe to call repeatedly.
 */
export function modelForRole(config: LlmConfig, role: Role): string {
  return config.models[role] || config.defaultModel;
}

/**
 * Minimal OpenAI-compatible chat client.
 *
 * Uses Node 20+ built-in `fetch` — no SDK dependency. Only the fields Viero
 * needs (system prompt, messages, tools, tool_choice, temperature, max_tokens)
 * are sent; provider-specific extensions are ignored.
 *
 * Tool-call arguments are best-effort JSON-parsed; if the provider returns
 * malformed JSON we fall back to an empty object. Callers must validate
 * `toolCalls[].args` against their own zod schemas before acting on them.
 */
export class OpenAiCompatibleClient implements LlmClient {
  constructor(
    private readonly config: LlmConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  isEnabled(): boolean { return true; }
  providerLabel(): string { return `openai-compatible:${this.config.baseUrl}`; }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const resolvedModel = req.role ? modelForRole(this.config, req.role) : (req.model ?? this.config.defaultModel);
    const body: Record<string, unknown> = {
      model: resolvedModel,
      messages: [
        { role: 'system', content: req.systemPrompt },
        ...req.messages,
      ],
      temperature: req.temperature ?? this.config.temperature,
      max_tokens: req.maxTokens ?? this.config.maxTokens,
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = req.toolChoice ?? 'auto';
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.apiKey) headers['authorization'] = `Bearer ${this.config.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.model ? this.config.timeoutMs : this.config.timeoutMs);
    const signal = req.signal
      ? combineSignals(req.signal, controller.signal)
      : controller.signal;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const sanitized = sanitizeError(text);
      throw new Error(`LLM_HTTP_${response.status}: ${sanitized}`);
    }

    const payload = (await response.json()) as OpenAiChatCompletionResponse;
    return parseChatCompletion(payload);
  }
}

/**
 * Factory: read env, return an OpenAI-compatible client.
 *
 * Throws when `VIERO_LLM_API_KEY` is missing — Viero is LLM-first and
 * does not provide a disabled fallback path.
 */
export function createLlmClient(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): LlmClient {
  const config = readLlmConfig(env);
  return new OpenAiCompatibleClient(config, fetchImpl);
}

/** Error thrown when the LLM is invoked without required configuration. */
export const LLM_NOT_CONFIGURED_ERROR = 'LLM_NOT_CONFIGURED';

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted || b.aborted) {
    const ac = new AbortController();
    ac.abort();
    return ac.signal;
  }
  const ac = new AbortController();
  const onA = () => ac.abort();
  const onB = () => ac.abort();
  a.addEventListener('abort', onA, { once: true });
  b.addEventListener('abort', onB, { once: true });
  return ac.signal;
}

function sanitizeError(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, '[provider-url]')
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, '[redacted-key]')
    .slice(0, 200);
}

type OpenAiToolCall = {
  id: string;
  type: string;
  function?: { name?: string; arguments?: string };
};

type OpenAiChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: OpenAiToolCall[];
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

function parseChatCompletion(payload: OpenAiChatCompletionResponse): ChatResponse {
  const choice = payload.choices?.[0];
  if (!choice) {
    throw new Error(`LLM_NO_CHOICES: ${JSON.stringify(payload).slice(0, 200)}`);
  }
  const message = choice.message ?? {};
  const toolCalls: ToolCall[] = [];
  for (const tc of message.tool_calls ?? []) {
    if (tc.type !== 'function') continue;
    const fn = tc.function;
    if (!fn || !fn.name) continue;
    let args: unknown = {};
    const raw = fn.arguments ?? '';
    if (raw.length > 0) {
      try {
        args = JSON.parse(raw);
      } catch {
        args = {};
      }
    }
    toolCalls.push({ id: tc.id, name: fn.name, args });
  }
  const finishReason: ChatFinishReason = (() => {
    switch (choice.finish_reason) {
      case 'stop': return 'stop';
      case 'tool_calls': return 'tool_calls';
      case 'length': return 'length';
      case 'content_filter': return 'error';
      default: return 'error';
    }
  })();
  return {
    content: message.content ?? null,
    toolCalls,
    finishReason,
    usage: payload.usage
      ? {
          promptTokens: payload.usage.prompt_tokens ?? 0,
          completionTokens: payload.usage.completion_tokens ?? 0,
        }
      : undefined,
  };
}
