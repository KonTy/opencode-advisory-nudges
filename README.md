# opencode-advisory-nudges

A standalone, opt-in **OpenCode 2.1.4** plugin. It needs no OpenChamber changes
or installed dependencies. OpenCode supplies its own `effect` runtime; this
package has no build step and no runtime dependency on a foreign Effect
package.

The plugin can append advice just before an active writer's next model request:

- **Timer:** ask the writer to audit its progress against the objective and
  evidence, including failed checks. No second model.
- **Observer:** send a bounded excerpt of the current user turn to an existing
  configured model, such as a local GPT-OSS model. It returns a suggestion or
  `{"nudge":null}`. The writer never waits for its answer.
- **Optional repetition trigger:** after repeated identical tool inputs and
  textual results, suggest reconsidering the next action. This is separate
  opt-in behavior, not a step limit or a claim that every repetition is wrong.

All three are off by default. Nothing sends a user message, interrupts a writer,
resumes a session, runs writer tools, or approves/rejects implementation.
Advice does not enforce a sandbox or replace executable acceptance checks.

## Distribution status

This repository publishes the source package under the name
`opencode-advisory-nudges`. As of this writing:

- **No npm version has been published.** The registry currently returns `404`;
  publishing ownership/authentication have not been established.
- **Native npm-name resolution through the host has not been proved.** The only
  proven native installation contract is an absolute directory registration
  (below). Installing by package name from npm, or through OpenChamber Settings,
  requires host-resolution verification before claiming one-step host installation.
- **GitHub/npm distribution is not an automatic marketplace listing.** Making
  the source available on GitHub or npm does not register the plugin anywhere;
  a host must be told explicitly where to load it.

Source and npm tarballs can be installed locally and registered by absolute
directory. A downloadable GitHub tarball is not an npm registry publication or
proof that OpenChamber Settings can resolve the package name.

## Install or update the Linux desktop and plugin together

[`install.sh`](https://raw.githubusercontent.com/KonTy/opencode-advisory-nudges/main/install.sh)
fetches the **latest stable** `KonTy/openchamber` GitHub release each time.
It picks exactly one native package for `/etc/os-release` and the CPU:

| System | CPUs | Package manager |
| --- | --- | --- |
| Arch / Arch-derived | x86_64 | `pacman -U` (`.pkg.tar.zst`) |
| Debian / Ubuntu-derived | x86_64, aarch64 | `apt-get install` (`.deb`) |
| Fedora / RHEL-derived with DNF, including Nobara | x86_64, aarch64 | `dnf install` (`.rpm`) |
| openSUSE / SUSE-derived | x86_64, aarch64 | `zypper install` (`.rpm`) |

Run as your ordinary desktop user, **not root**. Required tools: Bash,
Python 3.9+, curl, `pkexec` with a working graphical Polkit agent, and that
distro's native package tools (`vercmp` on Arch, `dpkg-deb`/`dpkg-query`/`dpkg`
on Debian, `rpm` on RPM systems). Nothing installs these prerequisites for you.
RPM files are verified against GitHub SHA256 metadata and `SHA256SUMS`;
local unsigned RPMs are allowed for that verified file, not unsigned remote
repositories. Arch's existing pacman signature policy is not weakened.

**Quit OpenChamber, including its tray/background host, and OpenCode first.**
The installer refuses detected running hosts. It never kills/restarts a host,
launches a model, replaces the existing OpenChamber CLI, or changes providers,
models, session history, credentials, or unrelated plugin settings.
Package installation itself is the normal trusted distro package operation,
including the release's maintainer scripts and dependency resolution.
Only that package-manager command runs through `pkexec`; plugin files and
configuration remain user-owned. Cancellation/errors stop the installer;
there is no sudo, terminal-password or root-shell fallback.

### Select the actual local host configuration

`--config` is required: do not assume an Electron settings file is an OpenCode
profile. The reviewed **packaged v2.5.2** source uses OpenCode's
`OPENCODE_CONFIG_DIR`, otherwise `$XDG_CONFIG_HOME/opencode`, otherwise
`~/.config/opencode`, plus the optional `OPENCODE_CONFIG` layer.
The desktop imports its login-shell environment, which may differ from the
terminal. Verify your local host's environment/configuration in OpenChamber
before selecting its absolute `opencode.json`. A remote/SSH host has its own
profile and is **not** configured by this installer. If the local desktop
really uses the standard default, the commands below are appropriate; replace
the argument otherwise. This global OpenCode profile may also be read by an
existing OpenCode CLI; the installer does not relocate or replace that CLI.

