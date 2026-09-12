import { parentPort, workerData } from 'node:worker_threads';
import { mkdirSync, chmodSync, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const quote = value => `'${String(value).replaceAll("'", "''")}'`;
let db;
let execute;
let query;
try {
  mkdirSync(dirname(workerData.file), { recursive: true, mode: 0o700 });
  const maxBytes = workerData.maxBytes || 250 * 1024 * 1024;
  if (existsSync(workerData.file) && statSync(workerData.file).size > maxBytes / 2) throw new Error('History exceeds disk limit');
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(workerData.file);
    execute = sql => db.exec(sql);
    query = sql => db.prepare(sql).all();
  } catch (err) {
    if (err.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw err;
    const run = sql => {
      const result = spawnSync('sqlite3', ['-batch', '-json', workerData.file], {
        input: `.timeout 2000\n${sql}`, encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024,
      });
      if (result.error || result.status !== 0) throw new Error('SQLite unavailable or history inaccessible');
      return result.stdout.trim();
    };
    execute = sql => { run(sql); };
    query = sql => JSON.parse(run(sql) || '[]');
  }
  const pageSize = Object.values(query('PRAGMA page_size;')[0])[0];
  execute(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000;
    PRAGMA max_page_count=${Math.max(1, Math.floor((maxBytes / 2 - 65536) / pageSize))};
    CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, at INTEGER NOT NULL,
      subscription TEXT, pending INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS records_time ON records(kind, at);
    CREATE INDEX IF NOT EXISTS records_subscription ON records(subscription, at);`);
  chmodSync(workerData.file, 0o600);
  const integrity = query('PRAGMA quick_check;');
  if (Object.values(integrity[0] || {})[0] !== 'ok') throw new Error('Corrupt history');
  parentPort.postMessage({ ready: true });
  parentPort.on('message', message => {
    try {
      let result = null;
      if (message.op === 'append' || message.op === 'appendMany') {
        const rows = message.op === 'append' ? [message.record] : message.records;
        if (rows.length > 2000) throw new Error('Too many history records');
        const inserts = rows.map(r => {
          const encoded = JSON.stringify(r);
          if (encoded.length > 2 * 1024 * 1024) throw new Error('History record too large');
          return `INSERT OR IGNORE INTO records VALUES (${quote(r.id)},${quote(r.kind)},${Math.floor(r.at)},
            ${r.subscription ? quote(r.subscription) : 'NULL'},${r.pending ? 1 : 0},${quote(encoded)});`;
        });
        execute(`BEGIN; ${inserts.join('\n')} COMMIT;`);
      } else if (message.op === 'load') {
        result = query(`SELECT data FROM records WHERE kind='observation' AND at >= ${Math.floor(message.since)}
          ORDER BY at DESC LIMIT 20000;`).map(row => JSON.parse(row.data)).reverse();
      } else if (message.op === 'pending') {
        result = query("SELECT data FROM records WHERE kind='prediction' AND pending=1 ORDER BY at LIMIT 20000;")
          .map(row => JSON.parse(row.data));
      } else if (message.op === 'settle') {
        const r = message.record;
        execute(`BEGIN; INSERT OR IGNORE INTO records VALUES (${quote(r.id)},'outcome',${Math.floor(r.at)},
          ${quote(r.subscription)},1,${quote(JSON.stringify(r))});
          UPDATE records SET pending=0 WHERE id=${quote(r.predictionId)}; COMMIT;`);
      } else if (message.op === 'scores') {
        result = query("SELECT data FROM records WHERE kind='outcome' ORDER BY at DESC LIMIT 20000;").map(row => JSON.parse(row.data));
      } else if (message.op === 'compact') {
        const day = 86400_000;
        execute(`INSERT OR IGNORE INTO records SELECT 'summary:' || id, 'summary', at, subscription, 0, data FROM records
          WHERE kind='observation' AND at < ${Math.floor(message.now - 30 * day)}
          GROUP BY subscription, CAST(at / 300000 AS INTEGER);
          DELETE FROM records WHERE pending=0 AND at < ${Math.floor(message.now - 90 * day)};
          DELETE FROM records WHERE kind='observation' AND at < ${Math.floor(message.now - 30 * day)}
          AND id NOT IN (SELECT id FROM records r WHERE r.kind='observation' AND r.at =
            (SELECT MAX(a.at) FROM records a WHERE a.subscription=r.subscription AND a.kind='observation'));
          PRAGMA incremental_vacuum;`);
      } else if (message.op === 'close') {
        db?.close();
      } else throw new Error('Unknown history operation');
      parentPort.postMessage({ id: message.id, result });
      if (message.op === 'close') parentPort.close();
    } catch {
      try { execute('ROLLBACK;'); } catch { /* No transaction may be active. */ }
      parentPort.postMessage({ id: message.id, error: 'History storage failed; retained database needs inspection' });
    }
  });
} catch {
  db?.close();
  parentPort.postMessage({ error: 'History unavailable; SQLite and retained database need inspection' });
  parentPort.close();
}
