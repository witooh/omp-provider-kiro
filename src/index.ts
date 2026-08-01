// Feature 1: Extension Registration
//
// Entry point that wires all features together via pi.registerProvider().

import type { Api, Model, OAuthCredentials } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getKiroEndpoints, resolveApiRegion } from "./endpoints.js";
import { setExtensionContext } from "./login-ui.js";
import { getCachedModels, kiroModels } from "./models.js";
import type { KiroCredentials } from "./oauth.js";
import { loginKiro, refreshKiroToken } from "./oauth.js";
import { streamKiro } from "./stream.js";

export { resolveApiRegion } from "./endpoints.js";
export type { KiroStreamEvent } from "./event-parser.js";
export { KIRO_MODEL_IDS, kiroModels, resolveKiroModel } from "./models.js";
export { streamKiro } from "./stream.js";

export default function (pi: ExtensionAPI) {
  // Capture ctx for the custom TUI login component
  pi.on("session_start", async (_event, ctx) => {
    setExtensionContext(ctx);
  });
  pi.registerProvider("kiro", {
    baseUrl: getKiroEndpoints("us-east-1").runtime,
    api: "kiro-api",
    // Bootstrap catalog. omp's registerProvider returns early when `models` is
    // non-empty, so `fetchDynamicModels` would never run — the live catalog is
    // refreshed by oauth/stream into the on-disk cache and projected back
    // through `modifyModels` below.
    models: kiroModels,
    oauth: {
      // Name reflects all supported auth methods: AWS Builder ID, Google, GitHub
      name: "Kiro (Builder ID / Google / GitHub)",
      login: loginKiro,
      refreshToken: refreshKiroToken,
      getApiKey: (cred: OAuthCredentials) => cred.access,
      modifyModels: (models: Model<Api>[], cred: OAuthCredentials) => {
        // The host hands back its own credential shape; Kiro stores region and
        // profileArn alongside it, so widen once instead of at each read.
        const kiroCred = cred as KiroCredentials;
        const apiRegion = resolveApiRegion(kiroCred.region);
        const runtimeUrl = getKiroEndpoints(apiRegion).runtime;
        const projectedKiro = getCachedModels(apiRegion).map((model) => ({
          ...model,
          baseUrl: runtimeUrl,
          kiroRegion: apiRegion,
          ...(kiroCred.profileArn ? { kiroProfileArn: kiroCred.profileArn } : {}),
        }));

        return [...models.filter((model) => model.provider !== "kiro"), ...projectedKiro];
      },
    },
    streamSimple: streamKiro,
  });
}
