/**
 * VectraStore integration tests.
 *
 * Each test gets its own temporary directory so tests are fully isolated.
 * All directories are removed in afterEach regardless of outcome.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VectraStore } from '../../store/vectraStore';
import type { VectorItem } from '../../store/base';

// ── helpers ───────────────────────────────────────────────────────────────────

type Meta = { text: string };

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vaultrag-store-test-'));
}

function makeStore(dir: string, onCorrupt?: (e: Error) => Promise<boolean>): VectraStore<Meta> {
  return new VectraStore<Meta>({ indexPath: dir, onCorrupt });
}

function item(id: string, vec: number[], text = ''): VectorItem<Meta> {
  return { id, vector: vec, metadata: { text } };
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('VectraStore', () => {
  let tmpDir: string;
  let store: VectraStore<Meta>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = makeStore(tmpDir);
  });

  afterEach(async () => {
    await store.close().catch(() => undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── open ──────────────────────────────────────────────────────────────────

  describe('open()', () => {
    it('creates a new index when none exists', async () => {
      await expect(store.open()).resolves.not.toThrow();
    });

    it('creates index.json on disk', async () => {
      await store.open();
      expect(fs.existsSync(path.join(tmpDir, 'index.json'))).toBe(true);
    });

    it('reopens an existing index without error', async () => {
      await store.open();
      await store.close();
      const store2 = makeStore(tmpDir);
      await expect(store2.open()).resolves.not.toThrow();
      await store2.close();
    });

    it('can be called multiple times on the same instance without error', async () => {
      await store.open();
      await expect(store.open()).resolves.not.toThrow();
    });
  });

  // ── upsert ────────────────────────────────────────────────────────────────

  describe('upsert()', () => {
    it('stores an item that is then returned by search()', async () => {
      await store.open();
      await store.upsert(item('a', [1, 0, 0], 'hello'));
      const results = await store.search([1, 0, 0], 1);
      expect(results).toHaveLength(1);
      expect(results[0].item.id).toBe('a');
    });

    it('stores metadata alongside the vector', async () => {
      await store.open();
      await store.upsert(item('a', [1, 0, 0], 'stored text'));
      const results = await store.search([1, 0, 0], 1);
      expect(results[0].item.metadata.text).toBe('stored text');
    });

    it('replaces an existing item when the same id is upserted again', async () => {
      await store.open();
      await store.upsert({ id: 'x', vector: [1, 0, 0], metadata: { text: 'v1' } });
      await store.upsert({ id: 'x', vector: [1, 0, 0], metadata: { text: 'v2' } });
      const results = await store.search([1, 0, 0], 5);
      expect(results.filter(r => r.item.id === 'x')).toHaveLength(1);
      expect(results[0].item.metadata.text).toBe('v2');
    });

    it('does not throw when upserting a zero vector', async () => {
      await store.open();
      await expect(
        store.upsert(item('zero', [0, 0, 0])),
      ).resolves.not.toThrow();
    });
  });

  // ── search ────────────────────────────────────────────────────────────────

  describe('search()', () => {
    it('returns [] when the index is empty', async () => {
      await store.open();
      await expect(store.search([1, 0, 0], 5)).resolves.toEqual([]);
    });

    it('returns [] when topK is 0', async () => {
      await store.open();
      await store.upsert(item('a', [1, 0, 0]));
      await expect(store.search([1, 0, 0], 0)).resolves.toEqual([]);
    });

    it('returns at most topK results', async () => {
      await store.open();
      for (let i = 0; i < 5; i++) {
        await store.upsert(item(`item${i}`, [i + 1, 0, 0]));
      }
      const results = await store.search([1, 0, 0], 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('returns all items when topK exceeds index size', async () => {
      await store.open();
      await store.upsert(item('a', [1, 0, 0]));
      await store.upsert(item('b', [0, 1, 0]));
      const results = await store.search([1, 0, 0], 10);
      expect(results).toHaveLength(2);
    });

    it('returns results sorted by score descending', async () => {
      await store.open();
      await store.upsert(item('far',  [0, 1, 0]));
      await store.upsert(item('near', [1, 0, 0]));
      const results = await store.search([1, 0, 0], 2);
      expect(results[0].item.id).toBe('near');
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    it('score for an exact-match vector is 1', async () => {
      await store.open();
      await store.upsert(item('exact', [0.6, 0.8, 0]));
      const results = await store.search([0.6, 0.8, 0], 1);
      expect(results[0].score).toBeCloseTo(1, 5);
    });

    it('all returned scores are finite numbers (no NaN / null)', async () => {
      await store.open();
      await store.upsert(item('a', [1, 0, 0]));
      await store.upsert(item('b', [0, 1, 0]));
      const results = await store.search([1, 0, 0], 5);
      for (const r of results) {
        expect(typeof r.score).toBe('number');
        expect(Number.isFinite(r.score)).toBe(true);
      }
    });
  });

  // ── delete ────────────────────────────────────────────────────────────────

  describe('delete()', () => {
    it('removes item so it no longer appears in search results', async () => {
      await store.open();
      await store.upsert(item('del', [1, 0, 0]));
      await store.delete('del');
      const results = await store.search([1, 0, 0], 5);
      expect(results.every(r => r.item.id !== 'del')).toBe(true);
    });

    it('resolves without error when id does not exist', async () => {
      await store.open();
      await expect(store.delete('ghost')).resolves.not.toThrow();
    });

    it('leaves other items intact after deleting one', async () => {
      await store.open();
      await store.upsert(item('keep', [1, 0, 0]));
      await store.upsert(item('gone', [0, 1, 0]));
      await store.delete('gone');
      const results = await store.search([1, 0, 0], 5);
      expect(results.some(r => r.item.id === 'keep')).toBe(true);
    });
  });

  // ── size ──────────────────────────────────────────────────────────────────

  describe('size()', () => {
    it('returns 0 for an empty index', async () => {
      await store.open();
      expect(await store.size()).toBe(0);
    });

    it('increments after each upsert of a new id', async () => {
      await store.open();
      await store.upsert(item('a', [1, 0, 0]));
      await store.upsert(item('b', [0, 1, 0]));
      expect(await store.size()).toBe(2);
    });

    it('does not increment when the same id is upserted again', async () => {
      await store.open();
      await store.upsert(item('a', [1, 0, 0]));
      await store.upsert(item('a', [1, 0, 0], 'updated'));
      expect(await store.size()).toBe(1);
    });

    it('decrements after a successful delete', async () => {
      await store.open();
      await store.upsert(item('a', [1, 0, 0]));
      await store.delete('a');
      expect(await store.size()).toBe(0);
    });

    it('stays the same after deleting a non-existent id', async () => {
      await store.open();
      await store.upsert(item('a', [1, 0, 0]));
      await store.delete('ghost');
      expect(await store.size()).toBe(1);
    });
  });

  // ── persistence ───────────────────────────────────────────────────────────

  describe('persistence', () => {
    it('items survive a close → reopen cycle', async () => {
      await store.open();
      await store.upsert(item('persisted', [1, 0, 0], 'hello'));
      await store.close();

      const store2 = makeStore(tmpDir);
      await store2.open();
      const results = await store2.search([1, 0, 0], 1);
      expect(results).toHaveLength(1);
      expect(results[0].item.id).toBe('persisted');
      expect(results[0].item.metadata.text).toBe('hello');
      await store2.close();
    });

    it('deletes survive a close → reopen cycle', async () => {
      await store.open();
      await store.upsert(item('a', [1, 0, 0]));
      await store.upsert(item('b', [0, 1, 0]));
      await store.delete('a');
      await store.close();

      const store2 = makeStore(tmpDir);
      await store2.open();
      const results = await store2.search([1, 0, 0], 5);
      expect(results.every(r => r.item.id !== 'a')).toBe(true);
      expect(results.some(r => r.item.id === 'b')).toBe(true);
      await store2.close();
    });

    it('size is correct after close → reopen', async () => {
      await store.open();
      await store.upsert(item('a', [1, 0, 0]));
      await store.upsert(item('b', [0, 1, 0]));
      await store.close();

      const store2 = makeStore(tmpDir);
      await store2.open();
      expect(await store2.size()).toBe(2);
      await store2.close();
    });
  });

  // ── corrupt index ─────────────────────────────────────────────────────────

  describe('corrupt index handling', () => {
    async function buildAndCorrupt(): Promise<void> {
      await store.open();
      await store.upsert(item('x', [1, 0, 0]));
      await store.close();
      fs.writeFileSync(path.join(tmpDir, 'index.json'), 'NOT VALID JSON {{{');
    }

    it('calls onCorrupt when index.json is malformed', async () => {
      await buildAndCorrupt();
      const onCorrupt = jest.fn().mockResolvedValue(false);
      const bad = makeStore(tmpDir, onCorrupt);
      await bad.open().catch(() => undefined);
      expect(onCorrupt).toHaveBeenCalledTimes(1);
      expect(onCorrupt.mock.calls[0][0]).toBeInstanceOf(Error);
    });

    it('throws when onCorrupt returns false (user declines rebuild)', async () => {
      await buildAndCorrupt();
      const bad = makeStore(tmpDir, () => Promise.resolve(false));
      await expect(bad.open()).rejects.toThrow();
    });

    it('throws when no onCorrupt handler is provided', async () => {
      await buildAndCorrupt();
      const bad = makeStore(tmpDir);
      await expect(bad.open()).rejects.toThrow();
    });

    it('rebuilds an empty index when onCorrupt returns true', async () => {
      await buildAndCorrupt();
      const good = makeStore(tmpDir, () => Promise.resolve(true));
      await expect(good.open()).resolves.not.toThrow();
      expect(await good.size()).toBe(0);
      await good.close();
    });

    it('rebuilt index is fully functional (upsert + search)', async () => {
      await buildAndCorrupt();
      const good = makeStore(tmpDir, () => Promise.resolve(true));
      await good.open();
      await good.upsert(item('fresh', [1, 0, 0], 'after rebuild'));
      const results = await good.search([1, 0, 0], 1);
      expect(results[0].item.id).toBe('fresh');
      await good.close();
    });

    it('rebuilt index persists across a subsequent close → reopen', async () => {
      await buildAndCorrupt();
      const good = makeStore(tmpDir, () => Promise.resolve(true));
      await good.open();
      await good.upsert(item('fresh', [1, 0, 0]));
      await good.close();

      const store2 = makeStore(tmpDir);
      await store2.open();
      expect(await store2.size()).toBe(1);
      await store2.close();
    });
  });
});
