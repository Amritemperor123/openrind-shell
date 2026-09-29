import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, unlinkSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { BrowserFault, failure } from '@openrind/browser-contract';

export class Repository {
  constructor(path, { clock = Date.now } = {}) {
    if (!isAbsolute(path)) throw new Error('Private absolute registry path required');
    this.clock = clock; this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const lockPath = `${path}.lock`;
    let lock;
    try {
      lock = openSync(lockPath, 'wx', 0o600);
    } catch (err) {
      if (err.code === 'EEXIST') {
        let reclaim = false;
        try {
          const content = readFileSync(lockPath, 'utf8');
          const data = JSON.parse(content);
          if (data && typeof data.pid === 'number') {
            try {
              process.kill(data.pid, 0);
            } catch (killErr) {
              if (killErr.code === 'ESRCH') {
                reclaim = true;
              }
            }
          }
        } catch {
          // Unreadable lock data is not reclaimed.
        }
        if (reclaim) {
          try { unlinkSync(lockPath); } catch {}
          lock = openSync(lockPath, 'wx', 0o600);
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
    this.lock = lock;
    try {
      writeFileSync(this.lock, JSON.stringify({ pid: process.pid, startedAt: clock() }));
      this.db = new DatabaseSync(path);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`);
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 1) throw new Error('Unsupported browser registry version');
      if (version === 0) this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE grants (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, data TEXT NOT NULL, expires INTEGER NOT NULL, active INTEGER NOT NULL);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE operations (owner TEXT NOT NULL, id TEXT NOT NULL, session TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,id));
        CREATE TABLE approvals (id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE leases (id TEXT PRIMARY KEY, owner TEXT NOT NULL, session TEXT UNIQUE NOT NULL);
        CREATE TABLE audit (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, event TEXT NOT NULL, session TEXT, operation TEXT, code TEXT);
        PRAGMA user_version=1; COMMIT;`);
      this.recover();
    } catch (error) { this.db?.close(); closeSync(this.lock); unlinkSync(`${path}.lock`); throw error; }
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  session(id) { const row = this.db.prepare('SELECT data FROM sessions WHERE id=?').get(id); return row && JSON.parse(row.data); }
  sessions() { return this.db.prepare('SELECT data FROM sessions').all().map(row => JSON.parse(row.data)); }
  saveSession(value) { this.db.prepare('INSERT INTO sessions VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id, value.owner, JSON.stringify(value)); }
  operation(owner, id) { const row = this.db.prepare('SELECT data FROM operations WHERE owner=? AND id=?').get(owner, id); return row && JSON.parse(row.data); }
  saveOperation(value) { this.db.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET state=excluded.state,data=excluded.data').run(value.owner, value.id, value.session, value.hash, value.state, JSON.stringify(value)); }
  audit(event, session = null, operation = null, code = null) {
    // Deliberately no arguments, URLs, form values, credentials or raw errors.
    this.db.prepare('INSERT INTO audit(at,event,session,operation,code) VALUES(?,?,?,?,?)').run(this.clock(), event, session, operation, code);
  }
  recover() {
    this.transaction(() => {
      // Transport credentials are never enough to revive a controller on restart.
      this.db.prepare('UPDATE grants SET active=0').run();
      for (const row of this.db.prepare("SELECT data FROM operations WHERE state IN ('accepted','dispatching')").all()) {
        const op = JSON.parse(row.data);
        op.state = op.state === 'dispatching' ? 'unknown' : 'failed';
        op.result = failure(new BrowserFault(op.state === 'unknown' ? 'OUTCOME_UNKNOWN' : 'CANCELLED', op.state === 'unknown' ? 'unknown' : 'not-started'), op.id);
        this.saveOperation(op);
      }
      for (const session of this.sessions()) {
        if (['Closed', 'Failed', 'Lost'].includes(session.state)) continue;
        session.epoch++; session.transport = 'disconnected'; session.driver = 'unknown';
        session.state = ['Executing', 'Creating', 'Uncertain'].includes(session.state) ? 'Uncertain' : 'Disconnected';
        session.human = 'none'; session.handoff = null;
        this.saveSession(session);
      }
    });
  }
  close() { if (!this.db) return; this.db.close(); this.db = null; closeSync(this.lock); unlinkSync(`${this.path}.lock`); }
}
