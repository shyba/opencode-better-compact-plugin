import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cliRoutes } from '../scripts/cli-help.js'

test('actual CLI help and invalid options never load state or run services', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'better-compact-help-'))
  try {
    const config = path.join(root, 'invalid.json')
    await writeFile(config, 'deliberately invalid JSON')
    const sentinel = path.join(root, 'systemctl')
    await writeFile(sentinel, '#!/bin/sh\nprintf invoked >> "$HOME/invoked"\nexit 99\n')
    await chmod(sentinel, 0o755)
    // Bun may initialize its own cache even when application dispatch never runs.
    await mkdir(path.join(root, '.bun'))
    const initial = (await readdir(root)).sort()
    const run = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, '../scripts/cli.ts'), ...args], {
        env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_STATE_HOME: root, BETTER_COMPACT_CONFIG: config, BETTER_COMPACT_STATE: path.join(root, 'missing', 'state.sqlite'), OPENCODE_SAFE_COMPACTION_DIR: path.join(root, 'not-installed'), PATH: `${root}:${process.env.PATH}` },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      return { stdout, stderr, code }
    }
    for (const route of Object.keys(cliRoutes)) {
      const help = await run([...route.split(' '), '--help'])
      expect(help.code).toBe(0)
      expect(help.stdout).toContain(`better-compact ${route}`)
      expect(help.stderr).toBe('')
      const invalid = await run([...route.split(' '), '--unknown-option'])
      expect(invalid.code).toBe(2)
      expect(invalid.stderr).toContain('Unknown option')
    }
    expect((await readdir(root)).sort()).toEqual(initial)
    expect(await readFile(config, 'utf8')).toBe('deliberately invalid JSON')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)
