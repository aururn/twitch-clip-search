import assert from 'node:assert/strict';
import { TwitchAPI } from '../extension/lib/api.js';
import { collectRound } from '../extension/lib/collector.js';
import { filterClips, freshScope } from '../extension/lib/core.js';

// Compare the same language and date range, so removing a date filter cannot
// masquerade as improved retrieval. No cookies or account credentials are used.
const api = new TwitchAPI();
const signal = new AbortController().signal;
const scope = freshScope('ALL_TIME', 'JA');
const index = new Map();
await api.initialize(signal);
for (const category of scope.categories.slice(0, 5)) {
  const page = await api.clips(category, scope, signal);
  page.clips.forEach(clip => index.set(clip.slug, clip));
}
const baseline = new Map(index);
const before = filterClips([...baseline.values()], { query: '爆笑', period: 'ALL_TIME' }).length;
scope.directoryDone = true;
scope.categories = [];
const store = {
  async commitPage(clips) { clips.forEach(clip => index.set(clip.slug, clip)); },
  async putMeta() {},
};
const result = await collectRound({ api, store, scope, signal, query: '爆笑', knownClips: baseline.values(), broadcasterLimit: 40 });
assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
const additional = [...index.keys()].filter(slug => !baseline.has(slug)).length;
assert.ok(additional > 0, 'Broadcaster discovery adds clips missing from category rankings');
const after = filterClips([...index.values()], { query: '爆笑', period: 'ALL_TIME' }).length;
assert.ok(after >= before);
console.log(JSON.stringify({ period: scope.period, language: scope.language, categoryClips: baseline.size, expandedClips: index.size, additionalClips: additional, queriedBroadcasters: result.completed, keyword: '爆笑', matchesBefore: before, matchesAfter: after }, null, 2));
