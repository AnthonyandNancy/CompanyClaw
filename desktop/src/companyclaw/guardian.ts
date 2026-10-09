import type { CapabilityVerdict } from "./model/capability-probe";

/**
 * Per-component health report for the first-run wizard and the logs.
 *
 * A single "everything is fine" flag cannot tell a user which part of the
 * installation is broken, and the failures differ: a missing Gateway token, a
 * model that cannot call tools and a WeChat channel that never loaded all look
 * identical from the outside while needing different fixes. Each item is
 * therefore reported separately, and "not measured yet" stays distinct from
 * "measured and broken".
 */

export type GuardianItemId =
  | "gateway-process"
  | "gateway-auth"
  | "runtime-manifest"
  | "plugin-installed"
  | "broker-runtime"
  | "browser-binary"
  | "model-reply"
  | "tool-call";

export type GuardianItemState = "ok" | "degraded" | "failed" | "blocked" | "unknown";

export interface GuardianItem {
  id: GuardianItemId;
  state: GuardianItemState;
  /** Plain-text detail, safe to show to an employee. */
  detail: string;
}

export interface GuardianReport {
  /** Worst state across the components the installation itself provides. */
  overall: GuardianItemState;
  items: GuardianItem[];
}

/**
 * Items that describe the machine's own state rather than something the user
 * has yet to configure.
 *
 * The model probe needs an API key and the WeChat account needs a QR scan, so
 * leaving them out of `overall` is what lets the first wizard step say "the
 * local runtime is ready" without pretending the user already finished.
 */
const ENVIRONMENT_ITEM_IDS: readonly GuardianItemId[] = [
  "gateway-process",
  "gateway-auth",
  "runtime-manifest",
  "plugin-installed",
  "broker-runtime",
  "browser-binary",
];

/** What the host can measure right now; every field is optional on purpose. */
export interface GuardianProbes {
  gatewayStatus?: string;
  gatewayConnected?: boolean;
  manifestProblems?: string[];
  manifestChecked?: number | null;
  pluginInstalled?: boolean;
  pluginEnabled?: boolean;
  pluginLoggedIn?: boolean;
  brokerNodePath?: string | null;
  brokerRunning?: boolean;
  brokerFailureReason?: string | null;
  browserExecutable?: string | null;
  /** Result of the model probe, when one has been run. */
  modelCapability?: CapabilityVerdict | null;
}

const SEVERITY: Record<GuardianItemState, number> = {
  ok: 0,
  unknown: 1,
  degraded: 2,
  blocked: 3,
  failed: 4,
};

/**
 * `pluginLoggedIn` and the two model items are deliberately not part of
 * "ready": a machine that is installed correctly can still have no WeChat
 * account bound and no API key entered, and reporting that as a failure would
 * train users to ignore the report.
 */
export function buildGuardianReport(probes: GuardianProbes): GuardianReport {
  const items: GuardianItem[] = [];

  const gatewayStatus = probes.gatewayStatus ?? "unknown";
  items.push({
    id: "gateway-process",
    state:
      gatewayStatus === "running"
        ? "ok"
        : gatewayStatus === "starting"
          ? "unknown"
          : gatewayStatus === "unknown" || gatewayStatus === "stopped"
            ? "degraded"
            : "failed",
    detail: `Gateway ${gatewayStatus}`,
  });

  items.push({
    id: "gateway-auth",
    state:
      probes.gatewayConnected === undefined
        ? "unknown"
        : probes.gatewayConnected
          ? "ok"
          : "degraded",
    detail:
      probes.gatewayConnected === undefined
        ? "尚未连接"
        : probes.gatewayConnected
          ? "已通过鉴权连接"
          : "未连接（Gateway 可能未启动或未完成鉴权）",
  });

  items.push(manifestItem(probes));

  items.push({
    id: "plugin-installed",
    state:
      probes.pluginInstalled === undefined
        ? "unknown"
        : probes.pluginInstalled
          ? probes.pluginEnabled === false
            ? "degraded"
            : "ok"
          : "failed",
    detail:
      probes.pluginInstalled === undefined
        ? "未检测"
        : probes.pluginInstalled
          ? probes.pluginEnabled === false
            ? "微信插件已安装但未启用"
            : probes.pluginLoggedIn
              ? "微信插件已启用并已登录"
              : "微信插件已启用，尚未扫码绑定"
          : "微信插件未安装（需重新运行安装包修复安装）",
  });

  items.push(brokerItem(probes));

  items.push({
    id: "browser-binary",
    state:
      probes.browserExecutable === undefined
        ? "unknown"
        : probes.browserExecutable
          ? "ok"
          : "failed",
    detail:
      probes.browserExecutable === undefined
        ? "未检测"
        : probes.browserExecutable
          ? `浏览器可用（${probes.browserExecutable}）`
          : "未找到可用的浏览器（Windows 11 通常自带 Edge）",
  });

  items.push(modelItem(probes));

  return {
    overall: worstState(items.filter((item) => ENVIRONMENT_ITEM_IDS.includes(item.id))),
    items,
  };
}

