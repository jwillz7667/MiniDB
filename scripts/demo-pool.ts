import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PAGE_SIZE } from "../src/constants.js";
import { BufferPool } from "../src/storage/bufferpool.js";
import { Pager } from "../src/storage/pager.js";

/**
 * Phase 1 demo: write 10,000 pages, then hammer them with a hot/cold access
 * pattern (90% of reads target the hottest 10% of pages) through a buffer pool
 * far smaller than the data set, and report the clock-eviction hit rate.
 */
const PAGES = 10_000;
const POOL_FRAMES = 1_500; // larger than the hot set, smaller than the data
const READS = 200_000;
const HOT_FRACTION = 0.1;

const dir = mkdtempSync(join(tmpdir(), "minidb-demo-pool-"));
const path = join(dir, "pool.minidb");
try {
  const pager = Pager.open(path);
  const pool = new BufferPool(pager, POOL_FRAMES);

  const pageNos: number[] = [];
  for (let i = 0; i < PAGES; i++) {
    const pageNo = pool.allocatePage();
    const page = pool.fetchPage(pageNo);
    page.writeUInt32LE(pageNo, 0);
    pool.unpin(pageNo, true);
    pageNos.push(pageNo);
  }
  pool.flushAll();
  pool.resetStats();

  const hotCount = Math.floor(PAGES * HOT_FRACTION);
  let seed = 1234567;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let i = 0; i < READS; i++) {
    const hot = rand() < 0.9;
    const pageNo = hot ? 1 + Math.floor(rand() * hotCount) : 1 + Math.floor(rand() * PAGES);
    const page = pool.fetchPage(pageNo);
    if (page.readUInt32LE(0) !== pageNo) throw new Error(`page ${pageNo} corrupted`);
    pool.unpin(pageNo, false);
  }

  process.stdout.write(`minidb buffer-pool demo\n`);
  process.stdout.write(`  data set   : ${PAGES} pages (${((PAGES * PAGE_SIZE) / 1e6).toFixed(1)} MB)\n`);
  process.stdout.write(`  pool size  : ${POOL_FRAMES} frames (${((POOL_FRAMES * PAGE_SIZE) / 1e6).toFixed(1)} MB)\n`);
  process.stdout.write(`  workload   : ${READS} reads, 90% into the hottest ${(HOT_FRACTION * 100).toFixed(0)}%\n`);
  process.stdout.write(`  hits       : ${pool.hitCount}\n`);
  process.stdout.write(`  misses     : ${pool.missCount}\n`);
  process.stdout.write(`  hit rate   : ${(pool.hitRate() * 100).toFixed(1)}%  (clock eviction)\n`);

  pager.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
