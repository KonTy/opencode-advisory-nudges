import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAdvisoryState, parseOptions } from './core.js';
import { compilePattern, matchPattern, readRulesSnapshot, RULE_LIMITS, validateRules } from './rules.js';

const catalog = JSON.parse(readFileSync(new URL('./rules.example.json', import.meta.url)));
const document = (nudge = 'Inspect the path and task.', rules = [{
  id: 'missing', kind: 'repeat', match: { operation: ['read'], status: ['error'], code: ['ENOENT'] },
  threshold: 2, nudge,
}]) => ({ version: 1, revision: nudge, rules });
const user = (id = 'u') => ({ id, role: 'user', content: [{ type: 'text', text: 'Implement only the authorized task.' }] });
const outcome = (id, { tool = 'read', path = '/planned/new.txt', output = 'ENOENT missing file', status = 'error', code = 'ENOENT' } = {}) => [
  { id: `call-${id}`, role: 'assistant', content: [{ type: 'tool-call', id, name: tool, input: { filePath: path } }] },
  { role: 'tool', content: [{ type: 'tool-result', id, name: tool, result: status === 'error'
    ? { type: 'error', value: { error: { code, message: output } } } : { type: status, value: output } }] },
];
const statement = (id, text) => ({ id, role: 'assistant', content: [{ type: 'text', text }] });
const messages = (...results) => [user(), ...results.flat()];

function fixture(t, doc = document(), overrides = {}, directory = '/writer-project') {
  const root = mkdtempSync(join(tmpdir(), 'advisory-rules-'));
  const file = join(root, 'rules.json');
  const save = (data) => {
    writeFileSync(`${file}.next`, JSON.stringify(data), { mode: 0o600 });
    renameSync(`${file}.next`, file);
  };
  save(doc);
  let time = 0;
  const records = [], calls = [], scheduled = new Map();
  const parsed = parseOptions({
    scope: 'all', auditPath: join(root, 'audit.jsonl'), rules: { enabled: true, file }, ...overrides,
  });
  assert.deepEqual(parsed.errors, []);
  const api = createAdvisoryState(parsed.config, (prompt, signal) => {
    calls.push({ prompt, signal });
    return new Promise((resolve) => { calls.at(-1).resolve = resolve; });
  }, directory, {
    now: () => time, emit: (r) => records.push(r),
    schedule: (fn) => { const id = Symbol(); scheduled.set(id, fn); return id; },
    unschedule: (id) => scheduled.delete(id),
  });
  const context = (items = messages(outcome('1'), outcome('2')), sessionID = 'session') => ({
    sessionID, model: { providerID: 'writer', id: 'coding' }, agent: 'writer',
    system: [], messages: items, tools: { read: {}, edit: {} },
  });
  const next = (items, sessionID) => api.onContext(context(items, sessionID));
  t.after(() => { api.teardown(); rmSync(root, { recursive: true, force: true }); });
  return { root, file, save, api, context, next, records, calls, scheduled, advance: (ms) => { time += ms; } };
}

test('rules are opt-in with scoped/global validation and private file/audit requirements', () => {
  assert.equal(parseOptions().config.rules.enabled, false);
  for (const raw of [
    { rules: { enabled: true } },
    { scope: 'all', rules: { enabled: true, file: '/rules.json' } },
    { scope: 'all', auditPath: '/audit', rules: { enabled: true, file: 'relative' } },
    { scope: 'all', auditPath: '/audit', rules: { enabled: true, file: '/tmp/../rules' } },
    { scope: 'all', auditPath: '/private/../rules', rules: { enabled: true, file: '/rules' } },
    { rules: { enabled: 'yes' } }, { rules: { enabled: false, autoWrite: true } },
  ]) assert.equal(parseOptions(raw).config, null);
});

test('valid edits apply on the very next boundary without time/turn change; removal and disable are immediate', (t) => {
  const h = fixture(t);
  assert.match(h.next()[0].text, /Inspect the path/);
  assert.deepEqual(h.next(), []);
  h.save(document('New direction: verify spelling.'));
  assert.match(h.next()[0].text, /New direction/);
  h.save(document('none', []));
  assert.deepEqual(h.next(), []);
  h.save(document('off', [{ ...document().rules[0], enabled: false }]));
  assert.deepEqual(h.next(), []);
  assert.equal(h.calls.length, 0);
  assert.equal(h.scheduled.size, 0);
  assert.equal(h.records.filter((r) => r.event === 'rules-accepted').length, 4);
});

