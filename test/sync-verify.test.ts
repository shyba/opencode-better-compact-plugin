import { expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SyncState } from '../src/sync-state.js'
import { verifySync } from '../scripts/sync-verify.js'

type Scenario = { receipt?: boolean; changed?: boolean; missingState?: boolean; status?: number; archive?: string; loaded?: string; indexed?: string; malformed?: boolean; duplicate?: boolean; additionalMissing?: boolean }
async function check(scenario: Scenario = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'better-compact-verify-'))
  const logs: string[] = []
  const log = spyOn(console, 'log').mockImplementation((message) => { logs.push(String(message)) })
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    const sessions = path.join(root, 'sessions')
    await mkdir(sessions)
    const filename = path.join(sessions, 'session.jsonl')
    const original = '{"type":"session_meta","payload":{"id":"test-session"}}\n'
    await writeFile(filename, original)
    const meta = await stat(filename)
    const sourceID = createHash('sha256').update(`codex-jsonl\n${sessions}`).digest('hex').slice(0, 32)
    const sha256 = createHash('sha256').update(original).digest('hex')
    const statePath = path.join(root, 'state.sqlite')
    if (!scenario.missingState) {
      const state = new SyncState(statePath)
      const installation = state.ensureDefaultInstallation('test', 's3', 's3')
      state.upsertSource({ id: sourceID, installationID: installation.id, incarnation: installation.incarnation, kind: 'codex-jsonl', schemaVersion: 1, locator: sessions })
      state.db.query('insert into source_cursor(source_id,stream,checkpoint_json,updated_at) values (?, ?, ?, ?)').run(sourceID, 'messages', '{"offset":73}', 123)
      if (scenario.receipt !== false) state.recordS3File(sourceID, 'session.jsonl', { fileID: 'test-file-id', size: meta.size, mtimeMs: meta.mtimeMs, sha256 })
      state.close()
    }
    const stateBefore = await readFile(statePath).catch(() => undefined)
    if (scenario.changed) await writeFile(filename, original.replace('test-session', 'next-session')) // same-sized rewrite
    if (scenario.additionalMissing) await writeFile(path.join(sessions, "unuploaded.jsonl"), original)
    const sourceBefore = await readFile(filename)
    const requests: Array<{ method: string; pathname: string; auth: string | null; body: any }> = []
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const body = await request.json()
      requests.push({ method: request.method, pathname: new URL(request.url).pathname, auth: request.headers.get('authorization'), body })
      if (scenario.status) return new Response('unsupported', { status: scenario.status })
      return Response.json(scenario.malformed ? { files: [] } : { files: [{ file_id: body.files[0].file_id, archive: { status: scenario.archive ?? 'verified' }, loaded: { status: scenario.loaded ?? 'verified' }, indexed: { status: scenario.indexed ?? 'verified' } }] })
    } })
    const sources = [{ kind: 'codex-jsonl', database: sessions }]
    if (scenario.duplicate) sources.push({ kind: 'codex-jsonl-sessions', database: sessions })
    const code = await verifySync({ sources, state: statePath, endpoint: `http://127.0.0.1:${server.port}`, token: 'fixture-token', json: true })
    expect(await readFile(statePath).catch(() => undefined)).toEqual(stateBefore)
    expect(await readFile(filename)).toEqual(sourceBefore)
    return { code, report: JSON.parse(logs.at(-1)!), requests, sha256, sourceID, size: meta.size }
  } finally { log.mockRestore(); server?.stop(true); await rm(root, { recursive: true, force: true }) }
}

test('verifies all stages with matching version and authenticated read-only request', async () => {
  const result = await check()
  expect(result.code).toBe(0)
  expect(result.report).toMatchObject({ complete: true, checked: 1, incomplete: 0 })
  expect(result.requests).toEqual([{ method: 'POST', pathname: '/verify', auth: 'Bearer fixture-token', body: { files: [{ file_id: 'test-file-id', source_id: result.sourceID, path: 'session.jsonl', size: result.size, sha256: result.sha256 }] } }])
})
test('missing archive is incomplete despite local upload receipt', async () => {
  const result = await check({ archive: 'missing' })
  expect(result.code).toBe(1)
  expect(result.report.files[0].archive.status).toBe('missing')
  expect(result.report.complete).toBe(false)
})
test('missing local receipt is incomplete and does not contact receiver', async () => {
  const result = await check({ receipt: false })
  expect(result.code).toBe(1)
  expect(result.report.files[0].local.status).toBe('missing')
  expect(result.requests).toHaveLength(0)
})
test('absent state remains absent and cannot claim completeness', async () => {
  const result = await check({ missingState: true })
  expect(result.code).toBe(1)
  expect(result.report.files[0].local.status).toBe('missing')
  expect(result.requests).toHaveLength(0)
})
test('same-sized content rewrite invalidates upload receipt', async () => {
  const result = await check({ changed: true })
  expect(result.code).toBe(1)
  expect(result.report.files[0].local.status).toBe('mismatch')
  expect(result.requests).toHaveLength(0)
})
test('old receiver 404 is unknown and nonzero, with upgrade instruction', async () => {
  const result = await check({ status: 404 })
  expect(result.code).toBe(1)
  expect(result.report.files[0].archive).toMatchObject({ status: 'unknown' })
  expect(result.report.files[0].archive.reason).toContain('update the receiver')
})
test('unknown loading or indexing never passes', async () => {
  for (const stage of ['loaded', 'indexed']) {
    const result = await check({ [stage]: 'unknown' })
    expect(result.code).toBe(1)
    expect(result.report.files[0][stage].status).toBe('unknown')
  }
})
test('malformed remote response fails closed', async () => {
  const result = await check({ malformed: true })
  expect(result.code).toBe(1)
  expect(result.report.files[0].archive.reason).toContain('invalid receiver')
})
test('duplicate configured JSONL root verifies once using first source kind', async () => {
  const result = await check({ duplicate: true })
  expect(result.code).toBe(0)
  expect(result.report.checked).toBe(1)
  expect(result.requests).toHaveLength(1)
})

test('checks every discovered file even after one has a complete receipt', async () => {
  const result = await check({ additionalMissing: true })
  expect(result.code).toBe(1)
  expect(result.report).toMatchObject({ complete: false, checked: 2, incomplete: 1 })
  expect(result.report.files.find((file: any) => file.path === 'unuploaded.jsonl').local.status).toBe('missing')
  expect(result.requests).toHaveLength(1)
})
