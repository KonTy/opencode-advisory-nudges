import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAdvisoryState, hasNudges, openPrivateAudit, parseObserverReply, parseOptions } from './core.js';

const directory = '/fixture';
const user = (id = 'u1', text = 'Implement the task and run the required checks.') => ({
  id, role: 'user', content: [{ type: 'text', text }], metadata: {},
});
// Shapes captured from real bundled 2.1.4 context callbacks, including both
// actual server execution (providerExecuted:false) and failed native tools.
const tool = (id, { input = { filePath: '/fixture/source.py' }, output = 'unchanged source', error = false, name = 'read' } = {}) => [
  { id: `a${id}`, role: 'assistant', content: [{ type: 'tool-call', id: `t${id}`, name, input, providerExecuted: false }] },
  { role: 'tool', content: [{
    type: 'tool-result', id: `t${id}`, name,
    result: error ? { type: 'error', value: { error: { type: 'tool.execution', message: output }, content: [] } } : { type: 'text', value: output },
    providerExecuted: false,
  }] },
];
const context = (messages = [user()], extra = {}) => ({
  sessionID: 'ses_A', model: { providerID: 'writer', id: 'qwen', variant: 'nonthinking' },
  agent: 'qwen-trial', system: [], messages, options: {}, tools: {}, ...extra,
});
const scope = { directory, sessions: ['ses_A'], providers: ['writer'], models: ['qwen'], agents: ['qwen-trial'], variants: ['nonthinking'] };
const options = (overrides = {}) => ({
  locations: [scope], auditPath: '/fixture/private.jsonl',
  timer: { enabled: true, everyMs: 1_000 }, ...overrides,
});
const observer = (extra = {}) => ({
  enabled: true, providerID: 'reviewer', modelID: 'gptoss', minGapMs: 0,
  timeoutMs: 100, maxAgeMs: 1_000, ...extra,
});
const flush = () => new Promise(setImmediate);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function setup(overrides = {}, generate = () => Promise.resolve('{"nudge":null}'), location = directory) {
  const raw = options(overrides);
  if (raw.locations === undefined) delete raw.locations;
  const parsed = parseOptions(raw);
  assert.deepEqual(parsed.errors, []);
  let time = 10_000;
  let sequence = 0;
  const scheduled = new Map();
  const records = [], errors = [], calls = [];
  const api = createAdvisoryState(parsed.config, (prompt, signal) => {
    calls.push({ prompt, signal });
    return generate(prompt, signal);
  }, location, {
    now: () => time,
    emit: (record) => records.push(record),
    reportError: (message) => errors.push(message),
    schedule: (callback, delay) => { scheduled.set(++sequence, { at: time + delay, callback }); return sequence; },
    unschedule: (id) => scheduled.delete(id),
  });
  const advance = (delta) => {
    time += delta;
    for (const [id, task] of [...scheduled]) {
      if (task.at <= time) { scheduled.delete(id); task.callback(); }
    }
  };
  const event = (type, extra = {}) => api.handleEvent({
    id: `evt-${++sequence}`, created: time, type,
    data: { sessionID: 'ses_A' }, location: { directory: location }, ...extra,
  });
  return { api, records, errors, calls, advance, event, scheduled };
}

const globalOptions = { scope: 'all', locations: undefined };

test('all scope is explicit, default-off, requires audit, rejects selectors and observer', () => {
  assert.equal(parseOptions().config.scope, 'selected');
  assert.equal(parseOptions({ scope: 'all' }).config.timer.enabled, false);
  for (const input of [
    { scope: null }, { scope: '*' }, { scope: true },
    { scope: 'all', locations: [] }, { scope: 'all', locations: [scope] },
    { scope: 'all', timer: { enabled: true } },
    { scope: 'all', auditPath: 'relative', timer: { enabled: true } },
    { scope: 'all', auditPath: '/private/audit', observer: observer() },
  ]) assert.equal(parseOptions(input).config, null, JSON.stringify(input));
});