function manifestItem(probes: GuardianProbes): GuardianItem {
  if (probes.manifestChecked === null || probes.manifestChecked === undefined) {
    return {
      id: "runtime-manifest",
      state: probes.manifestProblems && probes.manifestProblems.length > 0 ? "failed" : "unknown",
      detail:
        probes.manifestProblems && probes.manifestProblems.length > 0
          ? `运行资源校验未通过：${probes.manifestProblems.join("; ")}`
          : "尚未校验运行资源",
    };
  }
  if (probes.manifestProblems && probes.manifestProblems.length > 0) {
    return {
      id: "runtime-manifest",
      state: "failed",
      detail: `运行资源校验未通过：${probes.manifestProblems.join("; ")}`,
    };
  }
  return {
    id: "runtime-manifest",
    state: "ok",
    detail: `运行资源完整（已校验 ${probes.manifestChecked} 项）`,
  };
}

function brokerItem(probes: GuardianProbes): GuardianItem {
  if (probes.brokerNodePath === null) {
    return {
      id: "broker-runtime",
      state: "unknown",
      detail: "未检测到 Broker 运行时",
    };
  }
  if (probes.brokerRunning) {
    return { id: "broker-runtime", state: "ok", detail: "Broker 正在运行" };
  }
  return {
    id: "broker-runtime",
    state: "degraded",
    detail: probes.brokerFailureReason
      ? `Broker 未运行：${probes.brokerFailureReason}`
      : "Broker 未运行（将在首次使用时启动）",
  };
}

function modelItem(probes: GuardianProbes): GuardianItem {
  const capability = probes.modelCapability;
  if (capability === null || capability === undefined) {
    // Not measured is not the same as broken: the probe needs an API key.
    return { id: "model-reply", state: "unknown", detail: "尚未检测模型能力" };
  }
  // Only the tool-call verdict decides whether remote work can be delegated:
  // a model that cannot call tools cannot drive the broker or the browser, no
  // matter how well it chats. An unverified verdict is not a pass.
  return {
    id: "model-reply",
    state: capability === "supported" ? "ok" : capability === "unknown" ? "degraded" : "failed",
    detail:
      capability === "supported"
        ? "模型支持工具调用"
        : capability === "unknown"
          ? "模型工具调用能力未验证"
          : "模型不支持工具调用",
  };
}

function worstState(items: GuardianItem[]): GuardianItemState {
  let worst: GuardianItemState = "ok";
  for (const item of items) {
    if (SEVERITY[item.state] > SEVERITY[worst]) worst = item.state;
  }
  return worst;
}

/**
 * True when every component the installation itself provides is working.
 *
 * Deliberately silent about the model and the WeChat binding: those are the
 * user's next two steps, not installation faults.
 */
export function guardianIsReady(report: GuardianReport): boolean {
  return report.items
    .filter((item) => ENVIRONMENT_ITEM_IDS.includes(item.id))
    .every((item) => item.state === "ok");
}
