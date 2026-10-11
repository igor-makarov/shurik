import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import fc from 'fast-check';
import {
  validateId, validateReasoning, validateCreatePr, resumeSettings, claimable,
  stopped, cancelledForLoop, trustedRecovery, classify, nextRuntime, redact, loopSnapshot,
} from '../scripts/policy.ts';
import { PATHS, runtimeState, runtimeLogs, runtimeEmergency, sessionPaths, workBranch, controlBranch } from '../scripts/paths.ts';
import { projectConfig } from '../scripts/config.ts';
import { runFence, failureKey, completedIterationRun, upsertSession, sessionSummary } from '../scripts/failures.ts';
import { timeRemainingInstructions } from '../src/checkpoint.ts';
import { parseArgs } from '../bin/shurik.ts';
import { actionOptions } from '../action/run.ts';
import { property, text, identifier, positive, control, terminal, reasoning, sha } from './pbt-support.mjs';

const home = await mkdtemp(join(tmpdir(), 'shurik-pbt-home-'));
process.env.SHURIK_HOME = home;
test.after(() => rm(home, { recursive: true, force: true }));
const repository = fc.tuple(identifier, identifier).map(parts => parts.join('/'));
const now = Date.parse('2026-10-11T12:00:00Z');
const forbiddenId = fc.oneof(
  identifier.map(id => '../' + id), identifier.map(id => id + '/child'),
  identifier.map(id => id + ' '), identifier.map(id => id.toUpperCase() + 'A'),
  identifier.map(id => '-' + id), fc.constant(''), fc.constant('x'.repeat(50)),
  fc.constantFrom('\0', '.', '..', 'a;exit', 'a\nb', 'a\\b', 'a~1', 'a.lock'),
);
const title = (id, generation, iteration, prefix = 'Shurik') =>
  prefix + ' ' + id + ' / iterate ' + generation + '-' + iteration;
const copy = value => JSON.stringify(value);

property('valid loop IDs produce confined paths and separate work/control refs',
  fc.property(identifier, repository, (id, repo) => {
    assert.equal(validateId(id), id);
    assert.notEqual(workBranch(id), controlBranch(id));
    const path = relative(join(home, 'state'), runtimeState(repo, id));
    assert.equal(path, repo + '/' + id);
    assert.ok(!isAbsolute(path) && !path.startsWith('../'));
  }));

property('unsafe loop IDs are rejected by every path and ref entry point',
  fc.property(forbiddenId, id => {
    for (const call of [
      () => validateId(id), () => workBranch(id), () => controlBranch(id),
      () => runtimeState('owner/project', id), () => sessionPaths('/tmp/project', id, 'owner/project'),
      () => runtimeLogs('owner/project', id), () => runtimeEmergency('owner/project', id),
    ]) assert.throws(call, /Loop ID/);
  }));

property('session namespaces do not alias repositories or depend on the task checkout',
  fc.property(repository, identifier, identifier, (repo, id, checkout) => {
    const first = sessionPaths(join(home, 'checkout-a'), id, repo);
    const second = sessionPaths(join(home, checkout), id, repo);
    assert.deepEqual(first.runtime, second.runtime);
    assert.deepEqual(first.control, second.control);
    assert.equal(first.emergency, second.emergency);
    assert.equal(first.runtime.diagnostics, join(home, 'logs', repo, id));
    assert.equal(first.emergency, join(home, 'emergency', repo, id, `${process.env.GITHUB_RUN_ID ?? 'local'}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`));
    assert.notEqual(runtimeState(repo, id), runtimeState('other-' + repo, id));
    assert.notEqual(runtimeState(repo, id), runtimeState(repo, 'other-' + id.slice(0, 43)));
    for (const [name, path] of Object.entries(first.runtime)) {
      if (name === 'state' || name === 'diagnostics') continue;
      assert.equal(relative(first.runtime.state, path), relative(PATHS.controlState, first.control[name]));
    }
  }));

property('repository traversal and malformed namespaces cannot escape runtime storage',
  fc.property(identifier, identifier, (owner, repo) => {
    for (const bad of [
      '../' + repo, owner + '/..', './' + repo, owner + '/.',
      '/' + owner + '/' + repo, owner + '/' + repo + '/extra',
      owner + '\\' + repo, owner + '/../../' + repo, owner + '\0/' + repo,
    ]) for (const directory of [runtimeState, runtimeLogs, runtimeEmergency]) assert.throws(() => directory(bad, 'loop'), /Repository/);
  }));

