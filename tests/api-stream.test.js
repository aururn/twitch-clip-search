import test from 'node:test';
import assert from 'node:assert/strict';
import { TwitchAPI } from '../extension/lib/api.js';

test('Twitchのメタデータを検証できたバッチごとに通知する', async () => {
  const events = [];
  const api = new TwitchAPI(async (_, init) => {
    const slugs = Object.values(JSON.parse(init.body).variables);
    events.push(`fetch:${slugs.length}`);
    return new Response(JSON.stringify({ data: Object.fromEntries(slugs.map((slug, index) => [`c${index}`, { slug, title: 'mondo', createdAt: '2026-10-18T00:00:00Z' }])) }));
  });
  const result = await api.hydrate(Array.from({ length: 11 }, (_, index) => `clip-${index}`), new AbortController().signal, batch => { events.push(`publish:${batch.length}`); });
  assert.equal(result.length, 11);
  assert.deepEqual(events, ['fetch:10', 'publish:10', 'fetch:1', 'publish:1']);
});
