import { Worker } from 'node:worker_threads';

export class ForecastHistory {
  constructor(file, { maxBytes } = {}) {
    this.pending = new Map();
    this.sequence = 0;
    this.error = null;
    this.worker = new Worker(new URL('./history-worker.js', import.meta.url), { workerData: { file, maxBytes } });
    this.ready = new Promise((resolve, reject) => {
      this.worker.on('message', message => {
        if (message.ready) { resolve(); return; }
        if (message.error && !message.id) { this.fail(message.error); reject(new Error(message.error)); return; }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) { this.error = message.error; pending.reject(new Error(message.error)); }
        else pending.resolve(message.result);
      });
      this.worker.on('error', () => { this.fail('History worker failed'); reject(new Error(this.error)); });
      this.worker.on('exit', code => { if (code !== 0) this.fail('History worker stopped'); });
    });
    this.ready.catch(() => {});
  }

  fail(reason) {
    this.error = reason;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear();
  }

  async call(op, data = {}) {
    await this.ready;
    if (this.error) throw new Error(this.error);
    if (this.pending.size >= 128) { this.fail('History queue full'); throw new Error(this.error); }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.fail('History operation timed out'); this.worker.terminate(); }, 15_000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, op, ...data });
    });
  }

  append(record) { return this.call('append', { record }); }
  load(since) { return this.call('load', { since }); }
  compact(now) { return this.call('compact', { now }); }
  async close() {
    let timer;
    if (!this.error) await Promise.race([
      this.call('close').catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, 1000); }),
    ]);
    clearTimeout(timer);
    this.fail('History closed');
    await this.worker.terminate();
  }
}
