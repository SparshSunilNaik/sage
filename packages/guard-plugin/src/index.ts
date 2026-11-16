/**
 * Entry point. OpenCode loads a plugin *directory* and picks `index.ts` (or package.json exports).
 * SAGE points OpenCode's `plugins` config at this package directory.
 */
import plugin from "./plugin.ts";

export { type GuardPluginContext, readOptions, SageGuardDenied, setup } from "./plugin.ts";
export { askGuard, type GuardEndpointConfig, type GuardRequest, type GuardResponse } from "./protocol.ts";
export default plugin;
