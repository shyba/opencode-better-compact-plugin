import { describe, expect, test } from "bun:test"
import { uploadFenced } from "../src/postgres.js"
import type { OutboxRow } from "../src/sync-state.js"

function fakeClient(remoteRevision = 0) {
  const calls: string[] = []
  const client = {
    calls,
    unsafe: async <T>(query: string): Promise<T> => {
      calls.push(query)
      if (query.includes("for update")) return [{ incarnation: "source-inc", remote_revision_high_water: remoteRevision }] as T
      return [] as T
    },
    begin: async <T>(callback: (transaction: typeof client) => Promise<T>) => callback(client),
    close: async () => {},
  }
  return client
}

const source = { installationID: "install", installationIncarnation: "install-inc", sourceID: "source", incarnation: "source-inc", expectedRevision: 0 }
const row = (recordRevision: number): OutboxRow => ({ id: recordRevision, destinationID: "postgres", sourceID: "source", recordKind: "session", naturalKey: `s${recordRevision}`, payloadJSON: JSON.stringify({ title: "safe" }), routingJSON: "{}", payloadSHA256: "hash", recordRevision, operation: "upsert", attempts: 1, observedAt: 1 })

describe("Postgres delivery fences", () => {
  test("applies a contiguous batch and advances its source fence", async () => {
    const client = fakeClient()
    const highWater = await uploadFenced(client, source, [row(1), row(2)])
    expect(highWater).toBe(2)
    expect(client.calls.some((query) => query.includes("remote_revision_high_water=$1"))).toBe(true)
  })

  test("rejects a revision gap before applying the later record", async () => {
    await expect(uploadFenced(fakeClient(), source, [row(1), row(3)])).rejects.toThrow("non-contiguous")
  })
})
