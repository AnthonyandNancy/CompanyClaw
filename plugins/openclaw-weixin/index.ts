import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";

import { weixinPlugin } from "./src/channel.js";
import { assertHostCompatibility } from "./src/compat.js";
import { WeixinConfigSchema } from "./src/config/config-schema.js";
import { installDesktopBridgeListener } from "./src/messaging/desktop-bridge.js";

export default {
  id: "openclaw-weixin",
  name: "Weixin",
  description: "Weixin channel (getUpdates long-poll + sendMessage)",
  configSchema: buildChannelConfigSchema(WeixinConfigSchema),
  register(api: OpenClawPluginApi) {
    // Fail-fast: reject incompatible host versions before any side-effects.
    assertHostCompatibility(api.runtime?.version);

    // CompanyClaw: install the desktop response listener once (not per message)
    // so the pending-request map cannot leak. No-op without a desktop parent.
    installDesktopBridgeListener(
      typeof process.send === "function" ? (process as never) : null,
    );

    api.registerChannel({ plugin: weixinPlugin });
  },
};