test('global timer covers new sessions, directories and provider/models independently without observer calls', () => {
  for (const location of ['/project-one', '/project-two']) {
    const h = setup(globalOptions, () => assert.fail('global mode must never generate'), location);
    for (const id of ['new-session', 'future-session']) {
      const event = () => context([user(id)], {
        sessionID: id, model: { providerID: id, id: location }, agent: id,
      });
      assert.deepEqual(h.api.onContext(event()), []);
      h.advance(1_000);
      const next = event();
      assert.deepEqual(h.api.onContext(next).map((n) => n.source), ['timer']);
      assert.deepEqual(h.api.onContext(next), []);
    }
    assert.equal(h.api.state.runs.size, 2);
    assert.equal(h.calls.length, 0);
    assert.equal(h.scheduled.size, 0);
    h.api.teardown();
    assert.equal(h.api.state.runs.size, 0);
    assert.equal(h.api.state.prompts.size, 0);
    h.advance(100_000);
    assert.deepEqual(h.api.onContext(context()), []);
  }
});

test('global timer resets on provider/model/agent and user changes, suppresses queued stale contexts', () => {
  const h = setup(globalOptions);
  h.api.onContext(context());
  h.advance(1_000);
  const changed = { providerID: 'new-provider', id: 'new-model' };
  assert.deepEqual(h.api.onContext(context([user()], { model: changed, agent: 'new-agent' })), []);
  h.advance(1_000);
  assert.equal(h.api.onContext(context([user()], { model: changed, agent: 'new-agent' })).length, 1);
  h.api.onPrompt({ sessionID: 'ses_A', messageID: 'next' });
  h.advance(60_000);
  assert.deepEqual(h.api.onContext(context()), []);
  assert.deepEqual(h.api.onContext(context([user('next')])), []);
  h.advance(1_000);
  assert.equal(h.api.onContext(context([user('next')])).length, 1);
  h.api.teardown();
});

test('global execution events respect directory ownership and start each future session timer', () => {
  const h = setup(globalOptions);
  h.event('session.execution.started', { data: { sessionID: 'future' }, location: { directory: '/another' } });
  assert.equal(h.api.state.runs.size, 0);
  h.event('session.execution.started', { data: { sessionID: 'future' } });
  h.advance(1_000);
  assert.equal(h.api.onContext(context([user()], { sessionID: 'future' })).length, 1);
  h.api.teardown();
  const off = setup({ ...globalOptions, timer: { enabled: false } });
  off.advance(60_000);
  assert.deepEqual(off.api.onContext(context([])), []);
  assert.equal(off.api.state.runs.size, 0);
  off.api.teardown();
});

test('global repetition deduplication stays per session and resets for a new objective', () => {
  const h = setup({ ...globalOptions, timer: { enabled: false }, repetition: { enabled: true } });
  const messages = [user(), ...tool(1), ...tool(2), ...tool(3)];
  for (const sessionID of ['one', 'two']) {
    assert.deepEqual(h.api.onContext(context(messages, { sessionID })).map((n) => n.source), ['repetition']);
    assert.deepEqual(h.api.onContext(context(messages, { sessionID })), []);
    assert.deepEqual(h.api.onContext(context([user('new'), ...tool(1), ...tool(2), ...tool(3)], { sessionID }))
      .map((n) => n.source), ['repetition']);
  }
  assert.equal(h.calls.length, 0);
  h.api.teardown();
});

test('global idle, blocked, terminal and deleted executions cannot schedule or wake work', () => {
  for (const terminal of ['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted', 'session.deleted', 'permission.asked']) {
    const h = setup(globalOptions);
    h.advance(60_000);
    assert.equal(h.api.state.runs.size, 0);
    h.api.onContext(context());
    h.event(terminal, { created: 9_000 });
    assert.equal(h.api.state.runs.size, 1, 'stale lifecycle event must not clear new execution');
    h.event(terminal);
    assert.equal(h.api.state.runs.size, 0);
    const delivered = h.records.filter((r) => r.event === 'context-delivery').length;
    h.advance(60_000);
    assert.equal(h.api.state.runs.size, 0);
    assert.equal(h.records.filter((r) => r.event === 'context-delivery').length, delivered);
    assert.equal(h.scheduled.size, 0);
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.api.onContext(context([user('resumed-by-host')])), []);
    h.api.teardown();
  }
  for (const reason of ['question-blocked', 'permission-blocked']) {
    const h = setup(globalOptions);
    h.api.onContext(context());
    h.api.block('ses_A', reason);
    h.advance(60_000);
    assert.equal(h.api.state.runs.size, 0);
    assert.equal(h.scheduled.size, 0);
    h.api.teardown();
  }
});

