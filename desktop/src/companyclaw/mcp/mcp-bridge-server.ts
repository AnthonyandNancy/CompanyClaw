/**
 * The MCP server OpenClaw actually launches.
 *
 * OpenClaw starts this file as a child process and speaks MCP over its stdio.
 * The process is deliberately thin: it forwards `tools/call` to the running
 * CompanyClaw main process over loopback, because that is where the permission
 * document, the task store and the policy engine live. Duplicating them here
 * would create a second source of truth for who may do what — exactly the
 * failure this project has already ruled out.
 *
 * The consequence worth understanding: **tools only work while CompanyClaw is
 * running**, which is correct. The desktop application *is* the executor; a
 * bridge that could drive the machine with the app closed would be an unreviewed
 * control path with no UI, no approvals and no audit.
 *
 * Discovery (`tools/list`) is answered locally from the shared tool definitions,
 * so the model sees the tool surface even when the main process is unreachable —
 * and a call then fails with a readable reason instead of the tools vanishing.
 */
import * as http from "node:http";

const PORT = Number(process.env.COMPANYCLAW_MCP_PORT ?? "0");
const TOKEN = process.env.COMPANYCLAW_MCP_TOKEN ?? "";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

const TOOL_DEFINITIONS: { name: string; description: string; inputSchema: unknown }[] = [
  tool("list-installed-apps", "列出本机已安装的应用（显示名）。用于发现可打开的程序，无需用户提供路径。", {}),
  tool("launch-app", "打开一个已安装的应用。只能按显示名打开，不接受路径或命令参数。", {
    app: { type: "string", description: "已安装应用的显示名，不接受路径" },
  }, ["app"]),
  tool("list-windows", "列出当前用户会话中的窗口（标题、进程、是否可见）。", {}),
  tool("focus-window", "把指定窗口切到前台。会先核对窗口与进程身份，避免操作到错误窗口。", {
    windowTitle: { type: "string" },
    processName: { type: "string" },
  }),
  tool("snapshot-ui-tree", "读取目标窗口的界面元素树（按钮、输入框、列表等），用于定位可操作控件。", {
    windowTitle: { type: "string" },
  }),
  tool("find-control", "按名称或角色查找控件。返回的引用有有效期，窗口变化后会失效。", {
    label: { type: "string" },
    windowTitle: { type: "string" },
  }, ["label"]),
  tool("read-control", "读取控件当前的值或状态。", {
    label: { type: "string" },
    windowTitle: { type: "string" },
  }, ["label"]),
  tool("click", "在指定坐标点击。坐标必须来自最近一次界面读取，执行前会复核窗口未变化。", {
    x: { type: "number" },
    y: { type: "number" },
    windowTitle: { type: "string" },
    clicks: { type: "number", description: "0=悬停，1=单击，2=双击" },
  }, ["x", "y"]),
  tool("type-text", "向已聚焦的输入控件输入文本，支持中文与中英混输。", {
    text: { type: "string" },
    windowTitle: { type: "string" },
    clear: { type: "boolean" },
    pressEnter: { type: "boolean" },
  }, ["text"]),
  tool("hotkey", "执行常用快捷键（如 ctrl+c、ctrl+v）。只能在支持列表内选择。", {
    keys: { type: "string" },
  }, ["keys"]),
  tool("scroll", "在目标窗口或控件范围内滚动，用于浏览长列表或长文本。", {
    x: { type: "number" },
    y: { type: "number" },
    direction: { type: "string", enum: ["up", "down", "left", "right"] },
    wheelTimes: { type: "number" },
    windowTitle: { type: "string" },
  }),
  tool("drag-drop", "把文件或元素从一处拖到另一处。必须同时给出来源与目标窗口，任一不明确都会拒绝。", {
    from: { type: "array", items: { type: "number" } },
    to: { type: "array", items: { type: "number" } },
    sourceWindow: { type: "string" },
    targetWindow: { type: "string" },
  }, ["from", "to", "sourceWindow", "targetWindow"]),
  tool("screenshot", "截取目标窗口的图像。仅在需要视觉识别且已获得视觉授权时可用。", {}),
  tool("wait-for-condition", "等待文本、窗口或控件出现，带时间上限，不会无限等待。", {
    text: { type: "string" },
    windowTitle: { type: "string" },
    timeoutSeconds: { type: "number" },
  }),
  tool("inspect-dialog", "读取普通弹窗与错误提示。Windows 安全桌面（UAC）不可交互，会被拒绝。", {
    windowTitle: { type: "string" },
  }),
  tool("verify-state", "执行后回读目标窗口、控件或文件状态，用于确认动作真的发生了。", {
    windowTitle: { type: "string" },
  }),
];

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): { name: string; description: string; inputSchema: unknown } {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
  };
}

