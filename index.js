import { Effect, Stream } from 'effect';
import { createAdvisoryState, openPrivateAudit, parseOptions } from './core.js';

export default {
  id: 'advisory-nudges',
  effect: (ctx) => Effect.gen(function* () {
    const { config, errors } = parseOptions(ctx.options);
    if (!config) {
      yield* Effect.logWarning(`[advisory-nudges] disabled: ${errors.join('; ')}`);
      return;
    }
    if ((!config.timer.enabled && !config.observer.enabled && !config.repetition.enabled && !config.rules.enabled)
      || (config.scope !== 'all' && !config.locations.some((location) => location.directory === ctx.location.directory))) return;

    let audit;
    try { audit = openPrivateAudit(config.auditPath); }
    catch {
      yield* Effect.logError('[advisory-nudges] disabled: cannot open an owner-private regular audit file');
      return;
    }
    yield* Effect.addFinalizer(() => Effect.sync(() => audit.close()));
    const services = yield* Effect.context();
    const model = {
      providerID: config.observer.providerID, id: config.observer.modelID,
      ...(config.observer.variant === null ? {} : { variant: config.observer.variant }),
    };
    const generate = (prompt, signal) => Effect.runPromiseWith(services)(
      ctx.generate.text({ model, prompt }), { signal },
    ).then((result) => {
      if (typeof result.text !== 'string') throw new Error('Native observer returned no text');
      return result.text;
    });
    const api = createAdvisoryState(config, generate, ctx.location.directory, { emit: audit.write });
    yield* Effect.addFinalizer(() => Effect.sync(api.teardown));
    const guarded = (name, callback) => (event) => Effect.sync(() => {
      try { callback(event); }
      catch { api.fail(`${name} hook failed`); }
    });
    for (const [name, callback] of [['prompt', api.onPrompt], ['context', api.onContext]]) {
      const registration = yield* ctx.session.hook(name, guarded(name, callback));
      yield* Effect.addFinalizer(() => registration.dispose);
    }
    const permission = yield* ctx.permission.hook('evaluate', guarded('permission', (event) => {
      if (event.effect === 'ask' || event.effect === 'deny') api.block(event.sessionID, 'permission-blocked');
    }));
    yield* Effect.addFinalizer(() => permission.dispose);
    const tool = yield* ctx.tool.hook('execute.before', guarded('tool', (event) => {
      if (event.tool === 'question') api.block(event.sessionID, 'question-blocked');
    }));
    yield* Effect.addFinalizer(() => tool.dispose);

    // Use the same host Effect runtime as generation; the finalizer owns this
    // consumer's cancellation and waits for it before the audit file closes.
    const controller = new AbortController();
    const consume = Effect.runPromiseWith(services)(
      Stream.runForEach(ctx.event.subscribe(), guarded('lifecycle', api.handleEvent)),
      { signal: controller.signal },
    );
    const settled = consume.then(
      () => { if (!controller.signal.aborted) api.fail('lifecycle stream ended'); },
      () => { if (!controller.signal.aborted) api.fail('lifecycle stream failed'); },
    );
    yield* Effect.addFinalizer(() => Effect.promise(async () => {
      controller.abort();
      await settled;
    }));
  }),
};