test('default options are off; explicit scope and private audit are mandatory', () => {
  const parsed = parseOptions();
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.config.timer.enabled, false);
  assert.equal(parsed.config.observer.enabled, false);
  assert.equal(parsed.config.repetition.enabled, false);
  for (const invalid of [
    null, [], { typo: true }, { timer: null }, { timer: { enabled: 'true' } },
    { timer: { enabled: true } }, options({ auditPath: 'relative' }),
    options({ locations: [{ directory }] }), options({ locations: [{ ...scope, sessions: [] }] }),
    options({ locations: [{ ...scope, models: [] }] }), options({ locations: [{ ...scope, providers: [] }] }),
    options({ locations: [{ ...scope, directory: '/fixture/../other' }] }),
    options({ timer: { enabled: true, everyMs: NaN } }),
    options({ timer: { enabled: true, maxPerRun: 4 } }),
    options({ observer: observer({ providerID: 3 }) }),
    options({ observer: observer({ providerID: 'writer', modelID: 'qwen' }) }),
    options({ observer: observer({ timeoutMs: 2 ** 32 }) }),
    options({ repetition: { enabled: true, threshold: 1 } }),
    options({ repetition: { enabled: true, window: 65 } }),
  ]) assert.equal(parseOptions(invalid).config, null, JSON.stringify(invalid));
});

test('timer uses elapsed active execution time, coalesces ticks, and has no run cap', () => {
  const h = setup();
  h.event('session.execution.started');
  assert.deepEqual(h.api.onContext(context()), []);
  for (let n = 0; n < 10; n++) {
    h.advance(n === 0 ? 10_000 : 1_000);
    const next = context([user(), ...tool(n)]);
    const delivered = h.api.onContext(next);
    assert.deepEqual(delivered.map((item) => item.source), ['timer']);
    assert.equal(next.system.length, 1);
    assert.deepEqual(h.api.onContext(next), []);
    assert.deepEqual(h.api.onContext(context([user(), ...tool(n)])), []);
  }
  assert.equal(h.records.filter((record) => record.event === 'context-delivery').length, 10);
  h.api.teardown();
});

test('all selected dimensions must match; default-off performs no context work', () => {
  for (const extra of [
    { sessionID: 'ses_other' }, { agent: 'other' },
    { model: { providerID: 'other', id: 'qwen', variant: 'nonthinking' } },
    { model: { providerID: 'writer', id: 'other', variant: 'nonthinking' } },
    { model: { providerID: 'writer', id: 'qwen', variant: 'thinking' } },
  ]) {
    const h = setup({ observer: observer() });
    assert.deepEqual(h.api.onContext(context([], extra)), []);
    assert.equal(h.api.state.runs.size, 0);
    h.api.teardown();
  }
  const h = setup({ timer: { enabled: false } });
  assert.deepEqual(h.api.onContext(context([])), []);
  assert.equal(h.api.state.runs.size, 0);
});

test('injected system parts use the real 2.1.4 text discriminant, not persisted-message system', () => {
  const h = setup();
  h.api.onContext(context());
  h.advance(1_000);
  const next = context([user()], { system: [{ type: 'text', text: 'Native base instructions.' }] });
  h.api.onContext(next);
  assert.equal(next.system.length, 2);
  assert.equal(next.system[1].type, 'text');
  assert.equal(hasNudges(next.system), true);
  assert.deepEqual(h.api.onContext(next), []);
  h.api.teardown();
});

test('new user identity resets elapsed timing; queued prompts suppress old-context nudges', async () => {
  const flight = deferred();
  const h = setup({ observer: observer() }, () => flight.promise);
  h.api.onContext(context());
  await flush();
  h.advance(500);
  h.api.onPrompt({ sessionID: 'ses_A', messageID: 'u2' });
  assert.equal(h.calls[0].signal.aborted, true);
  h.advance(5_000);
  assert.deepEqual(h.api.onContext(context()), []);
  const next = context([user('u2', 'A new task')]);
  assert.deepEqual(h.api.onContext(next), []);
  flight.resolve('{"nudge":"Old advice"}');
  await flush();
  assert.equal(next.system.length, 0);
  h.advance(1_000);
  assert.ok(h.api.onContext(context([user('u2', 'A new task')])).some((item) => item.source === 'timer'));
  h.api.teardown();
});