property('explicit CLI flags override dispatch JSON without mutating it',
  fc.property(reasoning, text, fc.boolean(), (level, model, createPr) => {
    const inputs = { reasoning: 'off', model: 'previous', create_pr: !createPr, loop_id: 'loop', seconds: '120' };
    const before = copy(inputs);
    const options = parseArgs(['resume', '--reasoning', level, '--model', 'model-' + model,
      '--create-pr', String(createPr)], inputs);
    assert.equal(options.command, 'resume');
    assert.equal(options.reasoning, level); assert.equal(options.model, 'model-' + model);
    assert.equal(validateCreatePr(options.create_pr), createPr);
    assert.equal(options.loop_id, inputs.loop_id); assert.equal(options.seconds, inputs.seconds);
    assert.equal(copy(inputs), before);
  }));

property('explicit action values override JSON including a false PR setting',
  fc.property(reasoning, fc.boolean(), (level, createPr) => {
    const env = { SHURIK_INPUTS: JSON.stringify({ command: 'start', loop_id: 'loop',
      reasoning: 'off', create_pr: !createPr }), SHURIK_COMMAND: 'resume',
    SHURIK_REASONING: level, SHURIK_CREATE_PR: String(createPr) };
    const before = copy(env), options = actionOptions(env);
    assert.equal(options.command, 'resume'); assert.equal(options.reasoning, level);
    assert.equal(validateCreatePr(options.create_pr), createPr);
    assert.equal(copy(env), before);
  }));

property('resume advances one generation, clears ownership and retains checkpoint identity',
  fc.property(control, reasoning, text, (previous, level, model) => {
    previous = { ...previous, status: 'stopped' };
    const before = copy(previous);
    const resumed = resumeSettings(previous, { reasoning: level, model: 'next-' + model });
    assert.equal(resumed.generation, previous.generation + 1);
    assert.equal(resumed.status, 'running'); assert.equal(resumed.owner, null);
    assert.equal(resumed.lastRunId, null); assert.equal(resumed.reasoning, level);
    assert.equal(resumed.model, ('next-' + model).trim()); assert.equal(resumed.deadline, null);
    for (const field of ['id', 'branch', 'engine', 'source', 'next', 'seconds', 'checkpoint']) {
      assert.deepEqual(resumed[field], previous[field]);
    }
    assert.equal(copy(previous), before);
  }));

property('resuming fences every invocation from an earlier generation',
  fc.property(control, reasoning, (previous, level) => {
    previous = { ...previous, status: 'stopped' };
    const resumed = resumeSettings(previous, { reasoning: level });
    assert.equal(claimable(resumed, previous.generation, resumed.next, 'old-run'), false);
    assert.equal(claimable(resumed, resumed.generation, resumed.next, 'new-run'), true);
  }));

property('resume requires fresh valid reasoning and rejects already-running loops',
  fc.property(control, reasoning, identifier, (previous, level, invalid) => {
    const stoppedControl = { ...previous, status: 'stopped', reasoning: level };
    for (const value of [undefined, '', 'unsupported-' + invalid]) {
      assert.throws(() => resumeSettings(stoppedControl, { reasoning: value }), /reasoning/);
      assert.throws(() => validateReasoning(value), /reasoning/);
    }
    assert.throws(() => resumeSettings({ ...previous, status: 'running' }, { reasoning: level }), /already running/);
  }));

property('PR settings survive resume unless explicitly overridden; boolean/string forms agree',
  fc.property(control, fc.constantFrom(true, false, 'auto'), fc.boolean(), (previous, mode, override) => {
    previous = { ...previous, status: 'stopped', createPr: mode };
    assert.equal(resumeSettings(previous, { reasoning: 'high' }).createPr, mode);
    for (const value of [override, String(override)]) {
      assert.equal(validateCreatePr(value), override);
      assert.equal(resumeSettings(previous, { reasoning: 'high', create_pr: value }).createPr, override);
    }
    assert.equal(resumeSettings(previous, { reasoning: 'high', create_pr: 'auto' }).createPr, 'auto');
  }));

