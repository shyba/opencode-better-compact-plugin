import type { PluginModule } from "@opencode-ai/plugin"
import { server } from "./server.js"

export { server }
export * from "./ledger.js"
export * from "./options.js"
export * from "./state.js"
export * from "./validation.js"

export default {
  id: "opencode-safe-compaction",
  server,
} satisfies PluginModule