Reviewed source contracts:
[config directory/layers](https://github.com/KonTy/openchamber/blob/v2.5.2/packages/web/server/lib/opencode/shared.js),
[native directory loader](https://github.com/KonTy/openchamber/blob/v2.5.2/packages/web/server/lib/opencode/managed-plugin-config.js),
[v2 plugin objects](https://github.com/KonTy/openchamber/blob/v2.5.2/packages/web/server/lib/opencode/config-v2.js),
[desktop login environment](https://github.com/KonTy/openchamber/blob/v2.5.2/packages/electron/main.mjs),
[CLI-preserving package scripts](https://github.com/KonTy/openchamber/blob/v2.5.2/packages/electron/resources/linux/after-install.tpl).
Every run also checks that the latest desktop still declares bundled OpenCode
2.1.4. A newer incompatible host fails clearly instead of choosing an older
desktop or pretending compatibility.

Prefer downloading, inspecting, then running (the `&&` prevents execution
after a failed download):

```sh
curl -fL --proto '=https' --proto-redir '=https' \
  -o install-openchamber.sh \
  https://raw.githubusercontent.com/KonTy/opencode-advisory-nudges/main/install.sh &&
less install-openchamber.sh &&
bash install-openchamber.sh --config "$HOME/.config/opencode/opencode.json" --dry-run
```

Remove `--dry-run` after reviewing the plan. Or, when you trust the live script
and have confirmed the profile, install/update in one command:

```sh
curl -fsSL --proto '=https' --proto-redir '=https' \
  https://raw.githubusercontent.com/KonTy/opencode-advisory-nudges/main/install.sh |
  bash -s -- --config "$HOME/.config/opencode/opencode.json"
```

The installer checks the downloaded desktop package against both its published
GitHub SHA256 digest and the release's verified `SHA256SUMS`, then validates
native package name/architecture/version before requesting privileges. It
skips an equal/newer installed native package rather than downgrading it.
Checksums establish consistency with the trusted GitHub release, not an
independent publisher signature. Unsupported/ambiguous assets, missing hashes,
HTTP failures and incompatible hosts are errors; it does not install a foreign
distro package as a fallback.

The plugin comes from the latest stable plugin release's single verified
`.tgz`, when available. Otherwise it resolves `main` **once** to an immutable
Git commit and fetches only the six runtime/docs/license files, checking their
Git blob hashes against that commit's tree. It prints the selected revision;
an unreleased commit is not described as an npm release. No npm registry,
Actions authentication, build, or additional Effect dependency is required.
Tar archives permit only those six bounded regular files: links, traversal,
extra members and oversized expansion are rejected. Files are staged before
promotion into a read-only, versioned directory under
`${XDG_DATA_HOME:-$HOME/.local/share}/openchamber/advisory-nudges`.

Only after preflight and successful native package installation does it merge
the absolute plugin directory into `plugins`, using a verified owner-private
backup and atomic replacement of the selected config. Existing managed plugin
options and all unrelated fields are preserved. Repeat runs do not duplicate
registrations or rewrite an unchanged config. Existing snapshots and settings
backups are retained; only owned temporary downloads/staging are cleaned.
Symlinks, foreign/writable-by-others paths, hardlinked configs, JSONC siblings,
comments/duplicate JSON keys, inline config overrides, and conflicting
unmanaged registrations are refused without rewriting them. Resolve these
explicitly rather than deleting settings. If a later configuration write fails,
the desktop may already be updated: the error must be resolved, not interpreted
as a fully successful plugin install.

**Installed does not mean activated.** New registrations have timer, observer
and repetition **all off**, with no invented scopes/audit path. Existing managed
options are preserved, never globally enabled by the installer. At a quiet
boundary, opt into timer-only using the exact session/provider/model/location
and owner-private audit configuration below; keep observer/repetition off.
Start the host yourself and verify its plugin registry/audit. This installer
does not prove native loading, one-step Settings installation or loop recovery.

Installer tests mock commands/downloads and use isolated temporary profiles;
no workstation package installation or real profile mutation is part of CI.
The release metadata/checksum inventory and public DEB control metadata were
also inspected read-only. These checks are not a real installation or a claim
that every distro, CPU or compositor was exercised.

### Install a packaged tarball without distro-specific tooling

Use an existing Node.js/npm installation. Download the `.tgz` from a successful
**Release package** workflow's `npm-package` artifact (unzip the artifact first),
or from a tagged GitHub release when one exists. Inspect and trust the source
before loading it: native plugins run with the host's privileges, and
`--ignore-scripts` does not sandbox the plugin at runtime.

```sh
npm install --prefix "$HOME/.local/share/opencode-plugins" \
  --ignore-scripts --no-audit --no-fund \
  /absolute/downloads/opencode-advisory-nudges-0.1.0.tgz
realpath "$HOME/.local/share/opencode-plugins/node_modules/opencode-advisory-nudges"
```

Register that printed absolute directory using the profile example below.
No compiler, distro package manager, root privileges, or additional Effect
dependency is needed. Package checks cover Node 22/24 on Ubuntu 22.04/24.04;
this is not a claim that every Linux distro or native host was tested.
No one-step installation through OpenChamber Settings is established.

After an actual npm publication, the equivalent npm install operand will be
`opencode-advisory-nudges@0.1.0` rather than the downloaded tarball path. It still
requires absolute-directory registration until native name resolution is
independently verified. Do not use the registry command before that version exists.

## Install in an isolated profile first

Copy this entire folder to an immutable location outside the writer's editable
project. No build or `npm install` is needed. Do not install a separate Effect
package: importing the entry with plain Node is not a native-host test.

Back up the selected OpenCode profile before editing it. In that profile's
`opencode.json`, merge an entry into **`plugins`**; preserve other registrations
and all model/agent settings. These are the 2.1.4 keys, not the older singular
plugin configuration:

```json
{
  "plugins": [
    {
      "package": "/absolute/immutable/opencode-advisory-nudges",
      "options": {
        "locations": [
          {
            "directory": "/absolute/worktree",
            "sessions": ["EXACT_NATIVE_SESSION_ID"],
            "providers": ["EXISTING_WRITER_PROVIDER"],
            "models": ["EXISTING_WRITER_MODEL"],
            "agents": ["EXISTING_WRITER_AGENT"],
            "variants": ["EXISTING_WRITER_VARIANT"]
          }
        ],
        "auditPath": "/absolute/private-directory/nudges.jsonl",
        "timer": { "enabled": true, "everyMs": 60000 }
      }
    }
  ]
}
```

The `package` value is the absolute path of the copied package directory. This
is the proven native contract; it does not resolve names through npm.

Create the private audit directory yourself; keep it outside the writer's
worktree. The plugin creates an owner-private `0600` regular file. It rejects
symlinks, hardlinks and existing group/world-accessible files without changing
their permissions. The host must support POSIX owner permissions and no-follow
opens; the native integration was exercised on Linux. Unsupported hosts disable
the plugin with an explicit error rather than weakening audit permissions.

Every location requires a normalized absolute directory, explicit nonempty
session/provider/model lists, and exact matches to OpenCode's resolved IDs.
Optional agent/variant lists further narrow selection; omitting them selects
all agents/variants of the explicitly selected writer models. An empty session
list is invalid, not a wildcard. Location matching selects behavior; it is **not
a filesystem security boundary**.

Install, change or remove registrations only while the isolated host is quiet.
Host configuration reload behavior is outside this plugin's control.
Restart the isolated OpenCode host at a quiet boundary if it does not reload
registrations; verify activation in its plugin registry/audit rather than
assuming a client refresh loaded new code.

### Upgrade and uninstall at a quiet boundary

Upgrading means replacing the package directory contents (for example, copying
a newer revision over the same immutable path) while the host is quiet, then
letting the host reload its plugin registrations. Uninstalling means removing
this registration from `plugins` while the host is quiet. Both operations are
safe-boundary operations: they cannot preempt an active model call, and pending
advice is discarded when the plugin unloads. Confirm the plugin unload record
in the audit and that unrelated profile fields are unchanged. Keep existing
session history and audit files; no reset or deletion is needed.

## Observer configuration

To enable the observer, add this to the same `options` object:

```json
{
  "observer": {
    "enabled": true,
    "providerID": "EXISTING_LOCAL_OBSERVER_PROVIDER",
    "modelID": "EXISTING_LOCAL_OBSERVER_MODEL",
    "variant": "EXISTING_BOUNDED_OBSERVER_VARIANT",
    "minGapMs": 120000,
    "inputBudgetChars": 4000,
    "outputBudgetChars": 800,
    "timeoutMs": 20000,
    "maxAgeMs": 60000
  }
}
```

The observer provider/model must differ from the selected writers. The plugin
does not create providers, read credentials, change sampling settings, or start
a model server. Enabling this mode explicitly sends a source-derived excerpt
to that configured provider; verify that its location and data policy are
appropriate before opting in. It sees the current objective, recent writer text,
and bounded tool-reported input/output excerpts, not the full conversation or
injected system advice. It cannot call writer tools.

**Character budgets are not token limits.** The native generation API accepts
only `prompt` and `model`; this plugin does not invent token/timeout API options.
In the native fixture, transient observer requests did not inherit a
`max_completion_tokens` field merely from the model's declared output limit.
Before real GPT-OSS use, independently verify its actual input/output token
budget, provider cancellation and memory guard. A transport abort does not prove
that a GPU backend stopped computing. Those checks require the runtime owner's
authorization; deterministic fixtures are not that proof.

`minGapMs` limits attempts, including no-ops/errors. At most one observer request
is pending per selected execution. A response is deliverable only at a later
native context boundary, within `maxAgeMs`, for the same user/model execution
and unchanged latest reported outcome/writer statement. Repeated identical reads
can remain fresh; changed evidence cancels or discards the old suggestion.
The last 64 normalized delivered-advice hashes suppress recent duplicates.
Older suggestions are not an unbounded historical blacklist.

The required observer protocol is exactly `{"nudge":null}` or a JSON object
containing only a nonempty `nudge` string within the configured character budget.
Blank, malformed, oversized or recursive replies are errors, not approval votes.
Provider failures are explicit in the audit and do not stop the writer.

## Repeated-read evidence

To add an immediate, deterministic suggestion independently of the timer:

```json
{
  "repetition": { "enabled": true, "threshold": 3, "window": 12 }
}
```

For timer/repetition-only operation, merge these fields into the same selected
registration's `options` object:

```json
{
  "timer": { "enabled": true, "everyMs": 60000 },
  "repetition": { "enabled": true, "threshold": 3, "window": 12 },
  "observer": { "enabled": false }
}
```

This configuration makes no observer or GPT-OSS requests. Keep the explicit
location/session/model selection and private audit path from the installation
example. The interval and repetition threshold remain configurable.

The window is 2-64 completed tool results from the **current user turn**.
Tool name, reported outcome, canonicalized full input and full textual output
must match. The advice reports the count and SHA256 input/output fingerprints,
not an invented diagnosis. Different outputs, different inputs, non-text results
of unknown equality, and loops from earlier user turns do not trigger it.
A pattern is suggested once while it remains in the retained window. Timer
audits also include factual repetitions when observed, even if this extra
trigger is off. No pattern means no repetition warning.

There is no global step/time limit or per-run nudge cap. Missed timer ticks
coalesce into one audit at the next eligible boundary. There is no idle polling
or timer that can wake a session. A single long model request or tool cannot be
nudged mid-call; delivery waits for its natural next request.

## Logs, lifecycle and disable

The private JSONL file records context-appended text, source, resolved writer
model/agent/session, timestamps, and observer dispositions. `context-delivery`
means the block was appended in the native hook; it is not a claim that a later
provider request succeeded. The native fixture separately checks actual
outbound requests. Context advice is not a forged chat message and may not
appear in the transcript.

The audit can contain source-derived advice. Protect and retain it accordingly;
do not publish it with credentials or private conversation data. Error records
do not dump provider responses or credentials. Audit failure explicitly disables
future nudges before another append; it does not fail the writer. The plugin
does not automatically erase or rotate user-owned audit files.

New prompts, terminal execution events, model/agent changes, permission denial
or approval waits, and the native question tool invalidate pending advice.
There are no permission changes. Unload disposes registrations, aborts the
native Effect consumer/generation and clears retained state.

To disable, remove this registration while quiet, or set every mode's `enabled`
to `false`. Confirm the plugin unload record/registry and that the original
profile's unrelated fields are unchanged. Keep existing session history and
audit files; no reset or deletion is needed.

| Client | Behavior |
| --- | --- |
| Web | Uses the selected OpenCode host's plugin; no client changes. |
| Electron | Same backend behavior; no native-shell changes. |
| VS Code | Only a host loading this supported plugin supplies nudges; no extension edits. |
| Hosted mobile | Same selected backend; no mobile-specific injection. |
| Capacitor mobile | Same connected backend; no mobile-shell edits. |

## Checks

```sh
npm run check
npm test
npm run check:package
npm run check:installer
```

Run these inside this folder. Core tests use a deterministic clock and
protocol shapes captured from the actual 2.1.4 host. The native suite is skipped
unless `ADVISORY_NATIVE_TEST_CONFIG` names a private fixture configuration.
It never mocks Effect, installs a plugin, starts a server, or dispatches a real
model.

The package check creates a real npm tarball, requires exactly six members
(`core.js`, `index.js`, `package.json`, both docs and `LICENSE`), installs it
offline into a clean path containing spaces with scripts disabled, verifies
every installed byte, and resolves its ESM entry without importing it.
It does **not** prove that the host loads the plugin or supplies Effect.
The explicit-agent native fixture branch has not completed validation: a fresh
fixture location failed to load registered plugins before the test could run.
Earlier timer delivery evidence does not establish loop-recovery efficacy.

For the native suite, prepare an exclusively owned isolated 2.1.4 host with this
plugin scoped to an empty fixture session, a loopback OpenAI-protocol responder
named `native-fixture`, models `native-writer-fixture` /
`native-observer-fixture`, and an inert `advisory_fixture_read` tool. Its fixed
no-argument implementation waits briefly and returns fixed text without any
filesystem/process/network access. Expose that tool with `codemode:false`.
The fixture profile must enable the three modes, use a short timer and observer
deadline, and `minGapMs:0`; these are test settings, not recommended real-model
settings. The fixture session title starts with
`Deterministic advisory mechanism fixture`.

The private test JSON names `baseURL`, `fixtureURL`, `directory`, `sessionID`,
`profilePath`, `auditPath`, and `resultPath`. The fixture agent is named by an
optional `agent` key in that same JSON; omitting it keeps the historical
default (`qwen-trial`). The responder provides
`POST /fixture/scenario` accepting `{writer:[...],observer:[...]}` deterministic
`text`/`tool`/`input`/`delayMs` responses and `GET /fixture/received` actual
request/early-close records. Both URLs must be loopback. Then:

```sh
ADVISORY_NATIVE_TEST_CONFIG=/absolute/private/fixture.json npm test
```

For the independent timer-only native check, disable observer/repetition in the
isolated profile and set `"condition":"timer-only"` in a separate fixture JSON.
It requires timer delivery with zero second-model requests.

The native suite includes an explicit **simulated user stop** of its fixture
session. It must never be pointed at an actual coding session or normal app
profile. It checks real context delivery, healthy writer/tool completion,
observer no-op/error/timeout cancellation, no-loop and scope-negative controls,
and quiet-after-stop behavior. Restore and verify the profile after the suite.
These checks establish mechanisms, not improved coding quality or speed.

## CI and releases

`CI` runs syntax checks, the 25 deterministic core tests (the private native
suite is explicitly skipped), and the offline package/consumer check for
Node 22 and 24 on Ubuntu 22.04 and 24.04. It runs on pushes to `main` and
`work-npm-packaging`, pull requests, or manual dispatch. There is no dependency
installation, lockfile or build step.
It also checks Bash syntax and runs the isolated Python installer tests;
the installer and its tests remain excluded from the six-file npm tarball.

`Release package` can be run manually from Actions on `main` with
`publish_npm=false` to produce a downloadable `npm-package` artifact, retained
for 30 days. For a versioned GitHub release, update `package.json`, merge the
verified change into `main`, then create and push a matching `vVERSION` tag.
The workflow rejects tag/version mismatches, reruns the checks, and attaches
the verified `.tgz` to a GitHub release. Tests, scripts and workflows are not
shipped in the tarball. Tag pushes **never publish to npm**. An existing
GitHub release is not overwritten; rerunning its creation job will fail.

### Optional npm publication (not configured by installing this plugin)

Registry publication requires an npm account authorized for the package.
The name currently returns npm `404`; that is not a reservation or proof of
ownership. No npm publication has been performed.

1. An authorized maintainer must establish the npm package/ownership and
   configure its GitHub Actions trusted publisher on npmjs.com (an initial
   authenticated publication may be required). Use owner `KonTy`, repository
   `opencode-advisory-nudges`, workflow filename `release.yml`, and environment
   `npm`. Follow npm's current trusted-publisher requirements; this workflow
   uses hosted runners, Node 24 and npm's OIDC support, not a stored token.
2. Protect the GitHub `npm` environment with a required maintainer reviewer
   and a deployment tag rule `v*`. Without that protection, the workflow's
   manual flag alone is not a reviewer approval gate. This repository's
   environment is configured to require `KonTy` approval, allow only `v*`
   tags, and disallow administrator bypass; preserve those settings.
3. Manually dispatch `Release package` **on the matching version tag** with
   `publish_npm=true`, review the artifact and approve the `npm` deployment.
   Branch dispatches cannot publish. Only this job receives `id-token: write`;
   it publishes the verified tarball with provenance and lifecycle scripts off.

Do not dispatch the publishing option until npm ownership and the trusted
publisher are configured. No credentials belong in repository files, logs,
issues or chat. GitHub release artifacts remain usable without npm auth.