property('claims require current generation, iteration and owner and a running loop',
  fc.property(control, positive, (c, delta) => {
    c = { ...c, status: 'running', deadline: null, owner: null };
    assert.equal(claimable(c, c.generation, c.next, 'run'), true);
    assert.equal(claimable(c, c.generation + delta, c.next, 'run'), false);
    assert.equal(claimable(c, c.generation, c.next + delta, 'run'), false);
    assert.equal(claimable({ ...c, owner: { runId: 'other' } }, c.generation, c.next, 'run'), false);
    assert.equal(claimable({ ...c, owner: { runId: 'run' } }, c.generation, c.next, 'run'), true);
    for (const status of ['stopped', 'deadline']) {
      assert.equal(claimable({ ...c, status }, c.generation, c.next, 'run'), false);
    }
    assert.equal(claimable({ ...c, deadline: '2000-01-01T00:00:00Z' }, c.generation, c.next, 'run'), false);
  }));

property('deadline expiry is inclusive and cannot reverse as time advances',
  fc.property(fc.integer({ min: -1000000, max: 1000000 }), positive, (offset, step) => {
    const deadline = now + offset, c = { status: 'running', deadline: new Date(deadline).toISOString() };
    assert.equal(stopped(c, deadline - 1), false);
    assert.equal(stopped(c, deadline), true); assert.equal(stopped(c, deadline + step), true);
    assert.equal(stopped({ ...c, status: 'stopped' }, deadline - step), true);
  }));

property('queued cancellation only stops the matching loop generation and iteration',
  fc.property(control, positive, fc.constantFrom('Shurik', 'Ralph'), (c, delta, prefix) => {
    c = { ...c, owner: null, lastRunId: null };
    const run = { id: 99, conclusion: 'cancelled', display_title: title(c.id, c.generation, c.next, prefix) };
    assert.equal(cancelledForLoop(c, run), true);
    for (const display_title of [
      title('other-' + c.id, c.generation, c.next, prefix),
      title(c.id, c.generation + delta, c.next, prefix),
      title(c.id, c.generation, c.next + delta, prefix),
    ]) assert.equal(cancelledForLoop(c, { ...run, display_title }), false);
    assert.equal(cancelledForLoop(c, { ...run, conclusion: 'failure' }), false);
    assert.equal(cancelledForLoop({ ...c, owner: { runId: 'different' } }, run), false);
  }));

property('recovery trusts only first-party dispatches on the default branch',
  fc.property(repository, identifier, fc.constantFrom('Shurik', 'Shurik Ralph'), (repo, branch, name) => {
    const run = { name, event: 'workflow_dispatch', repository: { full_name: repo },
      head_repository: { full_name: repo }, head_branch: branch };
    const trusted = { workflow_run: run, repository: { default_branch: branch } };
    assert.equal(trustedRecovery(trusted, repo), true);
    for (const changed of [
      { event: 'pull_request' }, { name: 'Other' }, { head_branch: 'other-' + branch },
      { repository: { full_name: 'other-' + repo } }, { head_repository: { full_name: 'fork-' + repo } },
    ]) assert.equal(trustedRecovery({ ...trusted, workflow_run: { ...run, ...changed } }, repo), false);
  }));

property('same-workflow recovery requires a completed iteration with a matching result',
  fc.property(fc.constantFrom('success', 'failure', 'cancelled'), positive, text, (result, id, title) => {
    const run = { id, name: title, status: 'in_progress', conclusion: null };
    const before = copy(run);
    const job = { id: id + 1, name: 'iteration', status: 'completed', conclusion: result };
    const finished = completedIterationRun(run, result, [job]);
    assert.deepEqual(finished, { ...run, status: 'completed', conclusion: result });
    for (const changed of [
      { status: 'in_progress' }, { name: 'control' }, { conclusion: 'skipped' },
      { conclusion: result === 'success' ? 'failure' : 'success' },
    ]) assert.throws(() => completedIterationRun(run, result, [{ ...job, ...changed }]), /not completed/);
    assert.throws(() => completedIterationRun(run, 'skipped', [job]), /Invalid/);
    assert.equal(copy(run), before); assert.equal(job.status, 'completed');
  }));

property('failure report paths are unique across runs and attempts and reject unsafe identities',
  fc.property(positive, positive, positive, (id, attempt, delta) => {
    const key = failureKey({ id, run_attempt: attempt });
    assert.notEqual(key, failureKey({ id: id + delta, run_attempt: attempt }));
    assert.notEqual(key, failureKey({ id, run_attempt: attempt + delta }));
    assert.equal(failureKey({ id }), failureKey({ id, run_attempt: 1 }));
    assert.ok(!key.includes('/') && !key.includes('..'));
    for (const bad of ['../' + id, -id, id + 0.5, 'x' + id]) {
      assert.throws(() => failureKey({ id: bad, run_attempt: attempt }), /identity/);
      assert.throws(() => failureKey({ id, run_attempt: bad }), /identity/);
    }
  }));

