# Advisory nudges

## Ownership

This folder owns a portable native OpenCode 2.1.4 plugin: explicit selection,
elapsed audits, bounded repetition evidence, asynchronous advisory generation,
safe-boundary context mutation, and private audit records. The host owns model
transport, permission decisions, session execution and plugin scope. OpenChamber
UI, tool confinement, model-server startup and efficacy evaluation are outside
this module.

## Distribution and installation

- The source package is named `opencode-advisory-nudges` and its public source
  repository is `https://github.com/KonTy/opencode-advisory-nudges`. No npm
  version has been published; the registry currently returns `404` and
  publishing ownership/authentication have not been established.
- The only proven native installation contract is an absolute directory
  registration in the profile's `plugins` array
  (`{package:'/absolute/package-directory',options:{...}}`). Native
  npm-name resolution and installation through OpenChamber Settings have not
  yet been proved and require host-resolution verification before claiming
  one-step host installation.
- The dependency-free package check verifies the exact eight published members,
  an offline clean-consumer install, byte identity and ESM entry resolution.
  It does not import the host entry or prove native loading. The release
  workflow produces that verified tarball as an Actions artifact, attaches
  it to matching version-tag releases, and separates optional manual,
  environment-gated OIDC npm publishing. Registry ownership/trusted-publisher
  setup remains a maintainer prerequisite; see the README.
- GitHub/npm distribution is not an automatic marketplace listing. Publishing
  the source does not register the plugin with any host; each host must be told
  explicitly where to load it.
- Upgrades (replacing the package directory contents) and uninstalls (removing
  the registration) are safe-boundary operations performed while the host is
  quiet. They cannot preempt an active model call; pending advice is discarded
  on unload. Host configuration reload behavior is outside this plugin's
  control.

## Invariants

- No mode runs without explicit location/session/provider/model selection OR
  the explicit `scope:"all"` opt-in, and a private audit sink. Defaults never
  register hooks or start an observer. Omitted scope means `selected`.
- `all` rejects the presence of `locations` (including an empty list), rejects
  enabled observers, and covers current/future sessions, providers/models and
  agents within each host directory loading the user's config. There is no
  wildcard or empty-selector fallback, no cross-user/remote-host deployment,
  and no new scheduler/model invocation. Timer/repetition state remains per
  session/directory and is invalidated by the existing epoch/lifecycle rules.
- Only a selected native context callback can append advice. There are no
  prompt, resume, interrupt, writer-tool or approval calls.
- The writer never awaits an observer. Generation and lifecycle consumption use
  the host's Effect context, with owned abort signals and scoped finalizers.
- Native AI messages have `role`, typed `content`, user IDs, tool-call inputs and
  separate tool-result messages. Native system parts use `type:"text"`.
  Persisted SessionMessage shapes are not a compatibility fallback.
- Current-user identity and authoritative execution events define epochs. New
  prompts and blocked/terminal work invalidate advice; unselected sessions do
  not gain state. Global sessions have independent state. A context hook is proof of an active boundary, never a reason
  to wake an idle session.
- Only current-user-turn, bounded recent facts feed audits and observer samples.
  Text-result equality hashes complete input/output, not truncated excerpts.
  Unknown non-text output never supplies repetition evidence.
- Timer cadence is elapsed/coalesced, not message-count based. Repetition needs
  actual equal input/output pairs; neither mode imposes a work limit.
  Elapsed time stays in delivery audit metadata (`timer.elapsedMs` and
  `timer.sinceLastReminderMs`), not the model-facing timer wording. Identical
  evidence therefore yields identical timer text despite clock changes.
  Real repetition evidence is not frozen; no server cache-hit claim follows.
- Observer responses are suggestions or explicit no-ops. Scope, epoch, freshness,
  age, duplicate and recursive-output checks precede delivery.
- One execution retains at most the configured fact window, that window's
  repetition signatures, one pending observer/advice and 64 advice hashes.
  Nothing retains the complete message array or an in-memory audit history.
- Audit files remain owner-private regular files, without following links.
  Audit failure is explicit and disables further context changes, not the writer.
