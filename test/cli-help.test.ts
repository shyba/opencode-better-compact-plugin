import { expect, test } from 'bun:test'
import { cliHelp, cliRoutes, inspectCli } from '../scripts/cli-help.js'

test('all routes intercept help before dispatch and reject unknown options', () => {
  for (const route of Object.keys(cliRoutes)) {
    for (const flag of ['--help', '-h']) expect(inspectCli([...route.split(' '), flag]).kind).toBe('help')
    expect(inspectCli(['help', ...route.split(' ')]).kind).toBe('help')
    expect(inspectCli([...route.split(' '), '--typo']).kind).toBe('error')
  }
})
test('hierarchical help identifies legacy and retry semantics', () => {
  expect(cliHelp()).toContain('Legacy tools:')
  expect(cliHelp('sync')).toContain('[Legacy Postgres]')
  expect(cliHelp('sync run')).toContain('--once: scan and retry failures until idle')
  expect(cliHelp('sync run')).toContain('--pass: one normal pass')
  expect(cliHelp('sync reconcile')).toContain('no-op for S3')
  expect(cliHelp('sync verify')).toContain('Unknown coverage is not success')
})
test('help accepts incomplete arguments without dispatch', () => {
  expect(inspectCli(['sync', 'setup', '--token', '--help']).kind).toBe('help')
  expect(inspectCli(['installation', 'reset', '--yes', '--help']).kind).toBe('help')
  expect(inspectCli(['sync', 'oops', '--help']).kind).toBe('error')
})
test('globals normalize for existing dispatcher', () => {
  expect(inspectCli(['--config', '/tmp/config', 'sync', '--state', '/tmp/state', 'status'])).toEqual({ kind: 'run', args: ['sync', 'status', '--config', '/tmp/config', '--state', '/tmp/state'] })
})
test('malformed, conflicting and misplaced options fail', () => {
  for (const args of [
    'sync run --once --pass', 'sync run --once --once', 'sync run --once=true',
    'sync --typo', 'rag --once', 'sync --config', 'sync status extra', 'sync setup --url', 'sync setup --url --install',
    'sync setup --token secret --token-stdin', 'sync setup --url localhost --url-stdin',
    'sync prune --yes', 'sync compact', 'sync prune --yes --blank-directories --missing-directories',
    'sync retry-s3 --kind codex-jsonl', 'sync retry-s3 --kind unknown --path a.jsonl',
    'rag setup --length-bucketing --no-length-bucketing', 'rag setup --ssh-host host',
    'rag setup --backend bogus', 'rag setup --batch-size NaN', 'rag setup --ssh-local-port 65536',
  ]) expect(inspectCli(args.split(' ')).kind).toBe('error')
})
test('valid documented and formerly omitted options remain accepted', () => {
  for (const args of [
    'install pi', 'sync run --once', 'sync run --pass', 'sync verify --json', 'sync compact --yes',
    'sync retry-s3 --kind codex-jsonl --path 2026/a.jsonl --root /tmp/sessions',
    'sync setup --url-stdin --token-stdin --allow-insecure-remote --install',
    'rag setup --model name --backend torch --compute-dtype bfloat16 --ssh-host host --ssh-user user --ssh-local-port 5433 --ssh-remote-port 5432 --ssh-remote-host localhost --full-sweep-interval-seconds 60',
  ]) expect(inspectCli(args.split(' ')).kind).toBe('run')
})
