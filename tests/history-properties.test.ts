import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TranscriptContext } from '@earendil-works/pi-ai';
import fc from 'fast-check';
import type { Request } from '../src/worker.ts';
import type { SessionSummary } from '../src/history.ts';
import type { TestWorkerResult } from './test-support.ts';
import { property, identifier, text } from './pbt-support.ts';

const exec = promisify(execFile);
const bundle = resolve(process.env.SHURIK_BUNDLE ?? 'dist/worker.cjs');
const home = await mkdtemp(join(tmpdir(), 'shurik-history-properties-'));
test.after(() => rm(home, { recursive: true, force: true }));

interface Entry { id: number; conversationId: number; kind: string; model?: unknown }
interface HistoryPage {
  session?: SessionSummary; sessions?: SessionSummary[]; entries?: Entry[];
  hits?: { session: string; entryId: number; excerpt: string }[];
  total?: number; nextOffset: number | null; error?: string; unavailable?: string;
}

async function worker(directory: string, journal: string, id: string, script: Request['script'],
  sessions: SessionSummary[], journalId?: string): Promise<TestWorkerResult> {
  const output = join(directory, 'output-' + id), request = join(directory, id + '.json');
  await writeFile(request, JSON.stringify({ version: 1, id, journalId, journal, cwd: directory, output,
    prompt: 'Use the requested tools, then finish.', model: 'space-bunny-free', reasoning: 'high',
    seconds: 45, sessions, script } satisfies Request));
  const status = await exec(process.execPath, [bundle, request], { timeout: 55000 })
    .then(() => 0, error => { if (error.code !== 2) throw error; return 2; });
  const result = JSON.parse(await readFile(join(output, 'result.json'), 'utf8'));
  assert.equal(status, result.outcome === 'agent_failure' ? 2 : 0);
  return result;
}

async function snapshot(directory: string, excluded?: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  async function visit(relative: string) {
    for (const item of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = join(relative, item.name);
      if (path === excluded) continue;
      if (item.isDirectory()) await visit(path);
      else files.set(path, await readFile(join(directory, path)));
    }
  }
  await visit('');
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}

// Read the native commit log independently of the history extension. This gives
// an oracle for exact entry contents, boundaries, search hits, and page order.
async function committedEntries(directory: string, session: SessionSummary): Promise<Entry[]> {
  const file = session.journalId === undefined ? join(directory, 'main.jsonl')
    : join(directory, 'sessions', session.journalId, 'main.jsonl');
  const entries = new Map<number, Entry>();
  for (const line of (await readFile(file, 'utf8')).trim().split('\n')) {
    const commit = JSON.parse(line) as { writes?: { type: string; value?: Entry }[] };
    for (const write of commit.writes ?? []) {
      const entry = write.value;
      if (write.type === 'entry' && entry && entry.conversationId === 1
        && entry.id >= session.minEntryId! && entry.id <= session.maxEntryId!) entries.set(entry.id, entry);
    }
  }
  return [...entries.values()].sort((a, b) => a.id - b.id);
}

const archive = fc.record({ journalId: identifier.map(id => 'archive-' + id), payload: text,
  rounds: fc.integer({ min: 0, max: 3 }), failed: fc.boolean() });