property('run-title fences round-trip and cannot identify a different loop',
  fc.property(control, positive, positive, fc.constantFrom('Shurik', 'Ralph'), (c, generation, iteration, prefix) => {
    c = { ...c, owner: null, lastRunId: null };
    assert.deepEqual(runFence(c, { display_title: title(c.id, generation, iteration, prefix) }),
      { generation, iteration, command: 'iterate' });
    assert.equal(runFence(c, { display_title: title('other-' + c.id, generation, iteration, prefix) }), null);
  }));

property('nonzero exits and malformed worker envelopes always classify as runner failures',
  fc.property(terminal, fc.integer({ min: 1, max: 255 }), (outcome, code) => {
    assert.equal(classify({ version: 1, outcome }, 0), outcome);
    for (const result of [null, { version: 0, outcome }, { version: 2, outcome }, { version: 1, outcome: 'unknown' }]) {
      assert.equal(classify(result, 0), 'runner_failure');
    }
    assert.equal(classify({ version: 1, outcome }, code), 'runner_failure');
    assert.equal(classify({ version: 1, outcome }, -code), 'runner_failure');
    assert.equal(classify({ version: 1, outcome }, null), 'runner_failure');
  }));

property('runner rollback is idempotent and retains earlier quarantine evidence',
  fc.property(sha, sha, fc.array(sha, { maxLength: 12 }), (fallback, suffix, quarantine) => {
    const selected = 'candidate-' + suffix;
    const original = { selected, fallback, probation: true, quarantined: quarantine };
    const before = copy(original), rolled = nextRuntime(original, 'runner_failure');
    assert.equal(rolled.selected, fallback); assert.equal(rolled.probation, false);
    assert.ok(rolled.quarantined.includes(selected));
    for (const prior of quarantine) assert.ok(rolled.quarantined.includes(prior));
    assert.equal(rolled.quarantined.length, new Set(rolled.quarantined).size);
    assert.deepEqual(nextRuntime(rolled, 'runner_failure'), rolled);
    assert.equal(copy(original), before);
  }));

property('provider failures, timeout and yield never quarantine or switch a working engine',
  fc.property(sha, sha, fc.array(sha, { maxLength: 12 }), fc.constantFrom('agent_failure', 'timeout', 'yielded'),
    (selected, fallback, quarantine, outcome) => {
      const runtime = { selected, fallback, quarantined: quarantine, probation: true };
      const before = copy(runtime), next = nextRuntime(runtime, outcome);
      assert.equal(next.selected, selected); assert.equal(next.fallback, fallback);
      assert.deepEqual(next.quarantined, quarantine); assert.equal(next.probation, false);
      assert.equal(copy(runtime), before);
    }));

const credential = text.map(value => 'CREDENTIAL_' + value);
property('known credentials and all supported encodings are redacted without changing length',
  fc.property(credential, (secret) => {
    const forms = [...new Set([secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'),
      JSON.stringify(secret).slice(1, -1)])];
    const input = forms.join('\n'), output = redact(input, [secret]);
    assert.equal(output.length, input.length);
    for (const form of forms) assert.ok(!output.includes(form));
    assert.equal(redact(output, [secret]), output);
  }));

property('recognizable GitHub and API tokens are completely masked without a known-secret list',
  fc.property(fc.constantFrom('ghp_', 'github_pat_', 'sk-'),
    fc.array(fc.constantFrom(...'aB3_-'), { minLength: 40, maxLength: 70 }), (prefix, chars) => {
      const suffix = prefix === 'ghp_' ? chars.join('').replaceAll('_', 'a').replaceAll('-', 'b')
        : prefix === 'github_pat_' ? chars.join('').replaceAll('-', '_') : chars.join('');
      const token = prefix + suffix, input = 'before [' + token + '] after';
      assert.equal(redact(input, []), 'before [' + '*'.repeat(token.length) + '] after');
    }));

property('redacting serialized evidence retains valid JSON and unrelated metadata',
  fc.property(credential, fc.integer(), fc.array(fc.boolean(), { maxLength: 20 }), (secret, id, flags) => {
    const evidence = { id, flags, nested: { log: secret, values: [secret] } };
    const output = JSON.parse(redact(JSON.stringify(evidence), [secret]));
    assert.equal(output.id, id); assert.deepEqual(output.flags, flags);
    assert.deepEqual(Object.keys(output.nested), ['log', 'values']);
    assert.ok(!JSON.stringify(output).includes(JSON.stringify(secret).slice(1, -1)));
  }));

