import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { TwitchAPI } from '../extension/lib/api.js';
import { ClipIndex, freshIndexSearch, searchIndexPages } from '../extension/lib/index-search.js';
import { filterClips } from '../extension/lib/core.js';

const index = new ClipIndex();
const api = new TwitchAPI();
const clips = new Map();
const store = { async commitPage() {} };
const checks = [];
if (process.argv.includes('--kana-only')) {
  const previous = JSON.parse(await readFile('artifacts/keyword-validation.json', 'utf8'));
  previous.clips.forEach(clip => clips.set(clip.slug, clip));
  checks.push(...previous.checks.filter(check => check.query === 'mondo'));
}
const queries = [
  ['mondo', 'CharmingDarkKangarooWutFace-jXutwg_Zmf0rl3Un'],
  ['モンド', 'LovelyRenownedHerringImGlitch-blk-6gPX3sm9PNj_'],
  ['もんど', 'WiseSavageCrowFeelsBadMan-xhIgzeJqDr1s5IdI'],
];
for (const [query, expected] of queries.filter(([query]) => !process.argv.includes('--kana-only') || query !== 'mondo')) {
  const options = optionsFor(query);
  const scope = freshIndexSearch(options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  let remaining = true;
  try {
    while (remaining) {
      const result = await searchIndexPages({ index, api, store, scope, signal: controller.signal, knownClips: clips });
      if (result.errors.length) console.log(JSON.stringify({ query, notices: result.errors }));
      remaining = result.remaining;
      console.log(JSON.stringify({ query, matchesLoaded: filterClips([...clips.values()], options).length, pages: scope.jobs.map(job => job.page - 1) }));
      if (!result.completed) break;
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally { clearTimeout(timer); }
  const matches = filterClips([...clips.values()], options);
  assert.ok(matches.some(clip => clip.slug === expected), `Missing verified clip for ${query}`);
  checks.push({ query, titleMatches: matches.length, distinctBroadcasters: new Set(matches.map(clip => clip.login)).size, allSourcePagesRead: !remaining, expectedFound: true });
  console.log(JSON.stringify(checks.at(-1)));
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/keyword-validation.json', JSON.stringify({ checks, clips: [...clips.values()] }, null, 2));
}
await mkdir('artifacts', { recursive: true });
const finalCounts = Object.fromEntries(queries.map(([query]) => [query, filterClips([...clips.values()], optionsFor(query)).length]));
await writeFile('artifacts/keyword-validation.json', JSON.stringify({ checks, finalCounts, clips: [...clips.values()] }, null, 2));
console.log(JSON.stringify({ finalCounts }));

function optionsFor(query) { return { query, period: 'ALL_TIME', language: 'ALL', sort: 'views', category: '' }; }
