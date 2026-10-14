import assert from 'node:assert/strict';
import { TwitchAPI } from '../extension/lib/api.js';
import { filterClips } from '../extension/lib/core.js';

const api = new TwitchAPI();
const signal = new AbortController().signal;
await api.initialize(signal);
const directory = await api.directory(null, signal);
assert.ok(directory.names.length > 0);
const scope = { period: 'LAST_MONTH', language: 'JA' };
const first = await api.clips({ name: 'Grand Theft Auto V', cursor: null }, scope, signal);
assert.ok(first.clips.length > 0);
assert.ok(first.clips.every(clip => clip.language === 'JA'));
const broadcasters = new Set(first.clips.map(clip => clip.login));
assert.ok(broadcasters.size > 1, '配信者を横断して取得できる');
const keyword = first.clips[0].title.slice(0, 2);
const matches = filterClips(first.clips, { query: keyword });
assert.ok(matches.some(clip => clip.slug === first.clips[0].slug));
// The extension's browser-origin pagination is verified in browser-check.js --live.
// Twitch may require client integrity for non-browser pagination requests.
assert.ok(!first.hasNext || first.cursor);
console.log(JSON.stringify({ directoryCategories: directory.names.length, firstPageClips: first.clips.length, distinctBroadcasters: broadcasters.size, keywordMatches: matches.length }, null, 2));
