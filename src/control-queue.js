/**
 * One in-process chain for everything that writes operator settings or
 * republishes what they say: the dashboard's saves, the TUI's settings save and
 * route editor, the MCP setting and account tools, and a bare reload (the TUI's
 * 'R' key, POST /teamclaude/reload, the CLI's notify after add/change).
 * Interleaved, a reload that read disk before a write can finish after it and
 * publish a table the file no longer holds, and a save built from a stale
 * in-memory copy can put an old value back on disk after another writer
 * reported success. So they take turns.
 *
 * Nothing here is cross-process: a CLI writing the config while the server
 * writes it is still the two of them racing, and atomicConfigUpdate's re-read
 * plus an endpoint's precondition are what make that race visible.
 *
 * A unit must never wait on another unit: the second one runs only after the
 * first settles, so the first would wait forever. Code already inside a unit
 * calls the unqueued `reload` it was built from, never `reloadQueued` (which is
 * what `hooks.reload` is), the TUI's `saveConfig`/`serialize` or an MCP tool.
 */

import {
  QUOTA_BUCKETS, resetAccountBuckets, setAccountBuckets, setBucketThresholds, thresholdTable,
} from './config-ops.js';
import { sanitizeSwitchThreshold } from './model.js';

/**
 * @param {string} code
 * @param {string} message
 */
export const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * @param {() => Promise<unknown>} reload re-reads the config and applies it,
 *   unqueued; the queue is what serializes it
 */
export function createControlQueue(reload) {
  /** @type {Promise<void>} */
  let chain = Promise.resolve();

  /**
   * Run `fn` once every unit queued before it has settled, whether or not
   * they succeeded.
   * @template T
   * @param {() => T|Promise<T>} fn
   * @returns {Promise<T>}
   */
  const queued = fn => {
    const result = chain.then(fn, fn);
    chain = result.then(() => {}, () => {});
    return result;
  };

  /**
   * A settings write and the reload that applies it, as one unit. Resolves to
   * the write's result. A refusal from the write reaches the caller as thrown,
   * with nothing reloaded; a failed reload is `reload-failed`, because the
   * write has landed and the caller needs to say so.
   * @template T
   * @param {() => T|Promise<T>} write
   * @returns {Promise<T>}
   */
  const applyChange = write => queued(async () => {
    const out = await write();
    try {
      await reload();
    } catch (err) {
      throw fail('reload-failed', err instanceof Error ? err.message : String(err));
    }
    return out;
  });

  return { queued, applyChange, reloadQueued: () => queued(reload) };
}

// The keys a threshold or cap table is compared on: what the dashboard reads
// back and the LAN relay forwards. The router looks up nothing else, so an
// unknown or typo key on disk is left where it is and cannot turn every save
// into a conflict.
const LIMIT_KEYS = ['default', ...QUOTA_BUCKETS];

/**
 * Whether two stored limits (a number, a per-bucket table, or null) are the
 * same on the known keys, whatever order they were written in.
 * @param {unknown} a
 * @param {unknown} b
 */
export function sameLimit(a, b) {
  const canon = (/** @type {any} */ v) => v && typeof v === 'object' && !Array.isArray(v)
    ? LIMIT_KEYS.filter(k => Object.hasOwn(v, k)).map(k => [k, v[k]])
    : v ?? null;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/**
 * The dashboard's limit writers: an account's threshold and cap, and the fleet
 * threshold table. Each is one preconditioned config update plus one reload,
 * as one applyChange unit, and resolves to the values the update stored. On a
 * mismatch the file is published first (as the force endpoint does), so the
 * caller's 409 can show what the next status shows. Inside the unit the reload
 * is the unqueued one: we already hold the queue.
 * @param {{
 *   applyChange: <T>(write: () => T|Promise<T>) => Promise<T>,
 *   reload: () => Promise<unknown>,
 *   update: (updater: (disk: Record<string, any>) => Promise<void>|void) => Promise<unknown>,
 *   hasAccount: (id: string) => boolean,
 * }} deps `update` is atomicConfigUpdate; `hasAccount` asks the running fleet
 */
export function createLimitWriters({ applyChange, reload, update, hasAccount }) {
  /**
   * @template T
   * @param {(disk: Record<string, any>) => T} edit
   * @returns {() => Promise<T>}
   */
  const preconditioned = edit => async () => {
    /** @type {T|undefined} */
    let out;
    try {
      await update(disk => { out = JSON.parse(JSON.stringify(edit(disk))); });
    } catch (err) {
      if (/** @type {{ code?: string }} */ (err).code === 'changed-elsewhere') {
        try { await reload(); } catch { /* still a stale write */ }
      }
      throw err;
    }
    return /** @type {T} */ (out);
  };

  return {
    /**
     * By config entry id. The threshold is compared as status shows it,
     * sanitised, so an account with an out-of-range hand edit can still be
     * saved; the cap is sent raw and compared raw.
     * @param {{ id: string, expected: Record<string, any>, switchThreshold?: any, maxUsage?: any }} change
     */
    saveAccountLimits: ({ id, expected, switchThreshold, maxUsage }) => applyChange(async () => {
      if (!hasAccount(id)) throw fail('no-such-account', `no account with id "${id}"`);
      return preconditioned(disk => {
        const row = (disk.accounts || []).find((/** @type {any} */ a) => a?.id === id);
        if (!row) throw fail('no-such-account', `no config entry with id "${id}"`);
        if (!sameLimit(sanitizeSwitchThreshold(row.switchThreshold).value, expected.switchThreshold)
          || !sameLimit(row.maxUsage ?? null, expected.maxUsage)) {
          throw fail('changed-elsewhere', `account "${id}" limits changed since they were read`);
        }
        for (const [field, change] of /** @type {Array<[string, any]>} */ ([['switchThreshold', switchThreshold], ['maxUsage', maxUsage]])) {
          if (!change) continue;
          if (change.reset) resetAccountBuckets(row, field); else setAccountBuckets(row, field, change.pairs);
        }
        return { switchThreshold: row.switchThreshold ?? null, maxUsage: row.maxUsage ?? null };
      })();
    }),
    /**
     * Patched bucket by bucket. Both sides are compared as full tables, so a
     * stored table without `default` matches the
     * `{ default: status.switchThreshold, ...status.switchThresholds }` the page sends.
     * @param {{ expected: unknown, pairs: Array<[string, number|null]> }} change
     */
    saveFleetThreshold: ({ expected, pairs }) => applyChange(preconditioned(disk => {
      if (!sameLimit(thresholdTable(disk.switchThreshold), thresholdTable(expected))) {
        throw fail('changed-elsewhere', 'the fleet threshold changed since it was read');
      }
      setBucketThresholds(disk, pairs);
      return { switchThreshold: disk.switchThreshold };
    })),
  };
}