- Rules are opt-in data from a private file outside the monitored workspace.
  Each active context boundary reads a stable no-follow snapshot (32 KiB max),
  validates version/unique IDs/limits, and switches by content SHA256 rather
  than timestamps or a host option reload. Rejected snapshots visibly retain
  last-good deterministic cases and pause observers. Accepting changed data
  cancels prior observer flights/advice and resets per-case deduplication.
- The data pattern language deliberately excludes JavaScript regex groups,
  alternation, assertions and backreferences. A non-backtracking state-machine
  matcher enforces a shared instruction budget. There is no executable config,
  imported module, eval, template expression, automatic enrollment from tool
  text or unbounded pending regex job. The runtime gains `rules.js` and the
  reviewed starter catalog, not an Effect dependency or worker process.
- Native integration must verify outbound request text, lifecycle completion and
  real observer HTTP disconnection. Pure state tests cannot prove these.
- Character limits and HTTP cancellation do not establish a model's token budget
  or GPU cancellation. Real-model validation is a separate gate.

## Decisions

### Why hot-reload data rather than mutate host options or synthesize prompts

The next natural context boundary can see maintainer edits in an active user
turn. Rules use the existing evidence, selection, private audit and lifecycle
machinery; there is no timer wait, session wake or command executor. Fixed
outcome hashes plus consecutive-match/progress guards make retries precise,
not an attempt to infer file-creation authority or semantic coding success.
Structured codes/paths are used when actually exposed. Text fallback and
completion claims require explicit bounded patterns and remain reported
evidence, not independent verification. See README for complete version-1
schema, safe-pattern dialect, exclusions and atomic maintainer helper.

Observer hints are bounded literal data subordinate to fixed advisory, allowed
tool and no-bypass constraints. Deterministic delivery suppresses the observer
at that boundary; invalid/changed data cancels stale flights. Existing global
observer prohibition, rate limits and cancellation remain. Tests are synthetic
core/entry fixtures, not native-host proof or a Qwen recovery efficacy result.

### Why global selection is explicit and excludes the observer

The user can opt into timer-only coverage without maintaining future session
IDs. A distinct `scope:"all"` option preserves existing scoped installations;
conflicting selectors fail rather than becoming ignored filters. An all-model
observer could select its own generated context, so global plus enabled
observer is rejected rather than introducing recursion or a hidden exception.
The installer leaves new registrations off and preserves configured options.
See the README's global timer-only example and quiet-boundary editing procedure.
Core and entry-wiring unit coverage is not new native-host proof.

### Why native context boundaries and not synthetic user prompts

Appending at the next native request leaves a healthy generation/tool alone
and cannot create, resume or resurrect work. Synthetic prompts would introduce
queue ownership and interruption risks without improving this use case.

### Why host-native Effect and not a Promise adapter

The native Effect runtime's abort signal closes the actual observer transport.
The tested Promise adapter did not propagate cancellation; discarding a result
alone would leave model work running.

### Why an owned stream consumer and not an awaited infinite subscription

The lifecycle stream must remain active after setup completes. Running it
through the captured host context, with a finalizer that aborts and joins it,
uses a verified host API without blocking registration or leaving a consumer
alive after unload.

### Why current-turn evidence and not all historical reads

Historical loops are not proof that a newly requested task is looping. A resumed
writer accumulates new evidence naturally; old repeated reads cannot manufacture
a warning for a fresh turn.

### Why fingerprints and bounded excerpts

Complete textual input/output hashes make repetition claims testable without
placing full commands or tool output in reminder logs. The observer needs some
actual content, so only bounded excerpts enter its explicitly selected provider.
Non-text results remain unknown rather than being declared equal.
The digest lists tools newest first and trims its end when over budget.
Keeping the digest's tail would favor older outcomes and could hide a new
required-check failure.

### Why advisory errors do not fail the writer

An optional observer is not an acceptance authority. Its timeout, no-op,
malformed response, provider error or audit failure is visible but cannot turn
a healthy coding execution into a failure.