const record = fc.record({
  id: fc.integer({ min: 1, max: 12 }).map(id => 'session-' + id),
  outcome: fc.constantFrom('running', 'interrupted', 'yielded', 'agent_failure', 'timeout', 'runner_failure'),
  minEntryId: fc.option(positive, { nil: undefined }), maxEntryId: fc.option(positive, { nil: undefined }),
  error: text,
});
property('session upserts retain every identity in first-seen order with only the latest record',
  fc.property(fc.array(record, { minLength: 1, maxLength: 100 }), records => {
    const sessions = [], model = new Map();
    for (const record of records) {
      const before = copy(record);
      upsertSession(sessions, record); model.set(record.id, record);
      assert.equal(copy(record), before);
      assert.deepEqual(sessions.map(s => s.id), [...model.keys()]);
      for (const session of sessions) {
        const latest = model.get(session.id);
        for (const field of ['outcome', 'error', 'minEntryId', 'maxEntryId']) assert.equal(session[field], latest[field]);
      }
    }
    const before = copy(sessions); upsertSession(sessions, records.at(-1));
    assert.equal(copy(sessions), before);
  }));

property('transcript availability requires both boundaries and distinguishes interrupted checkpoints',
  fc.property(record, record => {
    const summary = sessionSummary(record);
    if (record.minEntryId === undefined || record.maxEntryId === undefined) assert.equal(summary.transcript, 'unavailable');
    else if (['yielded', 'agent_failure', 'timeout'].includes(record.outcome)) assert.equal(summary.transcript, 'complete');
    else assert.equal(summary.transcript, 'checkpoint');
  }));

property('task-facing snapshots exclude ownership, deadlines and recovery machinery',
  fc.property(control, c => {
    const before = copy(c), snapshot = loopSnapshot(c);
    for (const key of ['owner', 'deadline', 'lastDispatchAt', 'failureTrail', 'checkpoint', 'engine']) {
      assert.ok(!Object.hasOwn(snapshot, key));
    }
    for (const key of ['id', 'branch', 'status', 'model', 'reasoning', 'source']) assert.equal(snapshot[key], c[key]);
    assert.equal(copy(c), before);
  }));

property('time feedback respects the earlier limit, clamps expiry and omits early countdowns',
  fc.property(fc.integer({ min: -1000000, max: 1000000 }), fc.option(fc.integer({ min: -1000000, max: 1000000 }), { nil: null }),
    fc.integer({ min: 1, max: 900 }), (iterationMs, loopMs, checkpointSeconds) => {
      const deadline = loopMs === null ? null : new Date(now + loopMs).toISOString();
      const remaining = Math.min(iterationMs, loopMs ?? Infinity);
      const message = timeRemainingInstructions(now + iterationMs, deadline, now, checkpointSeconds);
      assert.match(message, /continue useful work after saving/);
      if (remaining > checkpointSeconds * 1000) {
        assert.doesNotMatch(message, /Time update|seconds remain|handoff|preempt/);
      } else {
        const seconds = Number(/about (\d+) seconds remain in this iteration/.exec(message)[1]);
        assert.ok(seconds >= 0);
        assert.equal(seconds, Math.max(0, Math.ceil(remaining / 1000)));
        assert.ok(message.includes(new Date(now + remaining).toISOString()));
      }
    }));

property('named action configuration needs no project file and preserves explicit settings',
  fc.asyncProperty(identifier, identifier, fc.integer({ min: 10, max: 1800 }),
    fc.integer({ min: 1, max: 1800 }), async (model, name, seconds, checkpoint) => {
      const inputs = { model, prompt: name + '.md', seconds: String(seconds),
        checkpoint_seconds: String(checkpoint), checkpoint_paths: JSON.stringify(['data/' + name]) };
      const before = copy(inputs), config = await projectConfig(join(home, 'no-config'), inputs);
      assert.equal(config.model, model); assert.equal(config.prompt, name + '.md');
      assert.equal(config.iterationSeconds, seconds); assert.equal(config.checkpointSeconds, checkpoint);
      assert.deepEqual(config.checkpointPaths, ['data/' + name]); assert.equal(copy(inputs), before);
    }));