for (const terminal of ['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted', 'session.deleted']) {
  test(`${terminal} cancels pending observer and clears execution state without waking anything`, async () => {
    const flight = deferred();
    const h = setup({ observer: observer({ timeoutMs: 20_000 }) }, () => flight.promise);
    const first = context();
    h.api.onContext(first);
    await flush();
    h.event(terminal);
    assert.equal(h.calls[0].signal.aborted, true);
    assert.equal(h.scheduled.size, 0);
    assert.equal(h.api.state.runs.size, 0);
    h.advance(100_000);
    flight.resolve('{"nudge":"Too late"}');
    await flush();
    assert.equal(first.system.length, 0);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.api.onContext(context([user('u2')])), []);
    h.api.teardown();
  });
}

test('permission/question blocks invalidate advice; stale lifecycle events cannot end a newer run', async () => {
  for (const reason of ['permission-blocked', 'question-blocked']) {
    const flight = deferred();
    const h = setup({ observer: observer() }, () => flight.promise);
    h.api.onContext(context());
    await flush();
    h.api.block('ses_A', reason);
    assert.equal(h.calls[0].signal.aborted, true);
    assert.equal(h.api.state.runs.size, 0);
    h.api.teardown();
  }
  const h = setup();
  h.api.onContext(context());
  h.event('session.execution.succeeded', { created: 9_000 });
  h.advance(1_000);
  assert.equal(h.api.onContext(context()).length, 1);
  h.api.teardown();
});

test('repeated reads produce factual input/output evidence once per retained pattern, not a stop', () => {
  const h = setup({ timer: { enabled: false }, repetition: { enabled: true, threshold: 3, window: 12 } });
  assert.deepEqual(h.api.onContext(context([user(), ...tool(1), ...tool(2)])), []);
  const messages = [user(), ...tool(1), ...tool(2), ...tool(3)];
  const third = context(messages);
  assert.deepEqual(h.api.onContext(third).map((item) => item.source), ['repetition']);
  assert.match(third.system[0].text, /Observed 3 identical read input\/text-result pairs/);
  assert.match(third.system[0].text, /Input SHA256 [a-f0-9]{64}; output SHA256 [a-f0-9]{64}/);
  assert.match(third.system[0].text, /not proof of a defect/);
  assert.deepEqual(h.api.onContext(context([...messages, ...tool(4)])), []);
  assert.equal(h.api.state.runs.size, 1);
  h.api.teardown();
});

test('no repetition warning for distinct inputs, changed output, or unknown non-text output', () => {
  for (const messages of [
    [user(), ...tool(1), ...tool(2, { input: { filePath: '/different' } }), ...tool(3)],
    [user(), ...tool(1), ...tool(2, { output: 'changed' }), ...tool(3)],
    [user(), ...tool(1, { output: 'x'.repeat(5_000) + 'A' }), ...tool(2, { output: 'x'.repeat(5_000) + 'B' }), ...tool(3, { output: 'x'.repeat(5_000) + 'C' })],
  ]) {
    const h = setup({ timer: { enabled: false }, repetition: { enabled: true } });
    assert.deepEqual(h.api.onContext(context(messages)), []);
    h.api.teardown();
  }
  const h = setup({ timer: { enabled: false }, repetition: { enabled: true } });
  const messages = [user(), ...tool(1), ...tool(2), ...tool(3)];
  for (const message of messages.filter((item) => item.role === 'tool')) message.content[0].result = { type: 'file', value: 'not examined' };
  assert.deepEqual(h.api.onContext(context(messages)), []);
  h.api.teardown();
});

test('an old loop cannot invent a warning for a new user turn with no repetition', () => {
  const h = setup({ timer: { enabled: false }, repetition: { enabled: true } });
  const history = [user(), ...tool(1), ...tool(2), ...tool(3), user('u2', 'A new objective'), ...tool(4)];
  assert.deepEqual(h.api.onContext(context(history)), []);
  assert.equal(h.api.state.runs.get('ses_A').sample.facts.length, 1);
  h.api.teardown();
});

test('timer includes observed repetitions even when the optional repetition trigger is off', () => {
  const h = setup();
  h.api.onContext(context());
  h.advance(1_000);
  const next = context([user(), ...tool(1), ...tool(2), ...tool(3)]);
  assert.deepEqual(h.api.onContext(next).map((item) => item.source), ['timer']);
  assert.match(next.system[0].text, /Observed 3 identical/);
  h.api.teardown();
});