test('revision detection uses content, not timestamps or the human revision label', (t) => {
  const h = fixture(t);
  h.next();
  const before = statSync(h.file);
  const changed = { ...document('Changed text, same label'), revision: document().revision };
  h.save(changed);
  utimesSync(h.file, before.atime, before.mtime);
  assert.match(h.next()[0].text, /Changed text/);
  const accepted = h.records.filter((r) => r.event === 'rules-accepted');
  assert.equal(accepted[0].label, accepted[1].label);
  assert.notEqual(accepted[0].revision, accepted[1].revision);
});

test('global rules cover distinct directories, future sessions and writer identities; selected isolation stays exact', (t) => {
  for (const directory of ['/writer-project', '/future-project']) {
    const h = fixture(t, document(), {}, directory);
    for (const sessionID of ['current', 'future']) {
      const event = h.context(undefined, sessionID);
      event.model = { providerID: `provider-${sessionID}`, id: `model-${sessionID}` };
      assert.equal(h.api.onContext(event).length, 1);
    }
    assert.equal(h.calls.length, 0);
  }
  const selected = fixture(t, document(), {
    scope: 'selected', locations: [{ directory: '/writer-project', sessions: ['session'], providers: ['writer'], models: ['coding'] }],
  });
  assert.equal(selected.next().length, 1);
  assert.deepEqual(selected.next(undefined, 'not-selected'), []);
  const event = selected.context();
  event.model.id = 'not-selected';
  assert.deepEqual(selected.api.onContext(event), []);
});

test('rejected updates audit active and rejected revisions, retain last-good rules, and recover', (t) => {
  const h = fixture(t);
  h.next(messages(outcome('1')));
  for (const bytes of ['{', Buffer.from([0xff]), JSON.stringify({ ...document(), version: 2 }), ' '.repeat(RULE_LIMITS.bytes + 1)]) {
    writeFileSync(h.file, bytes);
    assert.equal(h.next()[0]?.ruleID, 'missing');
    assert.ok(h.records.some((r) => r.event === 'rules-rejected' && r.activeRevision));
    // A new epoch permits one last-good warning, never repeated every callback.
    h.api.handleEvent({ type: 'session.execution.succeeded', created: 0, data: { sessionID: 'session' } });
  }
  rmSync(h.file);
  h.next(messages(outcome('1')));
  assert.ok(h.records.some((r) => r.event === 'rules-rejected' && r.rejectedRevision === 'ENOENT'));
  h.save(document('Recovered revision'));
  assert.match(h.next()[0].text, /Recovered/);
});

test('schema rejects duplicate IDs, unsupported fields/regex, excess history/guidance and bad thresholds', () => {
  for (const data of [
    { ...document(), rules: [...document().rules, ...document().rules] },
    { ...document(), command: 'never executed' },
    { ...document(), window: 33 },
    { ...document(), observerGuidance: ['a'.repeat(161)] },
    { ...document(), rules: Array.from({ length: 25 }, (_, i) => ({ ...document().rules[0], id: `r-${i}` })) },
    document('x', [{ ...document().rules[0], threshold: 1 }]),
    document('x', [{ ...document().rules[0], match: { tool: ['read'], outputPattern: '(a+)+$' } }]),
    document('x', [{ ...document().rules[0], nudge: 'a'.repeat(601) }]),
    document('x', [{ ...document().rules[0], claimPattern: 'done' }]),
  ]) assert.throws(() => validateRules(data));
});

test('missing initial rules are explicitly rejected, while disabled mode never reads the file', (t) => {
  const h = fixture(t);
  rmSync(h.file);
  assert.deepEqual(h.next(), []);
  assert.ok(h.records.some((r) => r.event === 'rules-rejected' && r.activeRevision === null));
  const off = fixture(t, document(), {
    timer: { enabled: true, everyMs: 60_000 }, rules: { enabled: false, file: '/not-readable' },
  });
  off.next();
  off.advance(60_000);
  assert.equal(off.next()[0].source, 'timer');
  assert.ok(!off.records.some((r) => r.event.startsWith('rules-')));
  assert.equal(off.calls.length, 0);
});

