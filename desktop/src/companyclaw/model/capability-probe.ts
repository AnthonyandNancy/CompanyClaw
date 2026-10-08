/**
 * Model capability probing.
 *
 * Requirement V1.1 P2 / F2 requires unknown model capabilities to be measured
 * rather than assumed: a model that cannot call tools, or cannot see images,
 * must not be treated as if it could. The probe therefore exercises the real
 * API with a tool-calling request and reports an explicit verdict.
 *
 * Three-valued results are used deliberately: `unknown` is not `unsupported`,
 * and neither is `supported`. Callers must not collapse them.
 */

export type CapabilityVerdict = "supported" | "unsupported" | "unknown";

export interface ModelCapabilities {
  toolCalls: CapabilityVerdict;
  vision: CapabilityVerdict;
  reasoning: CapabilityVerdict;
  structuredOutput: CapabilityVerdict;
  probedAt: string;
  error?: string;
  errorDetail?: string;
}

export interface CapabilityProbeInput {
  baseUrl: string;
  model: string;
  apiFormat: "openai-chat" | "openai-responses" | "anthropic";
}

export interface CapabilityProbeRequest {
  url: string;
  method: "POST";
  body: string;
}

const PROBE_TOOL_NAME = "probe_echo";

/**
 * Builds the probe request. It asks for a tool call so the response proves
 * whether tool calling actually works, rather than whether the endpoint merely
 * answers. No credential is placed in the body: the key travels in a header.
 */
export function buildCapabilityProbeRequest(
  input: CapabilityProbeInput,
): CapabilityProbeRequest {
  const base = input.baseUrl.replace(/\/+$/, "");
  const endpoint =
    input.apiFormat === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
  const body = {
    model: input.model,
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: `Call the ${PROBE_TOOL_NAME} tool with value "ok". Do not answer in prose.`,
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: PROBE_TOOL_NAME,
          description: "Echo a value back. Used to verify tool calling support.",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        },
      },
    ],
  };
  return {
    url: `${base}${endpoint}`,
    method: "POST",
    body: JSON.stringify(body),
  };
}

export interface CapabilityProbeResponse {
  status: number;
  body: string;
}

function errorForStatus(status: number): { error: string; detail?: string } | null {
  switch (status) {
    case 200:
      return null;
    case 401:
      return { error: "unauthorized" };
    case 402:
      return { error: "insufficient-quota" };
    case 403:
      return { error: "forbidden" };
    case 429:
      return { error: "rate-limited" };
    default:
      if (status >= 500) return { error: "server-error", detail: `HTTP ${status}` };
      if (status >= 400) return { error: "request-rejected", detail: `HTTP ${status}` };
      return { error: "unexpected-status", detail: `HTTP ${status}` };
  }
}

/**
 * Interprets the probe response. A request that failed tells us nothing about
 * the model, so capabilities stay `unknown` rather than becoming `unsupported`.
 */
export function interpretCapabilityProbe(response: CapabilityProbeResponse): ModelCapabilities {
  const base: ModelCapabilities = {
    toolCalls: "unknown",
    vision: "unknown",
    reasoning: "unknown",
    structuredOutput: "unknown",
    probedAt: new Date().toISOString(),
  };

  const failure = errorForStatus(response.status);
  if (failure) {
    return {
      ...base,
      error: failure.error,
      ...(failure.detail ? { errorDetail: failure.detail } : {}),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return base;
  }
  if (typeof parsed !== "object" || parsed === null) return base;

  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return base;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return base;
  const message = (first as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return base;

  const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
  const hasToolCall = Array.isArray(toolCalls) && toolCalls.length > 0;
  return { ...base, toolCalls: hasToolCall ? "supported" : "unsupported" };
}

function verdictLabel(verdict: CapabilityVerdict, supported: string, unsupported: string): string {
  switch (verdict) {
    case "supported":
      return supported;
    case "unsupported":
      return unsupported;
    default:
      // `unknown` must never be shown as if it were a capability.
      return "未验证（不可假定可用）";
  }
}

/** Human-readable summary. `unknown` is always stated, never implied away. */
export function summarizeCapabilities(capabilities: ModelCapabilities): string {
  const lines = [
    `工具调用：${verdictLabel(capabilities.toolCalls, "支持", "不支持")}`,
    `图片理解：${verdictLabel(capabilities.vision, "支持", "不支持")}`,
    `推理模式：${verdictLabel(capabilities.reasoning, "支持", "不支持")}`,
    `结构化输出：${verdictLabel(capabilities.structuredOutput, "支持", "不支持")}`,
  ];
  if (capabilities.error) {
    lines.push(
      `探测失败：${capabilities.error}${capabilities.errorDetail ? `（${capabilities.errorDetail}）` : ""}`,
    );
  }
  lines.push(`探测时间：${capabilities.probedAt}`);
  return lines.join("\n");
}
