import { createRequire } from "node:module"

type SQLiteStatement = {
  all(...values: unknown[]): unknown[]
  get(...values: unknown[]): unknown
  run(...values: unknown[]): unknown
}

type SQLiteConnection = {
  close(): void
  exec(sql: string): void
  prepare?(sql: string): SQLiteStatement
  query?(sql: string): SQLiteStatement
  transaction?(operation: () => void): () => void
}

type SQLiteConstructor = new (filename: string) => SQLiteConnection

const runtimeRequire = createRequire(import.meta.url)

/** A synchronous SQLite boundary shared by Bun-hosted OpenCode and Node-hosted
 * Pi. Runtime modules are resolved only when a database is opened so loading a
 * disabled feature never requires the other host's built-in module. */
export class SQLiteDatabase {
  readonly connection: SQLiteConnection

  constructor(filename: string) {
    this.connection = new (sqliteConstructor())(filename)
  }

  close() {
    this.connection.close()
  }

  exec(sql: string) {
    this.connection.exec(sql)
  }

  query(sql: string) {
    const statement = this.connection.query?.(sql) ?? this.connection.prepare?.(sql)
    if (!statement) throw new Error("SQLite host does not expose prepared statements")
    return statement
  }

  transaction(operation: () => void) {
    if (this.connection.transaction) return this.connection.transaction(operation)
    return () => {
      this.connection.exec("begin immediate")
      try {
        operation()
        this.connection.exec("commit")
      } catch (error) {
        this.connection.exec("rollback")
        throw error
      }
    }
  }
}

function sqliteConstructor() {
  if (typeof Bun !== "undefined") {
    return (runtimeRequire("bun:sqlite") as { Database: SQLiteConstructor }).Database
  }
  return (runtimeRequire("node:sqlite") as { DatabaseSync: SQLiteConstructor }).DatabaseSync
}
