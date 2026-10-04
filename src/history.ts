import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, type Conversation, type EntryId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

export interface SessionSummary {
  id: string; outcome: string; minEntryId?: number; maxEntryId?: number; error?: string;
  runId?: string; checkpointAt?: string; recovery?: string; transcript?: 'complete' | 'checkpoint' | 'unavailable';
}
export function historyExtension(root: () => Conversation, sessions: SessionSummary[]) {
  const page = Type.Optional(Type.Integer({ minimum: 0 }));
  const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 50 }));
  async function entries(session: SessionSummary) {
    if (session.minEntryId === undefined || session.maxEntryId === undefined) return [];
    const all = []; let cursor;
    do {
      const p = await root().entries({ minEntryId: session.minEntryId as EntryId, maxEntryId: session.maxEntryId as EntryId }, 200, cursor, BACKGROUND_CONTEXT);
      all.push(...p.items); cursor = p.next;
    } while (cursor !== undefined);
    return all.reverse();
  }
  const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  return defineExtension({ name: 'history', tools: [
    defineTool({ name: 'list_sessions', description: 'List retained previous iterations, including failures. Offset pagination.',
      parameters: Type.Object({ offset: page, limit }), replay: 'safe',
      execute: async ({ offset = 0, limit = 20 }) => text({ sessions: sessions.slice(offset, offset + limit), nextOffset: offset + limit < sessions.length ? offset + limit : null }) }),
    defineTool({ name: 'search_sessions', description: 'Search ALL retained sessions literally, returning bounded excerpts and entry IDs. Offset pagination.',
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }), offset: page, limit }), replay: 'safe',
      execute: async ({ query, offset = 0, limit = 20 }) => {
        const hits = []; let total = 0;
        for (const session of sessions) {
          for (const entry of await entries(session)) {
            const value = JSON.stringify(entry); const pos = value.toLowerCase().indexOf(query.toLowerCase());
            if (pos < 0) continue;
            if (total >= offset && hits.length < limit) hits.push({ session: session.id, entryId: entry.id, excerpt: value.slice(Math.max(0, pos - 150), pos + 500) });
            total++;
          }
        }
        return text({ hits, total, nextOffset: offset + limit < total ? offset + limit : null });
      } }),
    defineTool({ name: 'read_session', description: 'Read a previous session transcript by session ID. Bounded entry pagination; output capped at 24 KB.',
      parameters: Type.Object({ id: Type.String(), offset: page, limit }), replay: 'safe',
      execute: async ({ id, offset = 0, limit = 10 }) => {
        const session = sessions.find(s => s.id === id);
        if (!session) return text({ error: 'Unknown session ID' });
        const all = await entries(session); const selected = [];
        let size = 0;
        for (const entry of all.slice(offset, offset + limit)) {
          const value = JSON.stringify(entry); const bounded = value.length > 20000 ? { id: entry.id, excerpt: value.slice(0, 20000), truncated: true } : entry;
          if (size + JSON.stringify(bounded).length > 24000) break;
          selected.push(bounded); size += JSON.stringify(bounded).length;
        }
        return text({ session, entries: selected,
          unavailable: session.minEntryId === undefined || session.maxEntryId === undefined
            ? 'No durable transcript boundaries were published for this iteration. Inspect its error and recovery report.' : undefined,
          nextOffset: offset + selected.length < all.length ? offset + selected.length : null });
      } })
  ] });
}