property('isolated native journals remain readable, searchable, paginated and immutable after cold restore',
  fc.asyncProperty(fc.uniqueArray(archive, { minLength: 2, maxLength: 4, selector: value => value.journalId }),
    fc.boolean(), fc.boolean(), fc.integer({ min: 1, max: 4 }),
    async (generated, legacy, reverse, pageSize) => {
      const directory = await mkdtemp(join(home, 'case-'));
      try {
        const journal = join(directory, 'journal'); await mkdir(journal);
        const sessions: SessionSummary[] = [], expected = new Map<string, Entry[]>();
        const sources: { journalId?: string; payload: string; rounds: number; failed: boolean }[] = legacy
          ? [{ payload: generated[0].payload, rounds: 1, failed: true }, ...generated] : generated;
        for (const [index, source] of sources.entries()) {
          const id = 'session-' + index, marker = 'NATIVE_HISTORY_PROBE_' + index + '_';
          const script: NonNullable<Request['script']> = [
            { tool: 'write', args: { path: id + '.txt', content: marker + 'START\n' + source.payload } },
            ...Array.from({ length: source.rounds }, () => ({ tool: 'read', args: { path: id + '.txt' } })),
            source.failed ? { error: marker + 'END' } : { text: marker + 'END' },
          ];
          const result = await worker(directory, journal, id, script, [], source.journalId);
          assert.equal(result.outcome, source.failed ? 'agent_failure' : 'yielded');
          const session: SessionSummary = { id, journalId: source.journalId, outcome: result.outcome,
            minEntryId: result.minEntryId, maxEntryId: result.maxEntryId };
          sessions.push(session);
          const entries = await committedEntries(journal, session);
          assert.ok(entries.length > 1);
          assert.ok(JSON.stringify(entries).includes(marker + 'START'));
          assert.ok(JSON.stringify(entries).includes(marker + 'END'));
          expected.set(id, entries);
        }
        assert.equal(new Set(sessions.map(session => session.minEntryId)).size, 1,
          'all journals deliberately overlap entry IDs');
        if (reverse) sessions.reverse();
        const original = await snapshot(journal);
        const cold = join(directory, 'cold-journal'); await cp(journal, cold, { recursive: true });
        const script: NonNullable<Request['script']> = [];
        const checks: { tool: string; check: (result: HistoryPage) => void }[] = [];
        function query(tool: string, args: NonNullable<Request['script']>[number]['args'], check: (result: HistoryPage) => void) {
          script.push({ tool, args }); checks.push({ tool, check });
        }
        for (let offset = 0; offset <= sessions.length; offset += pageSize) {
          query('list_sessions', { offset, limit: pageSize }, result => {
            assert.deepEqual(result.sessions, JSON.parse(JSON.stringify(sessions.slice(offset, offset + pageSize))));
            assert.equal(result.nextOffset, offset + pageSize < sessions.length ? offset + pageSize : null);
          });
        }
        for (const session of sessions) {
          const entries = expected.get(session.id)!;
          for (let offset = 0; offset <= entries.length; offset += pageSize) {
            const selected = entries.slice(offset, offset + pageSize);
            assert.ok(JSON.stringify(selected).length < 23000, 'generated pages fit the transcript byte cap');
            query('read_session', { id: session.id, offset, limit: pageSize }, result => {
              assert.deepEqual(result.session, JSON.parse(JSON.stringify(session)));
              assert.equal(result.unavailable, undefined);
              assert.deepEqual(result.entries, selected);
              assert.equal(result.nextOffset, offset + selected.length < entries.length ? offset + selected.length : null);
            });
          }
        }
        for (const needle of ['native_history_probe_', 'NATIVE_HISTORY_PROBE_1_', 'NO_SUCH_RETAINED_MARKER']) {
          const hits = sessions.flatMap(session => expected.get(session.id)!
            .filter(entry => JSON.stringify(entry).toLowerCase().includes(needle.toLowerCase()))
            .map(entry => ({ session: session.id, entryId: entry.id })));
          for (let offset = 0; offset <= hits.length; offset += pageSize) {
            query('search_sessions', { query: needle, offset, limit: pageSize }, result => {
              assert.equal(result.total, hits.length);
              assert.deepEqual(result.hits?.map(({ session, entryId }) => ({ session, entryId })), hits.slice(offset, offset + pageSize));
              assert.ok(result.hits?.every(hit => hit.excerpt.toLowerCase().includes(needle.toLowerCase())));
              assert.equal(result.nextOffset, offset + pageSize < hits.length ? offset + pageSize : null);
            });
          }
        }
        query('read_session', { id: 'unknown-session' }, result => assert.equal(result.error, 'Unknown session ID'));
        script.push({ text: 'History verified' });
        const result = await worker(directory, cold, 'reader', script, sessions, 'reader');
        assert.equal(result.outcome, 'yielded');
        assert.ok(!JSON.stringify(result.captured[0]).includes('NATIVE_HISTORY_PROBE_'), 'fresh context excludes archived transcripts');
        const messages = (result.captured.at(-1) as TranscriptContext).messages.filter(message => message.role === 'toolResult');
        assert.equal(messages.length, checks.length);
        for (const [index, message] of messages.entries()) {
          assert.equal(message.toolName, checks[index].tool);
          assert.equal(message.isError, false);
          const output = message.content.filter(block => block.type === 'text').map(block => block.text).join('');
          checks[index].check(JSON.parse(output));
        }
        assert.deepEqual(await snapshot(journal), original, 'original archived files never change');
        assert.deepEqual(await snapshot(cold, join('sessions', 'reader')), original, 'retrieval never changes cold-restored archives');
        assert.deepEqual((await readdir(join(cold, 'sessions'))).sort(),
          [...generated.map(source => source.journalId), 'reader'].sort());
        if (!legacy) await assert.rejects(readFile(join(cold, 'main.jsonl')), { code: 'ENOENT' });
      } finally { await rm(directory, { recursive: true, force: true }); }
    }), 20);