test('safe pattern dialect matches literals/classes/anchors/quantifiers and rejects backtracking syntax', () => {
  for (const [pattern, input, expected] of [
    ['^ENOENT$', 'ENOENT', true], ['^ENOENT$', 'xENOENT', false],
    ['stale.hash', 'stale-hash error', true], ['[a-c]+[0-9]?', 'abc2', true],
    ['[^a]+$', 'bbb', true], ['^ab?c$', 'ac', true], ['^ab*c$', 'abbbc', true],
    ['^ab+c$', 'ac', false], ['a\\.b', 'a.b', true],
  ]) assert.equal(matchPattern(compilePattern(pattern), input), expected, pattern);
  for (const pattern of ['(a+)+$', '(?=a)', 'a|b', 'a{2}', '\\1', '\\d+', 'a**', '[z-a]', '[abc', '^$']) {
    assert.throws(() => compilePattern(pattern), pattern);
  }
  const budget = { remaining: 1_000 };
  const start = performance.now();
  assert.throws(() => matchPattern(compilePattern('a*'.repeat(50) + 'b$'), 'a'.repeat(800), budget), /instruction budget/);
  assert.ok(budget.remaining < 0, 'actual finite instruction budget, not same-thread timeout');
  assert.ok(performance.now() - start < 1_000);
});

test('private file checks reject symlink/hardlink/modes/inside writer directory and accept atomic snapshots', (t) => {
  const h = fixture(t);
  assert.equal(readRulesSnapshot(h.file, '/writer-project').config.version, 1);
  assert.throws(() => readRulesSnapshot(h.file, h.root), /outside/);
  chmodSync(h.file, 0o644);
  assert.throws(() => readRulesSnapshot(h.file, '/writer-project'), /owner-private/);
  chmodSync(h.file, 0o600);
  linkSync(h.file, join(h.root, 'hardlink'));
  assert.throws(() => readRulesSnapshot(h.file, '/writer-project'), /owner-private/);
  rmSync(join(h.root, 'hardlink'));
  symlinkSync(h.file, join(h.root, 'symlink'));
  assert.throws(() => readRulesSnapshot(join(h.root, 'symlink'), '/writer-project'));
  const folder = join(h.root, 'private');
  mkdirSync(folder, { mode: 0o700 });
  symlinkSync(folder, join(h.root, 'dir-link'));
  assert.throws(() => readRulesSnapshot(join(h.root, 'dir-link/rules'), '/writer-project'), /parent/);
  symlinkSync(h.root, join(h.root, 'writer-alias'));
  assert.throws(() => readRulesSnapshot(h.file, join(h.root, 'writer-alias')), /outside/);
});

test('starter missing-file, stale-hash, denied-tool, unchanged-read and evidence-backed claim cases', (t) => {
  const cases = [
    [messages(outcome('1'), outcome('2'), outcome('3')), 'same-missing-read'],
    [messages(outcome('1', { tool: 'edit', output: 'stale hash', code: 'STALE_HASH' }),
      outcome('2', { tool: 'edit', output: 'stale hash', code: 'STALE_HASH' })), 'stale-edit'],
    [messages(outcome('1', { code: 'EPERM', output: 'denied' }), outcome('2', { code: 'EPERM', output: 'denied' })), 'denied-tool'],
    [messages(...Array.from({ length: 4 }, (_, i) => outcome(String(i), { status: 'text', output: 'same content' }))), 'unchanged-read'],
    [messages(outcome('1', { tool: 'bash', output: 'required check failed' }),
      [statement('claim', 'All checks passed')]), 'failure-completion-claim'],
  ];
  for (const [items, expected] of cases) {
    const h = fixture(t, catalog);
    assert.ok(h.next(items).some((n) => n.ruleID === expected), expected);
    assert.deepEqual(h.next(items), []);
    assert.equal(h.calls.length, 0);
  }
});

