import { describe, expect, it } from "vitest";
import {
  buildCapabilityProbeRequest,
  interpretCapabilityProbe,
  summarizeCapabilities,
  type ModelCapabilities,
} from "./capability-probe";

describe("buildCapabilityProbeRequest", () => {
  it("asks for a tool call so the probe exercises the real capability", () => {
    const request = buildCapabilityProbeRequest({
      baseUrl: "https://api.example.com",
      model: "some-model",
      apiFormat: "openai-chat",
    });
    const body = JSON.parse(request.body) as {
      model: string;
      tools?: unknown[];
      messages: unknown[];
    };
    expect(body.model).toBe("some-model");
    expect(Array.isArray(body.tools)).toBe(true);
    expect((body.tools ?? []).length).toBeGreaterThan(0);
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it("posts to the chat completions endpoint of the supplied base url", () => {
    const request = buildCapabilityProbeRequest({
      baseUrl: "https://api.example.com",
      model: "m",
      apiFormat: "openai-chat",
    });
    expect(request.url).toBe("https://api.example.com/v1/chat/completions");
  });

  it("never embeds a key in the body", () => {
    const request = buildCapabilityProbeRequest({
      baseUrl: "https://api.example.com",
      model: "m",
      apiFormat: "openai-chat",
    });
    expect(request.body).not.toContain("api");
    expect(request.body.toLowerCase()).not.toContain("apikey");
  });
});

describe("interpretCapabilityProbe", () => {
  it("reports tool calls as supported when the model returns one", () => {
    const capabilities = interpretCapabilityProbe({
      status: 200,
      body: JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [
                { id: "call_1", function: { name: "probe_echo", arguments: '{"value":"ok"}' } },
              ],
            },
          },
        ],
      }),
    });
    expect(capabilities.toolCalls).toBe("supported");
    expect(capabilities.error).toBeUndefined();
  });

  it("reports tool calls as unsupported when the model only chats", () => {
    const capabilities = interpretCapabilityProbe({
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: "hello" } }] }),
    });
    expect(capabilities.toolCalls).toBe("unsupported");
  });

  it("reports tool calls as unknown when the response shape is unexpected", () => {
    expect(interpretCapabilityProbe({ status: 200, body: "{}" }).toolCalls).toBe("unknown");
    expect(interpretCapabilityProbe({ status: 200, body: "not json" }).toolCalls).toBe("unknown");
  });

  it("maps authentication and quota failures to explicit errors", () => {
    expect(interpretCapabilityProbe({ status: 401, body: "" }).error).toBe("unauthorized");
    expect(interpretCapabilityProbe({ status: 403, body: "" }).error).toBe("forbidden");
    expect(interpretCapabilityProbe({ status: 429, body: "" }).error).toBe("rate-limited");
    expect(interpretCapabilityProbe({ status: 402, body: "" }).error).toBe("insufficient-quota");
  });

  it("maps other server failures to a generic error carrying the status", () => {
    const result = interpretCapabilityProbe({ status: 500, body: "" });
    expect(result.error).toBe("server-error");
    expect(result.errorDetail).toContain("500");
  });

  it("reports nothing as supported when the request failed", () => {
    const result = interpretCapabilityProbe({ status: 401, body: "" });
    expect(result.toolCalls).toBe("unknown");
  });
});

describe("summarizeCapabilities", () => {
  const base: ModelCapabilities = {
    toolCalls: "supported",
    vision: "unknown",
    reasoning: "unknown",
    structuredOutput: "unknown",
    probedAt: "2026-10-09T00:00:00.000Z",
  };

  it("states tool support explicitly", () => {
    expect(summarizeCapabilities(base)).toContain("工具调用：支持");
  });

  it("warns that an unprobed capability must not be assumed", () => {
    const text = summarizeCapabilities(base);
    expect(text).toContain("未验证");
  });

  it("surfaces an error instead of implying support", () => {
    const text = summarizeCapabilities({ ...base, toolCalls: "unknown", error: "unauthorized" });
    expect(text).toContain("unauthorized");
  });

  it("says vision is unsupported rather than guessing when it is known to be", () => {
    expect(summarizeCapabilities({ ...base, vision: "unsupported" })).toContain("图片理解：不支持");
  });
});