test('observer never blocks a context boundary, receives bounded real tool evidence, and delivers once', async () => {
  const flight = deferred();
  const h = setup({ timer: { enabled: false }, observer: observer({ inputBudgetChars: 700 }) }, () => flight.promise);
  const messages = [user(), ...tool(1, { error: true, output: 'Required check FAILED' })];
  const first = context(messages);
  assert.deepEqual(h.api.onContext(first), []);
  assert.equal(h.calls.length, 0);
  await flush();
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].prompt, /Required check FAILED/);
  const digest = h.calls[0].prompt.split('Bounded excerpt:\n')[1];
  assert.ok(digest.length <= 700);
  assert.ok(!h.calls[0].prompt.includes('[advisory-nudges]'));
  flight.resolve('{"nudge":"Consider implementing a fix before another identical read."}');
  await flush();
  const next = context([...messages, ...tool(2, { error: true, output: 'Required check FAILED' })]);
  assert.deepEqual(h.api.onContext(next).map((item) => item.source), ['observer']);
  const audit = h.records.find((record) => record.event === 'context-delivery');
  assert.equal(audit.text, next.system[0].text);
  assert.deepEqual(audit.model, next.model);
  assert.deepEqual(h.api.onContext(next), []);
  h.api.teardown();
});

test('observer budget preserves the newest check failure ahead of older tool outcomes', async () => {
  const h = setup({ timer: { enabled: false }, observer: observer() });
  const messages = [
    user('u1', 'Current objective. '.repeat(120)),
    ...Array.from({ length: 12 }, (_, i) => tool(i, { output: 'Older successful read. '.repeat(50) })).flat(),
    { id: 'progress', role: 'assistant', content: [{ type: 'text', text: 'Current writer statement. '.repeat(60) }] },
    ...tool(13, { name: 'approved_check', error: true, output: `LATEST_REQUIRED_CHECK_FAILED\n${'failure details '.repeat(60)}` }),
  ];
  h.api.onContext(context(messages));
  await flush();
  const digest = h.calls[0].prompt.split('Bounded excerpt:\n')[1];
  assert.ok(digest.length <= 4_000);
  assert.match(digest, /LATEST_REQUIRED_CHECK_FAILED/);
  assert.ok(digest.indexOf('approved_check') < digest.indexOf('Older successful read'));
  h.api.teardown();
});

test('observer no-op, malformed, oversized, recursive and rejected outputs are explicit, not votes', async () => {
  for (const [reply, disposition] of [
    ['{"nudge":null}', 'observer-noop'],
    ['not JSON', 'observer-error'], ['{}', 'observer-error'],
    [JSON.stringify({ nudge: 'x'.repeat(801) }), 'observer-error'],
    ['{"nudge":"[advisory-nudges] recursion"}', 'observer-error'],
    [null, 'observer-error'],
  ]) {
    const h = setup({ timer: { enabled: false }, observer: observer() }, () => reply === null ? Promise.reject(new Error('provider failed')) : Promise.resolve(reply));
    h.api.onContext(context());
    await flush();
    assert.equal(h.records.filter((record) => record.event === disposition).length, 1);
    assert.deepEqual(h.api.onContext(context()), []);
    assert.equal(h.calls.length, 1);
    h.api.teardown();
  }
  assert.ok(parseObserverReply('{"nudge":null,"verdict":"reject"}', 100).error);
});

test('observer attempts are rate-limited; equivalent advice is deduplicated without a run cap', async () => {
  const h = setup({ timer: { enabled: false }, observer: observer({ minGapMs: 1_000, timeoutMs: 2_000 }) }, () => Promise.resolve('{"nudge":"Try a concrete edit."}'));
  h.api.onContext(context([user(), ...tool(1)]));
  await flush();
  assert.equal(h.api.onContext(context([user(), ...tool(1), ...tool(2)])).length, 1);
  assert.equal(h.calls.length, 1);
  h.advance(1_000);
  h.api.onContext(context([user(), ...tool(2), ...tool(3)]));
  await flush();
  assert.ok(h.records.some((record) => record.event === 'observer-duplicate'));
  assert.deepEqual(h.api.onContext(context([user(), ...tool(3), ...tool(4)])), []);
  h.api.teardown();
});

test('timeout aborts the actual supplied transport signal once, with no writer operation', async () => {
  const h = setup({ timer: { enabled: false }, observer: observer() }, () => new Promise(() => {}));
  h.api.onContext(context());
  await flush();
  h.advance(100);
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.scheduled.size, 0);
  assert.equal(h.records.filter((record) => record.event === 'observer-error').length, 1);
  assert.deepEqual(h.api.onContext(context()), []);
  assert.equal(h.calls.length, 1);
  h.api.teardown();
});

