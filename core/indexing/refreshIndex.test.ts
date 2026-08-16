import * as fs from "node:fs";

import { getIndexSqlitePath } from "../util/paths";
import {
  DatabaseConnection,
  SqliteDb,
  truncateToLastNBytes,
} from "./refreshIndex";

type SqliteDbTestInternals = {
  closingPromise?: Promise<void> | null;
  createTables(db: DatabaseConnection): Promise<void>;
  initializationPromise?: Promise<DatabaseConnection> | null;
};

const sqliteDbInternals = SqliteDb as unknown as SqliteDbTestInternals;

async function resetSqliteDb() {
  const db = SqliteDb.db;
  SqliteDb.db = null;
  sqliteDbInternals.closingPromise = null;
  sqliteDbInternals.initializationPromise = null;
  if (db) {
    await db.close();
  }
  fs.rmSync(getIndexSqlitePath(), { force: true });
}

describe("SqliteDb", () => {
  beforeEach(async () => {
    await resetSqliteDb();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await resetSqliteDb();
  });

  it("does not expose the connection before schema initialization completes", async () => {
    const originalCreateTables = sqliteDbInternals.createTables.bind(SqliteDb);
    let releaseCreateTables!: () => void;
    const createTablesGate = new Promise<void>((resolve) => {
      releaseCreateTables = resolve;
    });
    let observeCreateTables!: () => void;
    const createTablesEntered = new Promise<void>((resolve) => {
      observeCreateTables = resolve;
    });

    jest
      .spyOn(sqliteDbInternals, "createTables")
      .mockImplementation(async (db) => {
        observeCreateTables();
        await createTablesGate;
        await originalCreateTables(db);
      });

    const firstConnection = SqliteDb.get();
    await createTablesEntered;

    let secondConnectionResolved = false;
    const secondConnection = SqliteDb.get().then((db) => {
      secondConnectionResolved = true;
      return db;
    });

    let resolvedBeforeSchemaInitialization: boolean | undefined;
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      resolvedBeforeSchemaInitialization = secondConnectionResolved;
    } finally {
      releaseCreateTables();
    }

    const [firstDb, secondDb] = await Promise.all([
      firstConnection,
      secondConnection,
    ]);
    expect(secondDb).toBe(firstDb);
    expect(resolvedBeforeSchemaInitialization).toBe(false);

    const tables = (await firstDb.all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?) ORDER BY name",
      "global_cache",
      "indexing_lock",
      "tag_catalog",
    )) as { name: string }[];
    expect(tables.map(({ name }) => name)).toEqual([
      "global_cache",
      "indexing_lock",
      "tag_catalog",
    ]);
  });

  it("allows initialization to retry after schema creation fails", async () => {
    const originalCreateTables = sqliteDbInternals.createTables.bind(SqliteDb);
    const createTables = jest
      .spyOn(sqliteDbInternals, "createTables")
      .mockImplementation(originalCreateTables);
    createTables.mockRejectedValueOnce(
      new Error("schema initialization failed"),
    );

    await expect(SqliteDb.get()).rejects.toThrow(
      "schema initialization failed",
    );
    expect(SqliteDb.db).toBeNull();
    expect(sqliteDbInternals.initializationPromise).toBeNull();

    const db = await SqliteDb.get();
    const table = (await db.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      "indexing_lock",
    )) as { name: string } | undefined;
    expect(table?.name).toBe("indexing_lock");
  });
});

describe("truncateToLastNBytes", () => {
  it("should return full string if maxBytes greater than string byte length", () => {
    const input = "Hello World";
    const result = truncateToLastNBytes(input, 100);
    expect(result).toBe("Hello World");
  });

  it("should truncate ASCII string correctly", () => {
    const input = "Hello World";
    const result = truncateToLastNBytes(input, 5);
    expect(result).toBe("World");
  });

  it("should handle empty string", () => {
    const input = "";
    const result = truncateToLastNBytes(input, 5);
    expect(result).toBe("");
  });

  it("should handle UTF-8 characters correctly", () => {
    const input = "👋 Hello";
    // 👋 is 4 bytes, space is 1 byte
    const result = truncateToLastNBytes(input, 5);
    expect(result).toBe("Hello");
  });

  it("should handle maxBytes of 0", () => {
    const input = "Hello World";
    const result = truncateToLastNBytes(input, 0);
    expect(result).toBe("");
  });
});
