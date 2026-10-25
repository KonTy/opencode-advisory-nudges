// This suite uses the real bundled host, never a substitute Effect runtime.
// Installation, an exclusive quiet profile window, and an inert fixture tool
// are explicit prerequisites. It neither installs plugins nor starts servers.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';

const file = process.env.ADVISORY_NATIVE_TEST_CONFIG;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('bundled 2.1.4 native nudge mechanism', { skip: !file, timeout: 90_000 }, async (t) => {
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const timerOnly = config.condition === 'timer-only';
  const { baseURL, fixtureURL, directory, sessionID, auditPath, resultPath, profilePath } = config;
  // The fixture agent is not hardcoded in this suite; the private fixture
  // configuration names it explicitly. Omitting it keeps the historical
  // default so existing fixture configurations remain valid.
  const agent = config.agent ?? 'qwen-trial';
  assert.equal(new URL(baseURL).hostname, '127.0.0.1');
  assert.equal(new URL(fixtureURL).hostname, '127.0.0.1');
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  assert.equal(profile.providers['native-fixture'].settings.baseURL, `${fixtureURL}/v1`);
  const headers = { 'content-type': 'application/json', 'x-opencode-directory': encodeURIComponent(directory) };
  const request = async (url, init = {}) => {
    const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(15_000) });
    assert.equal(response.ok, true, `${init.method ?? 'GET'} ${url}: ${response.status}`);
    return response.json();
  };
  const api = (path, init) => request(`${baseURL}${path}`, init);
  const fixture = (path, init) => request(`${fixtureURL}${path}`, init);
  const audit = () => readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await pause(30);
    }
    assert.fail(`Timed out waiting for ${label}`);
  };
  const report = { version: null, sessionID, cases: [] };
  let safeToContinue = true;
  assert.equal((await api('/api/opencode/compatibility')).version, '2.1.4');
  report.version = '2.1.4';
  const plugins = (await api('/api/plugin')).data;
  assert.equal(plugins.find((plugin) => plugin.id === 'advisory-nudges')?.state.status, 'active');
  assert.deepEqual((await api('/api/session/active')).data, {});
  const session = (await api(`/api/session/${sessionID}`)).data;
  assert.match(session.title, /^Deterministic advisory mechanism fixture/);
  assert.equal(session.location.directory, directory);
  const ownedSessionIDs = new Set([sessionID]);
  t.after(async () => {
    const active = (await api('/api/session/active')).data;
    for (const id of ownedSessionIDs) {
      if (active[id]) await api(`/api/session/${id}/interrupt`, { method: 'POST', body: '{"resume":false}' });
    }
  });

  const run = async (name, observerReplies, { firstDelay = 150, stop = false, reads = 3 } = {}) => {
    safeToContinue = false;
    assert.deepEqual((await api('/api/session/active')).data, {});
    const offset = audit().length;
    const startedAt = Date.now();
    await fixture('/fixture/scenario', {
      method: 'POST',
      body: JSON.stringify({
        writer: [
          ...Array.from({ length: reads }, (_, i) => ({ delayMs: i === 0 ? firstDelay : 0, tool: 'advisory_fixture_read', input: {} })),
          { text: `Deterministic fixture ${name} complete.` },
        ],
        observer: observerReplies,
      }),
    });
    const dispatched = await api('/api/openchamber/control', {
      method: 'POST',
      body: JSON.stringify({
        action: 'session.send',
        input: {
          sessionId: sessionID, directory, agent,
          model: 'native-fixture/native-writer-fixture',
          prompt: `Deterministic fixture ${name}: use only the inert advisory_fixture_read tool and finish. No shell, filesystem writes, network tools or real models.`,
        },
      }),
    });
    assert.equal(dispatched.promptDispatched, true);
    await wait(async () => {
      assert.ok(!audit().slice(offset).some((record) => record.event === 'execution-ended' && record.reason === 'session.execution.failed'), 'native fixture must not fail before reaching the local responder');
      return (await fixture('/fixture/received')).some((record) => record.model === 'native-writer-fixture');
    }, 'actual local writer request');
    if (stop) {
      await wait(() => audit().slice(offset).some((record) => record.event === 'observer-started'), 'observer flight');
      await wait(async () => (await fixture('/fixture/received')).some((record) => record.model === 'native-observer-fixture'), 'actual observer HTTP request');
      // This is an explicit simulated USER stop of a fixture, never a nudge.
      assert.deepEqual(await api(`/api/session/${sessionID}/interrupt`, {
        method: 'POST', body: '{"resume":false}',
      }), { interrupted: true });
    }
    await wait(() => audit().slice(offset).find((record) => record.event === 'execution-ended'), 'native terminal event and plugin cleanup');
    await wait(async () => Object.keys((await api('/api/session/active')).data).length === 0, 'native quiet');
    const messages = (await api(`/api/session/${sessionID}/message?limit=30`)).data;
    const terminal = messages.find((message) => message.type === 'idle' && message.time.created >= startedAt);
    assert.ok(terminal, 'independent native idle history record');
    assert.equal(terminal.outcome, stop ? 'interrupted' : 'succeeded');
    await pause(100);
    const wire = await fixture('/fixture/received');
    const records = audit().slice(offset);
    const writer = wire.filter((record) => record.model === 'native-writer-fixture');
    const observers = wire.filter((record) => record.model === 'native-observer-fixture');
    if (timerOnly) assert.equal(observers.length, 0);
    else assert.ok(observers.length > 0);
    assert.ok(observers.every((record) => !record.body.tools?.length), 'observer has no writer tools');
    if (!stop) {
      assert.equal(writer.length, reads + 1);
      assert.ok(writer.every((record) => record.closedEarly === false), 'observer never aborted a healthy writer request');
      const completed = messages.filter((message) => message.type === 'assistant' && message.time.created >= startedAt)
        .flatMap((message) => message.content)
        .filter((part) => part.type === 'tool' && part.name === 'advisory_fixture_read' && part.state.status === 'completed');
      assert.equal(completed.length, reads, 'exact current-run native tools completed');
    }
    const deliveries = records.filter((record) => record.event === 'context-delivery');
    for (const delivery of deliveries) {
      assert.ok(writer.some((record) => record.body.messages.some((message) => {
        const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
        return text.includes(delivery.text);
      })), 'each audited context block reached the actual outbound writer request');
    }
    const quietCount = wire.length;
    await pause(250);
    assert.equal((await fixture('/fixture/received')).length, quietCount, 'idle never wakes itself');
    assert.deepEqual((await api('/api/session/active')).data, {});
    const summary = {
      name, writerRequests: writer.length, observerRequests: observers.length,
      observerConnectionsClosedEarly: observers.filter((record) => record.closedEarly).length,
      deliverySources: deliveries.map((record) => record.sources),
      dispositions: records.map((record) => record.event), outcome: terminal.outcome,
    };
    report.cases.push(summary);
    writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    safeToContinue = true;
    return { records, writer, observers, deliveries };
  };
  const replies = (text, delayMs = 0) => Array.from({ length: 6 }, () => ({ text, delayMs }));

  await t.test(timerOnly ? 'timer-only mode delivers with zero observer requests' : 'timer, factual repetition and advisory delivery at native boundaries', async () => {
    const result = await run(timerOnly ? 'timer-only' : 'delivery', replies('{"nudge":"Consider a concrete implementation step before another identical read."}'));
    assert.ok(result.deliveries.some((record) => record.sources.includes('timer')));
    if (timerOnly) {
      assert.ok(result.deliveries.every((record) => record.sources.length === 1 && record.sources[0] === 'timer'));
      assert.ok(result.records.every((record) => !record.event.startsWith('observer-')));
    } else {
      assert.ok(result.deliveries.some((record) => record.sources.includes('repetition')));
      assert.ok(result.deliveries.some((record) => record.sources.includes('observer')));
    }
  });
  if (timerOnly) return;
  await t.test('native no-op is not an accept/reject decision or an empty nudge', { skip: !safeToContinue }, async () => {
    const result = await run('noop', replies('{"nudge":null}'));
    assert.ok(result.records.some((record) => record.event === 'observer-noop'));
    assert.ok(result.deliveries.every((record) => !record.sources.includes('observer')));
  });
  await t.test('no current loop means no repetition warning from earlier history', { skip: !safeToContinue }, async () => {
    const result = await run('no-loop', replies('{"nudge":null}'), { reads: 2 });
    assert.ok(result.deliveries.every((record) => !record.sources.includes('repetition')));
    assert.ok(result.deliveries.every((record) => !record.text.includes('identical')));
  });
  await t.test('malformed native observer text leaves healthy writer/tools alone', { skip: !safeToContinue }, async () => {
    const result = await run('malformed', replies('not JSON'));
    assert.ok(result.records.some((record) => record.event === 'observer-error'));
    assert.ok(result.deliveries.every((record) => !record.sources.includes('observer')));
  });
  await t.test('native Effect timeout closes actual observer HTTP without aborting writer/tools', { skip: !safeToContinue }, async () => {
    const result = await run('timeout', replies('{"nudge":"Late advice"}', 3_000));
    assert.ok(result.records.some((record) => record.error === 'Observer timed out'));
    assert.ok(result.observers.some((record) => record.closedEarly), 'actual observer socket closed before delayed response');
    assert.ok(result.deliveries.every((record) => !record.sources.includes('observer')));
  });
  await t.test('native provider failure cannot turn into a verdict or stop the writer', { skip: !safeToContinue }, async () => {
    const result = await run('provider-error', []);
    assert.ok(result.records.some((record) => record.error?.startsWith('Native observer generation failed')));
    assert.ok(result.deliveries.every((record) => !record.sources.includes('observer')));
  });
  await t.test('actual native question wait cancels advisory transport without waking blocked work', { skip: !safeToContinue }, async () => {
    safeToContinue = false;
    const offset = audit().length;
    const startedAt = Date.now();
    await fixture('/fixture/scenario', {
      method: 'POST',
      body: JSON.stringify({
        writer: [{ delayMs: 100, tool: 'question', input: { questions: [{
          question: 'Deterministic fixture only: wait for a simulated user stop.',
          header: 'Fixture', options: [{ label: 'Continue', description: 'Do not answer; this is an isolated test.' }],
        }] } }],
        observer: replies('{"nudge":"Do not deliver while blocked"}', 3_000),
      }),
    });
    assert.equal((await api('/api/openchamber/control', {
      method: 'POST',
      body: JSON.stringify({ action: 'session.send', input: { sessionId: sessionID, directory, model: 'native-fixture/native-writer-fixture', agent, prompt: 'Deterministic native question-block fixture only. No other tools.' } }),
    })).promptDispatched, true);
    await wait(async () => (await fixture('/fixture/received')).some((record) => record.model === 'native-observer-fixture'), 'real observer request before question');
    await wait(() => audit().slice(offset).some((record) => record.event === 'observer-cancelled' && record.reason === 'question-blocked'), 'native question pre-execution hook');
    await wait(async () => (await api(`/api/session/${sessionID}/message?limit=10`)).data
      .filter((message) => message.type === 'assistant' && message.time.created >= startedAt)
      .flatMap((message) => message.content)
      .some((part) => part.type === 'tool' && part.name === 'question' && part.state.status === 'running'), 'actual waiting native question tool');
    const count = (await fixture('/fixture/received')).length;
    await pause(250);
    assert.equal((await fixture('/fixture/received')).length, count, 'blocked work gets no additional requests');
    assert.ok((await api('/api/session/active')).data[sessionID]);
    assert.deepEqual(await api(`/api/session/${sessionID}/interrupt`, { method: 'POST', body: '{"resume":false}' }), { interrupted: true });
    await wait(async () => !(await api('/api/session/active')).data[sessionID], 'question fixture quiet after explicit stop');
    const wire = await fixture('/fixture/received');
    assert.ok(wire.some((record) => record.model === 'native-observer-fixture' && record.closedEarly));
    assert.equal(audit().slice(offset).filter((record) => record.event === 'context-delivery').length, 0);
    report.cases.push({ name: 'question-blocked', actualQuestionWait: true, observerCancelled: true, resumed: false });
    writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    safeToContinue = true;
  });
  await t.test('explicit fixture user-stop cancels observer and never resumes the session', { skip: !safeToContinue }, async () => {
    const result = await run('user-stop', replies('{"nudge":"Do not deliver"}', 3_000), { firstDelay: 3_000, stop: true });
    assert.ok(result.records.some((record) => record.event === 'observer-cancelled'));
    assert.ok(result.observers.some((record) => record.closedEarly));
    assert.ok(result.deliveries.every((record) => !record.sources.includes('observer')));
  });
  await t.test('unselected native session gets no plugin context or observer calls', { skip: !safeToContinue }, async () => {
    const created = await api('/api/openchamber/control', {
      method: 'POST', body: JSON.stringify({ action: 'session.create', input: { directory, title: 'Deterministic advisory scope-negative fixture' } }),
    });
    assert.equal(created.promptDispatched, false);
    ownedSessionIDs.add(created.sessionId);
    await fixture('/fixture/scenario', {
      method: 'POST', body: JSON.stringify({ writer: [{ text: 'Unselected fixture complete.' }], observer: [] }),
    });
    const offset = audit().length;
    const startedAt = Date.now();
    const dispatched = await api('/api/openchamber/control', {
      method: 'POST',
      body: JSON.stringify({ action: 'session.send', input: { sessionId: created.sessionId, directory, model: 'native-fixture/native-writer-fixture', agent, prompt: 'Unselected deterministic fixture: finish without tools.' } }),
    });
    assert.equal(dispatched.promptDispatched, true);
    await wait(async () => (await api(`/api/session/${created.sessionId}/message?limit=10`)).data.some((message) => message.type === 'idle' && message.time.created >= startedAt), 'unselected native completion');
    const wire = await fixture('/fixture/received');
    assert.equal(wire.length, 1);
    assert.equal(wire[0].model, 'native-writer-fixture');
    assert.ok(!JSON.stringify(wire[0].body.messages).includes('[advisory-nudges]'));
    assert.equal(audit().slice(offset).length, 0);
    assert.deepEqual((await api('/api/session/active')).data, {});
    report.cases.push({ name: 'scope-negative', writerRequests: 1, observerRequests: 0, auditRecords: 0 });
    writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  });
});
