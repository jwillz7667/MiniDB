import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Test helper: a throwaway directory for database files, plus stable paths for
 * the data file and its WAL sibling. Call `cleanup()` in afterEach.
 */
export interface TempDb {
  readonly dir: string;
  readonly path: string;
  readonly walPath: string;
  cleanup(): void;
}

export function makeTempDb(name = "db"): TempDb {
  const dir = mkdtempSync(join(tmpdir(), "minidb-test-"));
  const path = join(dir, `${name}.minidb`);
  return {
    dir,
    path,
    walPath: `${path}-wal`,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
