import { afterEach, describe, expect, test } from "bun:test"
import type { TuiDialogSelectOption, TuiDialogSelectProps, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import plugin, { createTui } from "../src/tui.js"

type Command = {
  name: string
  slashName?: string
  slashAliases?: string[]
  run: () => void
}

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((item) => rm(item, { recursive: true, force: true })))
})

function fixture(input?: {
  config?: string
  realUpdater?: boolean
  updateModel?: (api: TuiPluginApi, model: string) => Promise<void>
}) {
  const updates: string[] = []
  const toasts: Array<{ variant?: string; message: string }> = []
  let disposed = 0
  let command: Command | undefined
  let render: (() => unknown) | undefined
  const api = {
    keymap: {
      registerLayer(input: { commands: Command[] }) {
        command = input.commands[0]
        return () => {}
      },
    },
    state: {
      path: { config: input?.config ?? "/tmp/config" },
      provider: [
        {
          id: "beta",
          name: "Beta Provider",
          models: {
            old: { id: "old", name: "Old", status: "deprecated" },
            compact: { id: "compact", name: "Compact", status: "active" },
          },
        },
        {
          id: "alpha",
          name: "Alpha Provider",
          models: {
            large: { id: "large", name: "Large", status: "active" },
          },
        },
      ],
    },
    ui: {
      DialogSelect(input: TuiDialogSelectProps<string>) {
        return input
      },
      dialog: {
        replace(next: () => unknown) {
          render = next
        },
        clear() {},
      },
      toast(input: { variant?: string; message: string }) {
        toasts.push(input)
      },
    },
    client: {
      global: {
        async dispose() {
          disposed++
        },
      },
    },
  } as unknown as TuiPluginApi
  const tui = input?.realUpdater
    ? createTui()
    : createTui(
        input?.updateModel ??
          (async (_, model) => {
            updates.push(model)
          }),
      )

  return {
    api,
    updates,
    toasts,
    disposed: () => disposed,
    command: () => command,
    dialog: () => render?.() as TuiDialogSelectProps<string>,
    tui,
  }
}

describe("OpenCode compaction model selector", () => {
  test("registers a native slash command and lists selected plus connected models", async () => {
    const value = fixture()
    await value.tui(value.api, { model: "beta/compact" }, {} as never)

    expect(value.command()).toMatchObject({
      name: "safe-compaction.model",
      slashName: "compaction-model",
      slashAliases: ["compact-model"],
    })
    value.command()?.run()
    expect(value.dialog().current).toBe("beta/compact")
    expect(value.dialog().options.map((option) => option.value)).toEqual([
      "selected",
      "alpha/large",
      "beta/compact",
    ])
  })

  test("persists a new policy, reloads OpenCode, and avoids work for the current policy", async () => {
    const value = fixture()
    await value.tui(value.api, { model: "beta/compact" }, {} as never)
    value.command()?.run()

    const selected = value.dialog().options.find((option) => option.value === "selected")
    await value.dialog().onSelect?.(selected as TuiDialogSelectOption<string>)
    expect(value.updates).toEqual(["selected"])
    expect(value.disposed()).toBe(1)
    expect(value.toasts.at(-1)).toEqual({
      variant: "success",
      message: "Compaction now uses the selected model",
    })

    value.command()?.run()
    await value.dialog().onSelect?.(value.dialog().options[0]!)
    expect(value.updates).toEqual(["selected"])
    expect(value.disposed()).toBe(1)
    expect(value.toasts.at(-1)?.message).toContain("already")
  })

  test("reports configuration failures without reloading or rejecting the command", async () => {
    const value = fixture({
      async updateModel() {
        throw new Error("configuration stayed unchanged")
      },
    })
    await value.tui(value.api, { model: "beta/compact" }, {} as never)
    value.command()?.run()

    const selected = value.dialog().options.find((option) => option.value === "selected")
    expect(await value.dialog().onSelect?.(selected as TuiDialogSelectOption<string>)).toBeUndefined()
    expect(value.disposed()).toBe(0)
    expect(value.toasts.at(-1)).toEqual({
      variant: "error",
      message: "Could not update the compaction model: configuration stayed unchanged",
    })
  })

  test("exports a dedicated TUI-only plugin module", () => {
    expect(plugin.id).toBe("opencode-safe-compaction-settings")
    expect(typeof plugin.tui).toBe("function")
    expect(plugin).not.toHaveProperty("server")
  })

  test("loads separate server and TUI modules from the source runtime directory", async () => {
    const server = await import("../runtime/server.js")
    const settings = await import("../runtime/tui.js")

    expect(server.default.id).toBe("opencode-safe-compaction")
    expect(typeof server.default.server).toBe("function")
    expect(settings.default.id).toBe("opencode-safe-compaction-settings")
    expect(typeof settings.default.tui).toBe("function")
  })

  test("updates both OpenCode config surfaces through the host Bun runtime", async () => {
    const config = await mkdtemp(path.join(tmpdir(), "safe-compaction-tui-"))
    temporary.push(config)
    const source = path.join(process.cwd(), "runtime")
    await Bun.write(
      path.join(config, "opencode.jsonc"),
      JSON.stringify({ plugin: [[source, { model: "opencode-go/glm-5.2" }]] }, null, 2),
    )
    await Bun.write(
      path.join(config, "tui.jsonc"),
      JSON.stringify({ plugin: [[source, { model: "opencode-go/glm-5.2" }]] }, null, 2),
    )
    const value = fixture({ config, realUpdater: true })
    await value.tui(value.api, { model: "opencode-go/glm-5.2" }, {} as never)
    value.command()?.run()

    const selected = value.dialog().options.find((option) => option.value === "selected")
    await value.dialog().onSelect?.(selected as TuiDialogSelectOption<string>)

    const server = Bun.JSONC.parse(await Bun.file(path.join(config, "opencode.jsonc")).text()) as {
      plugin: [[string, { model: string }]]
    }
    const tui = Bun.JSONC.parse(await Bun.file(path.join(config, "tui.jsonc")).text()) as {
      plugin: [[string, { model: string }]]
    }
    expect(server.plugin[0][1].model).toBe("selected")
    expect(tui.plugin[0][1].model).toBe("selected")
    expect(value.disposed()).toBe(1)
  })
})
