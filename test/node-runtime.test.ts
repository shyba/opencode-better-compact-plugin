import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"

describe("Node-hosted Pi runtime", () => {
  test("loads the Pi source extension without resolving Bun-only modules", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "better-compact-pi-node-"))
    try {
      const result = Bun.spawnSync({
        cmd: [path.join(process.cwd(), "node_modules/.bin/pi"), "--offline", "-ne", "-e", path.join(process.cwd(), "src/pi.ts"), "--list-models"],
        env: { ...process.env, PI_CODING_AGENT_DIR: dir, NODE_NO_WARNINGS: "1" },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(result.exitCode).toBe(0)
      expect(result.stderr.toString()).not.toContain("Cannot find module 'bun:sqlite'")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("keeps semantic state on node:sqlite after Pi installs its Bun crypto shim", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "better-compact-node-sqlite-"))
    try {
      const result = Bun.spawnSync({
        cmd: ["node", "--input-type=module", "-e", `
          import { createJiti } from "jiti"
          const jiti = createJiti(import.meta.url)
          const extension = await jiti.import(process.env.PI_MODULE)
          extension.default({ on() {}, registerCommand() {} })
          const semantic = await jiti.import(process.env.SEMANTIC_MODULE)
          const store = new semantic.SemanticStore(process.env.SEMANTIC_DATABASE)
          console.log(JSON.stringify(store.db.query("select 1 as ok").get()))
          store.close()
        `],
        env: {
          ...process.env,
          NODE_NO_WARNINGS: "1",
          PI_MODULE: path.join(process.cwd(), "src/pi.ts"),
          SEMANTIC_MODULE: path.join(process.cwd(), "src/semantic.ts"),
          SEMANTIC_DATABASE: path.join(dir, "state.sqlite"),
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString().trim()).toBe('{"ok":1}')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
