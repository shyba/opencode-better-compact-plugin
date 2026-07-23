import type { TuiDialogSelectOption, TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { SELECTED_MODEL } from "./options.js"

type ModelUpdater = (api: TuiPluginApi, model: string) => Promise<void>

export function createTui(updateModel: ModelUpdater = configureModel): TuiPlugin {
  return async (api, rawOptions) => {
    let current = typeof rawOptions?.model === "string" ? rawOptions.model : SELECTED_MODEL
    api.keymap.registerLayer({
      commands: [
        {
          name: "safe-compaction.model",
          title: "Compaction model",
          desc: "Choose a dedicated model or follow the selected model",
          category: "Compaction",
          namespace: "palette",
          slashName: "compaction-model",
          slashAliases: ["compact-model"],
          run() {
            const available = api.state.provider
              .flatMap((provider) =>
                Object.values(provider.models)
                  .filter((model) => model.status !== "deprecated")
                  .map((model) => ({
                    title: model.name || model.id,
                    value: `${provider.id}/${model.id}`,
                    description: model.id,
                    category: provider.name,
                  })),
              )
              .sort((left, right) =>
                left.category.localeCompare(right.category) || left.title.localeCompare(right.title)
              )
            const options: TuiDialogSelectOption<string>[] = [
              {
                title: "Follow selected model",
                value: SELECTED_MODEL,
                description: "Use the model selected for each compaction",
                category: "Policy",
              },
              ...(current !== SELECTED_MODEL && !available.some((option) => option.value === current)
                ? [{
                    title: current,
                    value: current,
                    description: "Configured model is not currently available",
                    category: "Current",
                  }]
                : []),
              ...available,
            ]
            api.ui.dialog.replace(() =>
              api.ui.DialogSelect({
                title: "Compaction model",
                options,
                current,
                flat: true,
                onSelect: async (option) => {
                  api.ui.dialog.clear()
                  if (option.value === current) {
                    api.ui.toast({ variant: "info", message: `Compaction model is already ${displayModel(current)}` })
                    return
                  }
                  try {
                    await updateModel(api, option.value)
                    current = option.value
                  } catch (error) {
                    api.ui.toast({
                      variant: "error",
                      message: `Could not update the compaction model: ${errorMessage(error)}`,
                    })
                    return
                  }
                  try {
                    await api.client.global.dispose({ throwOnError: true })
                    api.ui.toast({
                      variant: "success",
                      message: `Compaction now uses ${displayModel(current)}`,
                    })
                  } catch {
                    api.ui.toast({
                      variant: "warning",
                      message: `Compaction model saved as ${displayModel(current)}; restart OpenCode to activate it`,
                    })
                  }
                },
              }),
            )
          },
        },
      ],
    })
  }
}

async function configureModel(api: TuiPluginApi, model: string) {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const installDir = path.dirname(moduleDir)
  const packaged = path.basename(moduleDir) === "dist"
  const script = path.join(installDir, "scripts/configure.ts")
  const environment = {
    OPENCODE_SAFE_COMPACTION_ACTION: "apply",
    OPENCODE_SAFE_COMPACTION_CONFIG_DIR:
      process.env.OPENCODE_CONFIG_DIR?.trim() || api.state.path.config,
    OPENCODE_SAFE_COMPACTION_DIR: installDir,
    OPENCODE_SAFE_COMPACTION_MODEL: model,
    OPENCODE_SAFE_COMPACTION_MODEL_EXPLICIT: "1",
    OPENCODE_SAFE_COMPACTION_PRESERVE_SOURCE: "1",
    OPENCODE_SAFE_COMPACTION_SERVER_ENTRY: path.join(
      installDir,
      packaged ? "dist/index.js" : "runtime/server.js",
    ),
    OPENCODE_SAFE_COMPACTION_TUI_ENTRY: path.join(
      installDir,
      packaged ? "dist/tui.js" : "runtime/tui.js",
    ),
    OPENCODE_SAFE_COMPACTION_STATE_FILE: undefined,
    OPENCODE_SAFE_COMPACTION_VERIFY_DIR: undefined,
  }
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) {
      delete process.env[key]
      continue
    }
    process.env[key] = value
  }
  try {
    await import(`${pathToFileURL(script).href}?live-model=${Date.now()}-${crypto.randomUUID()}`)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key]
        continue
      }
      process.env[key] = value
    }
  }
}

function displayModel(model: string) {
  return model === SELECTED_MODEL ? "the selected model" : model
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  return "an internal configuration error"
}

const tui = createTui()

export default {
  id: "opencode-safe-compaction-settings",
  tui,
}