test('changing outcomes/paths/progress/writes, ordinary polling and unproved claims do not trigger recovery', (t) => {
  for (const items of [
    messages(outcome('1'), outcome('2', { path: '/different' }), outcome('3')),
    messages(outcome('1'), outcome('2', { output: 'ENOENT newer evidence' }), outcome('3')),
    messages(outcome('1'), [statement('progress', 'Implemented the other file')], outcome('2'), outcome('3')),
    messages(outcome('1'), outcome('write', { tool: 'write', status: 'text', output: 'written' }), outcome('2'), outcome('3')),
    messages(outcome('1', { status: 'text', output: 'poll 1' }), outcome('2', { status: 'text', output: 'poll 2' })),
    messages(outcome('1', { tool: 'bash', status: 'text', output: 'success' }), [statement('claim', 'All checks passed')]),
    messages([statement('claim', 'All checks passed')], outcome('1', { tool: 'bash' })),
    messages(outcome('1', { tool: 'bash' }), [statement('claim', 'Still investigating the check')]),
    messages(outcome('1', { tool: 'bash', output: 'required check failed' }),
      [statement('claim', 'Do not report "All checks passed"')]),
    messages(outcome('1'), outcome('2'), outcome('3'), [statement('new', 'Made progress; retry later')]),
  ]) {
    const h = fixture(t, catalog);
    assert.deepEqual(h.next(items), []);
  }
  const h = fixture(t);
  const initial = messages(outcome('1'), outcome('2'));
  assert.equal(h.next(initial).length, 1);
  const evolving = messages(outcome('1'), outcome('2', { output: 'ENOENT changed result for same call ID' }));
  h.save(document('changed outputs must not reuse stale cached equality'));
  assert.deepEqual(h.next(evolving), []);
});

test('exact structured matches never treat truncated path/code prefixes as complete values', (t) => {
  for (const [match, options] of [
    [{ path: 'x'.repeat(512) }, { path: 'x'.repeat(513) }],
    [{ code: ['x'.repeat(80)] }, { code: 'x'.repeat(81) }],
  ]) {
    const h = fixture(t, document('exact fields', [{
      id: 'exact', kind: 'repeat', threshold: 2, nudge: 'Exact evidence only.',
      match: { operation: ['read'], ...match },
    }]));
    assert.deepEqual(h.next(messages(outcome('1', options), outcome('2', options))), []);
  }
});

test('per-case cooldown and per-session/turn/reset/disposal stay bounded with no wake or generated calls', (t) => {
  const h = fixture(t);
  assert.equal(h.next().length, 1);
  assert.equal(h.next(undefined, 'other-session').length, 1);
  h.advance(120_000);
  assert.deepEqual(h.next(), [], 'same evidence is warned once even after cooldown');
  h.api.onPrompt({ sessionID: 'session', messageID: 'new-user' });
  assert.deepEqual(h.next(), [], 'queued new prompt suppresses stale turn');
  assert.equal(h.next([user('new-user'), ...outcome('3'), ...outcome('4')]).length, 1);
  for (const type of ['permission.asked', 'session.execution.interrupted', 'session.deleted']) {
    h.api.handleEvent({ type, created: 120_000, data: { sessionID: 'session' } });
    assert.equal(h.api.state.runs.has('session'), false);
  }
  h.api.block('other-session', 'question-blocked');
  h.advance(1_000_000);
  assert.equal(h.api.state.runs.size, 0);
  assert.equal(h.scheduled.size, 0);
  assert.equal(h.calls.length, 0);
  h.api.teardown();
  assert.deepEqual(h.next(), []);
});

test('new evidence respects cooldown and matching budget errors are audited without disabling the writer', (t) => {
  const h = fixture(t);
  h.next();
  const next = messages(outcome('3', { path: '/different' }), outcome('4', { path: '/different' }));
  assert.deepEqual(h.next(next), []);
  h.advance(60_000);
  assert.equal(h.next(next).length, 1);
  const expensive = Array.from({ length: 24 }, (_, i) => ({
    id: `expensive-${i}`, kind: 'repeat', threshold: 2, nudge: 'No action.',
    match: { operation: ['read'], outputPattern: 'a*'.repeat(50) + 'b$' },
  }));
  h.save(document('expensive bounded patterns', expensive));
  const outcomeItems = messages(outcome('a', { output: 'a'.repeat(800) }), outcome('b', { output: 'a'.repeat(800) }));
  assert.deepEqual(h.next(outcomeItems), []);
  assert.ok(h.records.some((r) => r.event === 'rules-evaluation-error' && /budget/.test(r.error)));
  h.save(document('healthy again'));
  assert.equal(h.next().length, 1);
});

