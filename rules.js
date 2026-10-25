import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const RULE_LIMITS = Object.freeze({ bytes: 32_768, count: 24, window: 32, pattern: 128, input: 800, steps: 250_000 });
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const object = (value, keys, label) => {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label}: expected object`);
  assert(Object.keys(value).every((key) => keys.includes(key)), `${label}: unknown field`);
};
const text = (value, max, label) => assert(typeof value === 'string' && value.trim().length > 0
  && value.length <= max && !value.includes('[advisory-nudges]'), `${label}: invalid text`);
const integer = (value, min, max, label) => assert(Number.isSafeInteger(value) && value >= min && value <= max, `${label}: invalid integer`);
export const rulesHash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// No RegExp constructed from data. Thompson-style state simulation has a shared
// instruction budget; pattern size alone is NOT a backtracking timeout.
export function compilePattern(pattern) {
  text(pattern, RULE_LIMITS.pattern, 'pattern');
  let i = 0;
  const anchored = pattern[0] === '^';
  if (anchored) i++;
  const tokens = [];
  let end = false;
  while (i < pattern.length) {
    if (pattern[i] === '$' && i === pattern.length - 1) { end = true; i++; break; }
    const c = pattern[i++];
    let token;
    if (c === '\\') {
      assert(i < pattern.length && '^$.*+?[]\\-(){}|'.includes(pattern[i]), 'pattern: only escaped punctuation supported');
      token = { chars: pattern[i++], negate: false };
    } else if (c === '.') token = { any: true };
    else if (c === '[') {
      let chars = '';
      const negate = pattern[i] === '^';
      if (negate) i++;
      while (i < pattern.length && pattern[i] !== ']') {
        let first = pattern[i++];
        assert(first !== '\\' && first !== '[', 'pattern: no class escapes/nesting');
        if (pattern[i] === '-' && pattern[i + 1] !== ']' && i + 1 < pattern.length) {
          i++;
          const last = pattern[i++];
          assert(first.charCodeAt(0) <= last.charCodeAt(0) && last.charCodeAt(0) - first.charCodeAt(0) <= 64, 'pattern: invalid class range');
          for (let n = first.charCodeAt(0); n <= last.charCodeAt(0); n++) chars += String.fromCharCode(n);
        } else chars += first;
        assert(chars.length <= 128, 'pattern: class too large');
      }
      assert(chars.length && pattern[i++] === ']', 'pattern: unclosed/empty class');
      token = { chars, negate };
    } else {
      assert(!'^$*+?(){}|]'.includes(c), 'pattern: unsupported syntax (no groups, alternation, braces or assertions)');
      token = { chars: c, negate: false };
    }
    token.quantifier = '*+?'.includes(pattern[i] ?? '\0') ? pattern[i++] : '';
    tokens.push(token);
  }
  assert(tokens.length > 0, 'pattern: at least one consuming token required');
  return { tokens, anchored, end };
}

export function matchPattern(compiled, value, budget = { remaining: RULE_LIMITS.steps }) {
  const input = String(value).slice(0, RULE_LIMITS.input);
  const { tokens, anchored, end } = compiled;
  const tick = () => { assert(--budget.remaining >= 0, 'pattern: evaluation instruction budget exceeded'); };
  const closure = (states) => {
    for (let i = 0; i < tokens.length; i++) {
      tick();
      if (states.has(i) && ['*', '?'].includes(tokens[i].quantifier)) states.add(i + 1);
    }
    return states;
  };
  let states = closure(new Set([0]));
  for (let pos = 0; pos <= input.length; pos++) {
    if (!anchored) { states.add(0); closure(states); }
    if (states.has(tokens.length) && (!end || pos === input.length)) return true;
    if (pos === input.length) break;
    const next = new Set();
    for (const state of states) {
      tick();
      const token = tokens[state];
      if (!token) continue;
      const matches = token.any || (token.chars.includes(input[pos]) !== token.negate);
      if (!matches) continue;
      if (token.quantifier === '*' || token.quantifier === '+') next.add(state);
      next.add(state + 1);
    }
    states = closure(next);
  }
  return false;
}

export function validateRules(data) {
  object(data, ['version', 'revision', 'window', 'rules', 'observerGuidance'], 'rules file');
  assert(data.version === 1, 'rules file: version must be 1');
  text(data.revision, 80, 'revision');
  const window = data.window ?? 12;
  integer(window, 2, RULE_LIMITS.window, 'window');
  assert(Array.isArray(data.rules) && data.rules.length <= RULE_LIMITS.count, 'rules: expected at most 24 entries');
  const ids = new Set();
  const rules = data.rules.map((raw) => {
    object(raw, ['id', 'enabled', 'kind', 'match', 'threshold', 'cooldownMs', 'nudge', 'claimPattern'], 'rule');
    assert(typeof raw.id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(raw.id) && !ids.has(raw.id), 'rule: invalid/duplicate id');
    ids.add(raw.id);
    assert(raw.enabled === undefined || typeof raw.enabled === 'boolean', 'rule: enabled must be boolean');
    assert(['repeat', 'failed-claim'].includes(raw.kind), 'rule: kind must be repeat or failed-claim');
    object(raw.match, ['tool', 'operation', 'path', 'status', 'code', 'inputHash', 'outputHash', 'outputPattern'], 'match');
    for (const key of ['tool', 'operation', 'status', 'code']) {
      if (raw.match[key] === undefined) continue;
      assert(Array.isArray(raw.match[key]) && raw.match[key].length > 0 && raw.match[key].length <= 8, `match.${key}: expected 1-8 values`);
      raw.match[key].forEach((value) => text(value, 80, `match.${key}`));
    }
    assert(raw.match.tool?.length || raw.match.operation?.length, 'match: explicit tool or operation required');
    if (raw.match.path !== undefined) text(raw.match.path, 512, 'match.path');
    for (const key of ['inputHash', 'outputHash']) {
      if (raw.match[key] !== undefined) assert(typeof raw.match[key] === 'string'
        && /^[a-f0-9]{64}$/.test(raw.match[key]), `match.${key}: expected lowercase SHA256`);
    }
    text(raw.nudge, 600, 'nudge');
    const threshold = raw.threshold ?? (raw.kind === 'repeat' ? 3 : 1);
    integer(threshold, raw.kind === 'repeat' ? 2 : 1, raw.kind === 'repeat' ? window : 1, 'threshold');
    const cooldownMs = raw.cooldownMs ?? 60_000;
    integer(cooldownMs, 1_000, 3_600_000, 'cooldownMs');
    assert(raw.kind === 'failed-claim' || raw.claimPattern === undefined, 'claimPattern requires failed-claim');
    if (raw.kind === 'failed-claim') {
      assert(raw.match.status?.length === 1 && raw.match.status[0] === 'error', 'failed-claim requires status:["error"]');
      assert(raw.claimPattern !== undefined, 'failed-claim requires explicit claimPattern');
    }
    return {
      ...raw, threshold, cooldownMs, enabled: raw.enabled !== false,
      outputPattern: raw.match.outputPattern === undefined ? null : compilePattern(raw.match.outputPattern),
      claim: raw.claimPattern === undefined ? null : compilePattern(raw.claimPattern),
    };
  });
  const observerGuidance = data.observerGuidance ?? [];
  assert(Array.isArray(observerGuidance) && observerGuidance.length <= 8, 'observerGuidance: expected at most 8 hints');
  observerGuidance.forEach((value) => text(value, 160, 'observerGuidance'));
  assert(observerGuidance.join('\n').length <= 800, 'observerGuidance: total limit 800 characters');
  return { version: 1, revision: data.revision, window, rules, observerGuidance };
}

export function readRulesSnapshot(file, directory) {
  assert(constants.O_NOFOLLOW, 'rules: no-follow opens unavailable');
  assert(isAbsolute(file) && resolve(file) === file, 'rules: expected normalized absolute path');
  let monitored = resolve(directory);
  try { monitored = realpathSync(directory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const rel = relative(monitored, file);
  assert(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel), 'rules: file must be outside the monitored directory');
  for (let path = dirname(file); ; path = dirname(path)) {
    const stat = lstatSync(path);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && [0, process.getuid()].includes(stat.uid)
      && ((stat.mode & 0o022) === 0 || (stat.uid === 0 && (stat.mode & 0o1000) !== 0)), 'rules: unsafe parent directory');
    if (path === dirname(path)) break;
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const before = fstatSync(fd, { bigint: true });
    assert(before.isFile() && before.nlink === 1n && before.uid === BigInt(process.getuid())
      && (before.mode & 0o077n) === 0n && before.size > 0n && before.size <= BigInt(RULE_LIMITS.bytes), 'rules: unsafe/empty/oversized owner-private file');
    bytes = Buffer.alloc(Number(before.size) + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(file, { bigint: true });
    assert(count === Number(before.size) && ['ino', 'dev', 'size', 'mtimeNs', 'ctimeNs'].every((key) =>
      before[key] === after[key] && before[key] === named[key]), 'rules: file changed during read; use atomic replacement');
    bytes = bytes.subarray(0, count);
  } finally { closeSync(fd); }
  const revision = rulesHash(bytes);
  try {
    const source = bytes.toString('utf8');
    assert(Buffer.from(source, 'utf8').equals(bytes), 'rules: invalid UTF-8 data');
    return { revision, bytes, config: validateRules(JSON.parse(source)) };
  } catch (error) {
    error.revision = revision;
    error.snapshotBytes = bytes;
    throw error;
  }
}

export function evaluateRules(config, sample, warned, time) {
  const budget = { remaining: RULE_LIMITS.steps };
  const latest = sample.facts.at(-1);
  if (!latest) return [];
  const matches = (rule, fact) => {
    for (const key of ['tool', 'operation', 'status', 'code']) {
      if (rule.match[key] && !rule.match[key].includes(fact[key])) return false;
    }
    for (const key of ['path', 'inputHash', 'outputHash']) {
      if (rule.match[key] !== undefined && rule.match[key] !== fact[key]) return false;
    }
    return !rule.outputPattern || matchPattern(rule.outputPattern, fact.output, budget);
  };
  const nudges = [];
  for (const rule of config.rules) {
    if (!rule.enabled || !matches(rule, latest) || !latest.signature) continue;
    let count = 1;
    if (rule.kind === 'repeat') {
      if (sample.progressAfterLatest) continue;
      for (const fact of sample.facts.slice(0, -1).toReversed()) {
        if (fact.signature !== latest.signature || fact.statementID !== latest.statementID || !matches(rule, fact)) break;
        count++;
      }
      if (count < rule.threshold) continue;
    } else if (!sample.progressAfterLatest || !matchPattern(rule.claim, sample.progress, budget)) continue;
    const key = `${latest.signature}:${rule.kind === 'failed-claim' ? rulesHash(sample.progress) : ''}`;
    const previous = warned.get(rule.id);
    if (previous && (previous.key === key || time - previous.at < rule.cooldownMs)) continue;
    nudges.push({
      source: `rule:${rule.id}`, ruleID: rule.id, ruleKey: key,
      text: `${rule.nudge}\nEvidence: ${count} consecutive matching outcome(s); tool=${latest.tool}; operation=${latest.operation ?? 'unknown'}; status=${latest.status}; code=${latest.code ?? 'unknown'}; input SHA256 ${latest.inputHash}; output SHA256 ${latest.outputHash}.`,
    });
    if (nudges.length === 2) break;
  }
  return nudges;
}