function write(message: JsonRpcMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function forward(name: string, args: Record<string, unknown>): Promise<{ text: string; ok: boolean }> {
  return new Promise((resolve) => {
    if (!PORT || !TOKEN) {
      resolve({ ok: false, text: "CompanyClaw 未运行：无法执行电脑操作（缺少本地执行端点）" });
      return;
    }
    const payload = JSON.stringify({ name, arguments: args });
    const request = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: "/tool-call",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "X-CompanyClaw-Token": TOKEN,
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(body) as { ok?: boolean; text?: string };
            resolve({ ok: parsed.ok === true, text: parsed.text ?? "" });
          } catch {
            resolve({ ok: false, text: "CompanyClaw 返回了无法解析的结果" });
          }
        });
      },
    );
    request.on("error", (error) => {
      // The app closing mid-call is the ordinary case here, so it is reported as
      // a readable refusal rather than as a crash.
      resolve({
        ok: false,
        text: `CompanyClaw 未响应：${error.message}（请确认桌面应用正在运行）`,
      });
    });
    request.write(payload);
    request.end();
  });
}

async function handle(message: JsonRpcMessage): Promise<void> {
  const method = message.method;
  if (method === "initialize") {
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "companyclaw-computer-use", version: "1.0.0" },
        instructions:
          "CompanyClaw 电脑操作工具：可打开已安装应用、读取界面元素、点击、输入、滚动与拖拽。" +
          "所有调用都经过本机权限判定；敏感操作需要用户确认，被拒绝时不要重试同一动作。",
      },
    });
    return;
  }
  if (method?.startsWith("notifications/")) return;
  if (method === "ping") {
    write({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (method === "tools/list") {
    write({ jsonrpc: "2.0", id: message.id, result: { tools: TOOL_DEFINITIONS } });
    return;
  }
  if (method === "tools/call") {
    const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
    const name = typeof params.name === "string" ? params.name : "";
    if (!name) {
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: "tools/call requires a tool name" },
      });
      return;
    }
    const args =
      typeof params.arguments === "object" && params.arguments !== null
        ? (params.arguments as Record<string, unknown>)
        : {};
    const result = await forward(name, args);
    if (result.ok) {
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: result.text }] },
      });
    } else {
      // A refusal is a result, not a protocol error: the model must see the
      // reason so it can adapt instead of retrying the same rejected action.
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: { isError: true, content: [{ type: "text", text: result.text }] },
      });
    }
    return;
  }
  write({
    jsonrpc: "2.0",
    ...(message.id !== undefined ? { id: message.id } : {}),
    error: { code: -32601, message: `unsupported method: ${String(method)}` },
  });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    const trimmed = line.trim();
    if (trimmed) {
      try {
        void handle(JSON.parse(trimmed) as JsonRpcMessage);
      } catch {
        write({ jsonrpc: "2.0", error: { code: -32700, message: "invalid JSON frame" } });
      }
    }
  }
});
// stdin closing means the parent went away; exiting keeps this from outliving it.
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