test('observer checklist edits cancel old revisions, keep base constraints and min-gap, deterministic advice takes priority', async (t) => {
  const h = fixture(t, { ...document('empty', []), observerGuidance: ['Check actual path before retry.'] }, {
    scope: 'selected', locations: [{ directory: '/writer-project', sessions: ['session'], providers: ['writer'], models: ['coding'] }],
    observer: { enabled: true, providerID: 'review', modelID: 'observer', minGapMs: 0 },
  });
  h.next(messages(outcome('1')));
  await new Promise(setImmediate);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].prompt, /Check actual path/);
  assert.match(h.calls[0].prompt, /Never bypass permissions/);
  assert.match(h.calls[0].prompt, /Allowed tool names.*read/);
  h.save({ ...document('new', []), observerGuidance: ['Never assume planned files exist.'] });
  h.next(messages(outcome('1')));
  assert.equal(h.calls[0].signal.aborted, true);
  h.calls[0].resolve('{"nudge":"Old revision advice"}');
  await new Promise(setImmediate);
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].prompt, /Never assume planned files/);
  h.save(document('Deterministic wins'));
  const next = h.next();
  assert.equal(next[0].ruleID, 'missing');
  assert.equal(h.calls[1].signal.aborted, true);
  h.calls[1].resolve('{"nudge":"Stale observer"}');
  await new Promise(setImmediate);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.next(), []);
  await new Promise(setImmediate);
  h.api.teardown();
  for (const call of h.calls) assert.equal(call.signal.aborted, true);
  assert.equal(h.scheduled.size, 0);
});

test('invalid/checklist changes cannot resurrect stale observer advice or bypass its min-gap', async (t) => {
  const h = fixture(t, document('empty', []), {
    scope: 'selected', locations: [{ directory: '/writer-project', sessions: ['session'], providers: ['writer'], models: ['coding'] }],
    observer: { enabled: true, providerID: 'review', modelID: 'observer', minGapMs: 60_000 },
  });
  h.next(messages(outcome('1')));
  await new Promise(setImmediate);
  assert.equal(h.calls.length, 1);
  writeFileSync(h.file, '{');
  h.next(messages(outcome('1')));
  assert.equal(h.calls[0].signal.aborted, true);
  h.calls[0].resolve('{"nudge":"Rejected revision advice"}');
  await new Promise(setImmediate);
  h.save(document('new guide', []));
  assert.deepEqual(h.next(messages(outcome('1'))), []);
  await new Promise(setImmediate);
  assert.equal(h.calls.length, 1);
  h.advance(60_000);
  h.next(messages(outcome('2')));
  await new Promise(setImmediate);
  assert.equal(h.calls.length, 2);
  h.api.block('session', 'permission-blocked');
  assert.equal(h.calls[1].signal.aborted, true);
  assert.equal(h.scheduled.size, 0);
  h.advance(1_000_000);
  assert.equal(h.calls.length, 2);
});

test('maintainer helper validates duplicate IDs, preserves backups and atomically replaces data only', (t) => {
  const h = fixture(t);
  const candidate = join(h.root, 'candidate.json');
  const run = () => spawnSync(process.execPath, ['scripts/update-rules.mjs', candidate, h.file], {
    cwd: new URL('.', import.meta.url), encoding: 'utf8',
  });
  writeFileSync(candidate, JSON.stringify(document('new update')), { mode: 0o600 });
  const before = readFileSync(h.file);
  assert.equal(run().status, 0);
  assert.match(readFileSync(h.file, 'utf8'), /new update/);
  const backup = spawnSync(process.execPath, ['--input-type=module', '-e',
    'import{readdirSync}from"node:fs";console.log(readdirSync(process.argv[1]).find(n=>n.includes(".backup-")))', h.root], { encoding: 'utf8' }).stdout.trim();
  assert.deepEqual(readFileSync(join(h.root, backup)), before);
  assert.equal(run().status, 0);
  const valid = readFileSync(h.file);
  writeFileSync(candidate, JSON.stringify({ ...document(), rules: [...document().rules, ...document().rules] }));
  assert.notEqual(run().status, 0);
  assert.deepEqual(readFileSync(h.file), valid);
  writeFileSync(h.file, '{invalid');
  writeFileSync(candidate, JSON.stringify(document('repaired update')));
  assert.equal(run().status, 0);
  assert.match(readFileSync(h.file, 'utf8'), /repaired update/);
});
