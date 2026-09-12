import { parentPort, workerData } from 'node:worker_threads';
import { mkdirSync, chmodSync, existsSync, statSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const quote = value => `'${String(value).replaceAll("'", "''")}'`;
let db;
let execute;
let query;
let pageLimit = null;
try {
  mkdirSync(dirname(workerData.file), { recursive: true, mode: 0o700 });
  const maxBytes = workerData.maxBytes || 250 * 1024 * 1024;
  if (existsSync(workerData.file) && statSync(workerData.file).size > maxBytes / 2) throw new Error('History exceeds disk limit');
  try { closeSync(openSync(workerData.file, 'ax', 0o600)); } catch (err) { if (err.code !== 'EEXIST') throw err; }
  chmodSync(workerData.file, 0o600);
  const fresh = statSync(workerData.file).size === 0;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(workerData.file);
    execute = sql => db.exec(sql);
    query = sql => db.prepare(sql).all();
  } catch (err) {
    if (err.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw err;
    const run = sql => {
      const nullOutput = process.platform === 'win32' ? 'NUL' : '/dev/null';
      const settings = pageLimit ? `.output ${nullOutput}\nPRAGMA max_page_count=${pageLimit}; PRAGMA synchronous=FULL;\n.output stdout\n` : '';
      const result = spawnSync('sqlite3', ['-batch', '-json', workerData.file], {
        input: `.timeout 2000\n${settings}${sql}`, encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024,
      });
      if (result.error || result.status !== 0) throw new Error('SQLite unavailable or history inaccessible');
      return result.stdout.trim();
    };
    execute = sql => { run(sql); };
    query = sql => JSON.parse(run(sql) || '[]');
  }
  const pageSize = Object.values(query('PRAGMA page_size;')[0])[0];
  pageLimit = Math.max(1, Math.floor((maxBytes / 2 - 65536) / pageSize));
  execute(`${fresh ? 'PRAGMA auto_vacuum=INCREMENTAL;' : ''}
    PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000;
    PRAGMA max_page_count=${pageLimit};
    CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, at INTEGER NOT NULL,
      subscription TEXT, pending INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS records_time ON records(kind, at);
    CREATE INDEX IF NOT EXISTS records_subscription ON records(subscription, at);`);
  chmodSync(workerData.file, 0o600);
  const integrity = query('PRAGMA quick_check;');
  if (Object.values(integrity[0] || {})[0] !== 'ok') throw new Error('Corrupt history');
  const loadRecords = (where, order = 'at DESC, id DESC') => {
    const rows = [];
    for (let offset = 0; offset < 20000; offset += 250) {
      const page = query(`SELECT data FROM records WHERE ${where} ORDER BY ${order} LIMIT 250 OFFSET ${offset};`);
      rows.push(...page.map(row => JSON.parse(row.data)));
      if (page.length < 250) break;
    }
    return rows;
  };
  const trimBudget = (incomingBytes = 0) => {
    let loss = JSON.parse(query("SELECT data FROM records WHERE id='coverage-loss';")[0]?.data || '{"counts":{},"subscriptions":[]}');
    let changed = false;
    for (let attempt = 0; attempt < 16; attempt++) {
      const pages = Object.values(query('PRAGMA page_count;')[0])[0];
      const free = Object.values(query('PRAGMA freelist_count;')[0])[0];
      if ((pages - free) * pageSize + incomingBytes * 2 < pageLimit * pageSize * 0.8) break;
      const victims = query(`SELECT id, kind, subscription FROM records WHERE kind IN ('forecast','summary','outcome','observation','prediction')
        AND (kind != 'observation' OR at < (SELECT MAX(a.at) FROM records a WHERE a.kind='observation' AND a.subscription=records.subscription))
        ORDER BY pending, CASE WHEN kind='prediction' AND pending=0 THEN 0 WHEN kind='forecast' THEN 1
          WHEN kind='summary' THEN 2 WHEN kind='observation' THEN 3 WHEN kind='outcome' THEN 4 ELSE 5 END, at LIMIT 512;`);
      if (!victims.length) break;
      for (const row of victims) {
        loss.counts[row.kind] = (loss.counts[row.kind] || 0) + 1;
        if (row.subscription && !loss.subscriptions.includes(row.subscription) && loss.subscriptions.length < 100) loss.subscriptions.push(row.subscription);
      }
      execute(`DELETE FROM records WHERE id IN (${victims.map(row => quote(row.id)).join(',')});`);
      changed = true;
    }
    if (changed) {
      loss = { ...loss, at: Date.now(), reason: 'Disk budget', evaluationGateDeferred: true };
      execute(`INSERT OR REPLACE INTO records VALUES ('coverage-loss','coverage-loss',${loss.at},NULL,1,${quote(JSON.stringify(loss))});`);
    }
  };
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
        const bytes = inserts.reduce((sum, sql) => sum + Buffer.byteLength(sql), 0);
        if (bytes > 4 * 1024 * 1024) throw new Error('History batch too large');
        trimBudget(bytes);
        execute(`BEGIN; ${inserts.join('\n')} COMMIT;`);
      } else if (message.op === 'load') {
        result = loadRecords(`kind='observation' AND at >= ${Math.floor(message.since)}`).reverse();
      } else if (message.op === 'pending') {
        result = loadRecords("kind='prediction' AND pending=1", 'at, id');
      } else if (message.op === 'settle') {
        const r = message.record;
        trimBudget(Buffer.byteLength(JSON.stringify(r)));
        execute(`BEGIN; INSERT OR IGNORE INTO records VALUES (${quote(r.id)},'outcome',${Math.floor(r.at)},
          ${quote(r.subscription)},1,${quote(JSON.stringify(r))});
          DELETE FROM records WHERE id=${quote(r.predictionId)} AND kind='prediction'; COMMIT;`);
      } else if (message.op === 'scores') {
        result = loadRecords("kind='outcome'");
      } else if (message.op === 'coverage') {
        result = JSON.parse(query("SELECT data FROM records WHERE id='coverage-loss';")[0]?.data || 'null');
      } else if (message.op === 'summaries') {
        result = loadRecords("kind='summary'");
      } else if (message.op === 'compact') {
        const day = 86400_000;
        execute(`UPDATE records SET kind='summary' WHERE kind='observation' AND at < ${Math.floor(message.now - 30 * day)}
          AND id NOT IN (SELECT id FROM records r WHERE r.kind='observation' AND r.at =
            (SELECT MAX(a.at) FROM records a WHERE a.subscription=r.subscription AND a.kind='observation'));
          DELETE FROM records WHERE kind='summary' AND id NOT IN
            (SELECT MIN(id) FROM records WHERE kind='summary' GROUP BY subscription, CAST(at / 300000 AS INTEGER));
          DELETE FROM records WHERE kind='prediction' AND pending=0;
          DELETE FROM records WHERE pending=0 AND kind != 'observation' AND at < ${Math.floor(message.now - 90 * day)};
          PRAGMA incremental_vacuum;`);
        trimBudget();
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
