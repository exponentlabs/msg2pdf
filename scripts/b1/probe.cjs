const { closeSync, fsyncSync, openSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const mode = process.argv[2];
if (mode === 'idle') {
  setInterval(() => {}, 1000);
} else {
  try {
    const root = process.argv[3];
    const descriptor = require('./lock.node').acquire(join(root, 'case.lock'));
    const db = new DatabaseSync(join(root, 'case.sqlite'));
    db.exec(
      'PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, label TEXT)',
    );
    const settings = {
      journal: db.prepare('PRAGMA journal_mode').get().journal_mode,
      synchronous: db.prepare('PRAGMA synchronous').get().synchronous,
      integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
      sqlite: db.prepare('SELECT sqlite_version() AS version').get().version,
    };
    if (mode === 'hold') {
      const artifact = openSync(join(root, 'source.bin'), 'wx', 0o600);
      writeFileSync(artifact, 'synthetic captured bytes');
      fsyncSync(artifact);
      closeSync(artifact);
      const directory = openSync(root, 'r');
      fsyncSync(directory);
      closeSync(directory);
      settings.artifactAndDirectorySync = true;
      db.exec(
        "BEGIN; INSERT INTO events VALUES(1, 'committed'); COMMIT; BEGIN; INSERT INTO events VALUES(2, 'uncommitted')",
      );
      const child = spawn(process.execPath, [__filename, 'idle'], {
        stdio: 'ignore',
        env: process.env,
      });
      console.log(JSON.stringify({ held: true, child: child.pid, settings }));
      setInterval(() => {}, 1000);
    } else {
      console.log(
        JSON.stringify({
          held: true,
          settings,
          rows: db.prepare('SELECT * FROM events ORDER BY id').all(),
        }),
      );
      if (mode === 'race') setInterval(() => {}, 1000);
      else {
        db.close();
        closeSync(descriptor);
      }
    }
  } catch (error) {
    console.log(JSON.stringify({ held: false, code: error.code }));
    process.exitCode = 2;
  }
}
