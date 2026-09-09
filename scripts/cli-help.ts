/** Pure command validation: call before loading configuration, SQLite, or services. */
type Route = { summary: string; flags?: string[]; values?: string[]; usage?: string; detail?: string }
export const cliRoutes: Record<string, Route> = {
  install: { summary: 'Activate the OpenCode plugin.' },
  'install pi': { summary: 'Register both Pi extensions.' },
  update: { summary: 'Update the managed checkout and verify configuration.' },
  doctor: { summary: 'Check installation, source files, configuration and SQLite.' },
  'sync setup': { summary: '[S3] Configure session-center upload.', flags: ['--url-stdin', '--token-stdin', '--allow-insecure-remote', '--install'], values: ['--url', '--token'], detail: 'Use --url URL or --url-stdin; --token TOKEN or --token-stdin. --install starts the background service.' },
  'sync run': { summary: 'Upload changed sessions.', flags: ['--once', '--pass'], detail: 'Without flags: continuous background loop.\n--once: scan and retry failures until idle, then exit.\n--pass: one normal pass, preserving retry skips.\nUpload success does not prove server loading or search indexing; use sync verify.' },
  'sync status': { summary: 'Show local receipts, outbox and failures; not remote completeness.' },
  'sync verify': { summary: '[S3] Check all configured sources against remote coverage.', flags: ['--json'], detail: 'Read-only. Reports archive, loaded and indexed coverage separately. Unknown coverage is not success.' },
  'sync install': { summary: 'Install and start the background sync service.' },
  'sync uninstall': { summary: 'Stop and remove the background sync service.' },
  'sync retry-s3': { summary: '[S3] Clear one failed retry without resetting checkpoints.', values: ['--kind', '--path', '--root'], usage: '--kind KIND --path PATH [--root ROOT]', detail: 'Stop background sync first. KIND: codex-jsonl, codex-jsonl-sessions or pi-jsonl. PATH is the relative JSONL path. The next sync pass retries it.' },
  'sync compact': { summary: 'Remove acknowledged local cache rows and compact SQLite.', flags: ['--yes'], usage: '--yes' },
  'sync migrate': { summary: '[Legacy Postgres] Apply mirror migrations; no-op for S3.' },
  'sync reconcile': { summary: '[Legacy Postgres] Rebuild OpenCode snapshot; no-op for S3.', detail: 'Does not verify remote S3 completeness. Use sync verify for S3 coverage.' },
  'sync prune': { summary: '[Legacy Postgres] Delete selected local Codex files, retaining remote rows.', flags: ['--missing-directories', '--blank-directories', '--yes'], usage: '(--missing-directories|--blank-directories) --yes' },
  'sync backfill-hierarchy': { summary: '[Legacy Postgres] Stage Codex parent/thread metadata.', flags: ['--dry-run'] },
  'installation reset': { summary: 'Reset sync identity explicitly.', flags: ['--yes'], usage: '--yes' },
  'installation adopt': { summary: '[Legacy Postgres] Adopt existing mirror identity.', flags: ['--yes'], usage: '--yes' },
  'rag setup': { summary: '[Legacy Postgres RAG] Configure the separate BGE-small worker, not VCC.', flags: ['--length-bucketing', '--no-length-bucketing', '--install'], values: ['--backend', '--compute-dtype', '--batch-size', '--message-batch-size', '--threads', '--full-sweep-interval-seconds', '--model-path', '--python', '--model', '--ssh-host', '--ssh-user', '--ssh-local-port', '--ssh-remote-host', '--ssh-remote-port'], detail: '--backend: auto|onnx|torch; --compute-dtype: float32|bfloat16.\nBatch sizes, threads and sweep interval must be positive integers.\n--ssh-host and --ssh-user must be supplied together. Ports: 1–65535.' },
  'rag run': { summary: '[Legacy Postgres RAG] Run the separate embedding worker.', flags: ['--once'] },
  'rag status': { summary: '[Legacy Postgres RAG] Show model and projection metadata.' },
  'rag migrate': { summary: '[Legacy Postgres RAG] Create the 384d projection with admin credentials.' },
  'rag install': { summary: '[Legacy Postgres RAG] Install and start the embedding service.' },
  'rag uninstall': { summary: '[Legacy Postgres RAG] Stop and remove the embedding service.' },
  'rag tunnel install': { summary: '[Legacy Postgres RAG] Install the PostgreSQL SSH tunnel.' },
  'rag tunnel uninstall': { summary: '[Legacy Postgres RAG] Remove the PostgreSQL SSH tunnel.' },
}
const globals = ['--config', '--state']
const groups = new Set(['', 'sync', 'rag', 'rag tunnel', 'installation'])
export function cliHelp(route = ''): string {
  const spec = cliRoutes[route]
  const lines = [`better-compact${route ? ` ${route}` : ''}`, '']
  if (spec) {
    lines.push(spec.summary, '', `Usage: better-compact ${route}${spec.usage ? ` ${spec.usage}` : ''} [options]`)
    if (spec.detail) lines.push('', spec.detail)
    const options = [...(spec.flags ?? []), ...(spec.values ?? []).map(flag => `${flag} VALUE`)]
    if (options.length) lines.push('', 'Options:', ...options.map(option => `  ${option}`))
  } else if (!route) {
    lines.push('Session sync:', '  sync          Upload, inspect and verify session archives', '', 'Plugin maintenance:', '  install [pi]  Activate OpenCode or Pi extensions', '  update        Update the managed installation', '  doctor        Check installation and sources', '  installation  Explicit identity recovery', '', 'Legacy tools:', '  rag           Separate Postgres embedding pipeline; not VCC', '', 'Use better-compact sync --help for sync commands.')
  } else {
    lines.push(`Usage: better-compact ${route} <command> [options]`, '')
    for (const [name, entry] of Object.entries(cliRoutes)) {
      if (name.startsWith(`${route} `)) lines.push(`  ${name.slice(route.length + 1).padEnd(20)} ${entry.summary}`)
    }
  }
  lines.push('', 'Global options: --config FILE, --state FILE', 'Help: append --help or -h to any command. Help never runs the command.')
  return lines.join('\n')
}
export type CliInspection = { kind: 'run'; args: string[] } | { kind: 'help' | 'error'; text: string; code: number }
export function inspectCli(input: string[]): CliInspection {
  let args = [...input]
  const explicitHelp = args[0] === 'help'
  if (explicitHelp) args.shift()
  const help = explicitHelp || !args.length || args.includes('--help') || args.includes('-h')
  const allValues = new Set([...globals, ...Object.values(cliRoutes).flatMap(route => route.values ?? [])])
  const words: string[] = []
  const options: string[] = []
  const values = new Map<string, string>()
  const seen = new Set<string>()
  let error = ''
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--help' || arg === '-h') continue
    if (!arg.startsWith('-')) { words.push(arg); continue }
    if (seen.has(arg)) error ||= `Duplicate option: ${arg}`
    seen.add(arg)
    options.push(arg)
    if (allValues.has(arg)) {
      const value = args[i + 1]
      if (!value || value.startsWith('-')) error ||= `Missing value for ${arg}`
      else { values.set(arg, value); options.push(value); i++ }
    }
  }
  const route = words.join(' ')
  const spec = cliRoutes[route]
  const fail = (message: string): CliInspection => ({ kind: 'error', code: 2, text: `${message}\nUse better-compact${route && (spec || groups.has(route)) ? ` ${route}` : ''} --help.` })
  // Help takes precedence over incomplete flags, but never accepts unknown routes.
  if (help) return spec || groups.has(route) ? { kind: 'help', code: 0, text: cliHelp(route) } : fail(`Unknown command: ${route}`)
  if (error) return fail(error)
  if (!spec) {
    if (!groups.has(route)) return fail(`Unknown command: ${route}`)
    for (const flag of seen) if (!globals.includes(flag)) return fail(`Unknown option for ${route}: ${flag}`)
    return { kind: 'help', code: 0, text: cliHelp(route) }
  }
  const allowed = new Set([...globals, ...(spec.flags ?? []), ...(spec.values ?? [])])
  for (const flag of seen) if (!allowed.has(flag)) return fail(`Unknown option for ${route}: ${flag}`)
  for (const [a, b] of [['--once', '--pass'], ['--url', '--url-stdin'], ['--token', '--token-stdin'], ['--length-bucketing', '--no-length-bucketing'], ['--missing-directories', '--blank-directories']]) {
    if (seen.has(a!) && seen.has(b!)) return fail(`Choose only one of ${a} and ${b}`)
  }
  if (route === 'sync retry-s3') {
    if (!values.has('--kind') || !values.has('--path')) return fail('--kind and --path are required')
    if (!['codex-jsonl', 'codex-jsonl-sessions', 'pi-jsonl'].includes(values.get('--kind')!)) return fail('Unsupported S3 source kind')
  }
  if (['sync compact', 'sync prune', 'installation reset', 'installation adopt'].includes(route) && !seen.has('--yes')) return fail('--yes is required')
  if (route === 'sync prune' && !seen.has('--missing-directories') && !seen.has('--blank-directories')) return fail('Choose --missing-directories or --blank-directories')
  if (route === 'rag setup') {
    if (seen.has('--ssh-host') !== seen.has('--ssh-user')) return fail('--ssh-host and --ssh-user must be supplied together')
    for (const [flag, choices] of [['--backend', ['auto', 'onnx', 'torch']], ['--compute-dtype', ['float32', 'bfloat16']]] as const) {
      if (values.has(flag) && !(choices as readonly string[]).includes(values.get(flag)!)) return fail(`${flag} must be ${choices.join(', ')}`)
    }
    for (const flag of ['--batch-size', '--message-batch-size', '--threads', '--full-sweep-interval-seconds', '--ssh-local-port', '--ssh-remote-port']) {
      if (!values.has(flag)) continue
      const n = Number(values.get(flag))
      if (!Number.isSafeInteger(n) || n <= 0 || (flag.endsWith('-port') && n > 65535)) return fail(`${flag} must be a positive integer${flag.endsWith('-port') ? ' from 1 to 65535' : ''}`)
    }
  }
  return { kind: 'run', args: [...words, ...options] }
}