test('changed evidence and expired advice cannot be delivered at a later boundary', async () => {
  const flight = deferred();
  const h = setup({ timer: { enabled: false }, observer: observer({ minGapMs: 5_000, timeoutMs: 10_000 }) }, () => flight.promise);
  h.api.onContext(context([user(), ...tool(1)]));
  await flush();
  h.api.onContext(context([user(), ...tool(2, { output: 'Now fixed; tests passed' })]));
  assert.equal(h.calls[0].signal.aborted, true);
  flight.resolve('{"nudge":"Old suggestion"}');
  await flush();
  assert.deepEqual(h.api.onContext(context([user(), ...tool(2, { output: 'Now fixed; tests passed' })])), []);
  h.api.teardown();
  const aged = setup({ timer: { enabled: false }, observer: observer({ minGapMs: 5_000 }) }, () => Promise.resolve('{"nudge":"Old suggestion"}'));
  aged.api.onContext(context());
  await flush();
  aged.advance(1_001);
  assert.deepEqual(aged.api.onContext(context()), []);
  assert.ok(aged.records.some((record) => record.reason === 'stale-at-boundary'));
  aged.api.teardown();
});

test('per-session retained facts and deduplication state stay bounded', () => {
  const h = setup({ timer: { enabled: false }, repetition: { enabled: true } });
  const messages = [user()];
  for (let i = 0; i < 150; i++) {
    messages.push(...tool(i, { input: { path: `/fixture/${i}` } }));
    h.api.onContext(context(messages));
  }
  const run = h.api.state.runs.get('ses_A');
  assert.ok(run.cache.size <= 12);
  assert.ok(run.warned.size <= 12);
  assert.ok(run.sample.facts.length <= 12);
  assert.equal(h.api.state.runs.size, 1);
  h.api.teardown();
});

test('private audit keeps mode0600, rejects unsafe files, and never follows links', (t) => {
  const path = mkdtempSync(join(tmpdir(), 'advisory-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const file = join(path, 'audit.jsonl');
  const audit = openPrivateAudit(file);
  audit.write({ event: 'test' });
  audit.close();
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).event, 'test');
  symlinkSync(file, join(path, 'symlink'));
  assert.throws(() => openPrivateAudit(join(path, 'symlink')));
  linkSync(file, join(path, 'hardlink'));
  assert.throws(() => openPrivateAudit(file));
  const publicFile = join(path, 'public.jsonl');
  writeFileSync(publicFile, '');
  chmodSync(publicFile, 0o644);
  assert.throws(() => openPrivateAudit(publicFile), /owner-private/);
  assert.equal(statSync(publicFile).mode & 0o777, 0o644);
});

test('audit failure disables future nudges explicitly before changing model context', () => {
  let time = 0;
  const errors = [];
  const parsed = parseOptions(options());
  const api = createAdvisoryState(parsed.config, undefined, directory, {
    now: () => time,
    emit: (record) => { if (record.event === 'context-delivery') throw new Error('disk failure'); },
    reportError: (message) => errors.push(message),
  });
  api.onContext(context());
  time = 2_000;
  const next = context();
  assert.deepEqual(api.onContext(next), []);
  assert.equal(next.system.length, 0);
  assert.match(errors[0], /private audit write failed/);
  time = 4_000;
  assert.deepEqual(api.onContext(context()), []);
  api.teardown();
});

test('teardown cancels an already-started observer and releases all retained state', async () => {
  const flight = deferred();
  const h = setup({ observer: observer() }, () => flight.promise);
  h.api.onContext(context());
  await flush();
  h.api.teardown();
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.scheduled.size, 0);
  assert.equal(h.api.state.runs.size, 0);
  assert.equal(h.api.state.prompts.size, 0);
  assert.equal(h.records.at(-1).event, 'plugin-unloaded');
  const count = h.records.length;
  flight.resolve('{"nudge":"Late"}');
  await flush();
  h.advance(10_000);
  assert.deepEqual(h.api.onContext(context()), []);
  assert.equal(h.records.length, count);
  assert.equal(h.calls.length, 1);
});

test('cancel before observer microtask starts never invokes the generator; instances are independent', async () => {
  const first = setup({ observer: observer() });
  const second = setup();
  first.api.onContext(context());
  first.api.teardown();
  await flush();
  assert.equal(first.calls.length, 0);
  assert.equal(second.api.state.runs.size, 0);
  assert.equal(hasNudges(context().system), false);
  second.api.teardown();
});
