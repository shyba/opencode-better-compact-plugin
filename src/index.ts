import type { PluginModule } from "@opencode-ai/plugin"
import { server } from "./server.js"

export { server }
export * from "./ledger.js"
export * from "./options.js"
export * from "./semantic.js"
export * from "./sqlite.js"
export * from "./state.js"
export * from "./validation.js"
export * from "./vcc.js"
export * from "./vcc-opencode.js"
export * from "./vcc-pi.js"
export * from "./vcc-archive.js"
export * from "./vcc-hybrid.js"
export * from "./vcc-wire.js"
export * from "./vcc-opencode-message.js"
export * from "./vcc-opencode-session.js"
export * from "./vcc-opencode-render.js"
export * from "./vcc-opencode-recall.js"
export * from "./vcc-pi-recall.js"

export default {
  id: "opencode-safe-compaction",
  server,
} satisfies PluginModule
