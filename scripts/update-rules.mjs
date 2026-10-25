import { constants, closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readRulesSnapshot } from '../rules.js';

const [candidate, destination] = process.argv.slice(2);
if (!candidate || !destination || process.argv.length !== 4) {
  console.error('Usage: node scripts/update-rules.mjs /absolute/private/candidate.json /absolute/private/rules.json');
  process.exitCode = 1;
} else {
  const target = resolve(destination);
  const temp = `${target}.pending-${randomBytes(8).toString('hex')}`;
  let pending = false;
  try {
    if (target !== destination || resolve(candidate) !== candidate || candidate === target) throw new Error('Use distinct absolute normalized paths');
    const parent = lstatSync(dirname(target));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o077)) throw new Error('Destination parent must be an owner-private directory');
    // The same permissions/schema checker used by the runtime, without treating
    // this maintainer working directory as the monitored writer workspace.
    const outside = '/__advisory_rules_validation_only__';
    const next = readRulesSnapshot(candidate, outside);
    const bytes = next.bytes;
    const existing = () => {
      try { return readRulesSnapshot(target, outside); }
      catch (error) {
        if (error.code === 'ENOENT') return null;
        if (error.revision) return { revision: error.revision, bytes: error.snapshotBytes, config: null };
        throw error;
      }
    };
    const current = existing();
    if (current && current.revision === next.revision) {
      console.log(`Unchanged: ${next.revision}`);
    } else {
      if (current) {
        if (current.config?.revision === next.config.revision) throw new Error('Bump the human-readable revision for an edited rules file');
        const backup = `${target}.backup-${Date.now()}-${randomBytes(4).toString('hex')}`;
        const previous = current.bytes;
        writeFileSync(backup, previous, { flag: 'wx', mode: 0o600 });
        if (!readFileSync(backup).equals(previous)) throw new Error('Backup verification failed');
        const backupFD = openSync(backup, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { fsyncSync(backupFD); } finally { closeSync(backupFD); }
        console.log(`Verified backup: ${backup}`);
        if (!current.config) console.log('Repairing invalid data only after preserving its exact bytes');
      }
      writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
      pending = true;
      if (readRulesSnapshot(temp, outside).revision !== next.revision) throw new Error('Candidate changed while preparing update');
      const live = existing()?.revision ?? null;
      if (live !== (current?.revision ?? null)) throw new Error('Concurrent rules update; refusing overwrite');
      const fd = openSync(temp, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, target);
      pending = false;
      console.log(`Installed rules ${next.config.revision}: ${next.revision}; picked up at the next active context boundary`);
    }
  } catch (error) {
    console.error(`Rules update rejected: ${error.code ?? error.message}`);
    process.exitCode = 1;
  } finally {
    if (pending) unlinkSync(temp);
  }
}
