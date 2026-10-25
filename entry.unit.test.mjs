// Wiring-only Effect test double. This is NOT a native host/Effect compatibility test.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  .replace("import { Effect, Stream } from 'effect';", 'const { Effect, Stream } = globalThis.__advisoryEntryTest;')
  .replace("'./core.js'", JSON.stringify(new URL('./core.js', import.meta.url).href));

test('entry registers global locations, preserves selected/default-off gates and disposes hooks', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'advisory-entry-'));
  const effect = (run) => ({ run, *[Symbol.iterator]() { return yield this; } });
  let finalizers = [], registrations = [], warnings = [];
  const execute = async (value) => value.run();
  const Effect = {
    gen: (fn) => effect(async () => {
      const gen = fn();
      let step = gen.next();
      while (!step.done) step = gen.next(await execute(step.value));
      return step.value;
    }),
    sync: (fn) => effect(fn),
    promise: (fn) => effect(fn),
    context: () => effect(() => ({})),
    addFinalizer: (fn) => effect(() => { finalizers.push(fn); }),
    logWarning: (message) => effect(() => warnings.push(message)),
    logError: (message) => effect(() => assert.fail(message)),
    runPromiseWith: () => (value, { signal }) => new Promise((resolve) => {
      assert.equal(value.stream, true);
      signal.addEventListener('abort', resolve, { once: true });
    }),
  };
  const hook = (name, callback) => effect(() => {
    const entry = { name, callback, disposed: false };
    registrations.push(entry);
    return { dispose: effect(() => { entry.disposed = true; }) };
  });
  globalThis.__advisoryEntryTest = { Effect, Stream: { runForEach: () => ({ stream: true }) } };
  try {
    const { default: plugin } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
    for (const options of [
      {}, { scope: 'all' },
      { timer: { enabled: true }, auditPath: join(temp, 'unused'), locations: [{
        directory: '/elsewhere', sessions: ['s'], providers: ['p'], models: ['m'],
      }] },
      { scope: 'all', locations: [], timer: { enabled: true }, auditPath: join(temp, 'unused') },
      { scope: 'all', observer: { enabled: true }, auditPath: join(temp, 'unused') },
    ]) {
      await execute(plugin.effect({ options, location: { directory: '/new-project' } }));
      assert.equal(registrations.length, 0);
      assert.equal(finalizers.length, 0);
    }
    assert.equal(warnings.length, 2);
    for (const directory of ['/new-project', '/future-project', '/rules-only-project']) {
      const auditPath = join(temp, directory.slice(1) + '.jsonl');
      await execute(plugin.effect({
        options: directory === '/rules-only-project'
          ? { scope: 'all', rules: { enabled: true, file: join(temp, 'rules.json') }, auditPath }
          : { scope: 'all', timer: { enabled: true, everyMs: 60_000 }, auditPath },
        location: { directory },
        session: { hook }, permission: { hook }, tool: { hook },
        event: { subscribe: () => ({}) },
        generate: { text: () => assert.fail('global timer must not generate') },
      }));
      assert.deepEqual(registrations.map((r) => r.name), ['prompt', 'context', 'evaluate', 'execute.before']);
      if (directory === '/rules-only-project') {
        const rules = { version: 1, revision: 'entry-1', rules: [{
          id: 'entry-read', kind: 'repeat', threshold: 2,
          match: { operation: ['read'], status: ['error'] }, nudge: 'Inspect before repeating.',
        }] };
        const file = join(temp, 'rules.json');
        writeFileSync(file, JSON.stringify(rules), { mode: 0o600 });
        const contextHook = registrations.find((r) => r.name === 'context').callback;
        const context = () => ({
          sessionID: 's', model: { providerID: 'p', id: 'm' }, agent: 'writer', system: [],
          messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: 'Authorized task' }] },
            ...['1', '2'].flatMap((id) => [
              { id: `a${id}`, role: 'assistant', content: [{ type: 'tool-call', id, name: 'read', input: { path: '/target' } }] },
              { role: 'tool', content: [{ type: 'tool-result', id, result: { type: 'error', value: { code: 'ENOENT' } } }] },
            ])],
        });
        const before = context();
        await execute(contextHook(before));
        assert.match(before.system[0].text, /Inspect before repeating/);
        rules.revision = 'entry-2';
        rules.rules[0].nudge = 'Changed on next context.';
        writeFileSync(file, JSON.stringify(rules));
        const after = context();
        await execute(contextHook(after));
        assert.match(after.system[0].text, /Changed on next context/);
        assert.doesNotMatch(after.system[0].text, /Inspect before repeating/);
      }
      for (const name of ['evaluate', 'execute.before']) {
        await execute(registrations.find((r) => r.name === name).callback({
          sessionID: 's', effect: 'ask', tool: 'question',
        }));
      }
      for (const finish of finalizers.toReversed()) await execute(finish());
      assert.ok(registrations.every((r) => r.disposed));
      assert.match(readFileSync(auditPath, 'utf8'), /plugin-unloaded/);
      finalizers = [];
      registrations = [];
    }
  } finally {
    delete globalThis.__advisoryEntryTest;
    rmSync(temp, { recursive: true, force: true });
  }
});
