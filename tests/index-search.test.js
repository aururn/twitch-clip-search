import test from 'node:test';
import assert from 'node:assert/strict';
import { ClipIndex, freshIndexSearch, searchIndexPages } from '../extension/lib/index-search.js';

const options = { query: 'mondo', period: 'ALL_TIME', language: 'ALL', sort: 'views', category: '' };
const signal = () => new AbortController().signal;
function setup() {
  const commits = [];
  const scope = freshIndexSearch(options);
  scope.jobs = [scope.jobs[0]];
  const store = { async commitPage(clips, checkpoint) { commits.push({ clips, checkpoint: structuredClone(checkpoint) }); } };
  return { scope, store, commits, signal: signal() };
}

test('検索語と日時を公開検索元へ送り、認証情報や参照元を送らない', async () => {
  let request;
  const index = new ClipIndex(async (url, init) => {
    request = { url: new URL(url), init };
    return new Response(JSON.stringify({ records: [], totalRecords: 0 }));
  });
  await index.page({ source: 'allClips', term: 'mondo', page: 7 }, options, signal(), Date.parse('2026-10-17T19:00:00Z'));
  assert.equal(request.url.searchParams.get('target_end_date'), '2026-10-18');
  assert.equal(request.url.searchParams.get('target_start_date'), '2016-05-01');
  assert.equal(request.url.searchParams.get('page_number'), '7');
  assert.equal(request.url.searchParams.get('search'), 'mondo');
  assert.equal(request.init.credentials, 'omit');
  assert.equal(request.init.referrerPolicy, 'no-referrer');
});

test('かな表記は両方を探し、直近の小さなクリップも別データソースで探す', () => {
  const scope = freshIndexSearch({ ...options, query: 'モンド -ネタバレ' });
  assert.deepEqual([...new Set(scope.jobs.map(job => job.term))], ['モンド', 'もんど']);
  assert.deepEqual([...new Set(scope.jobs.map(job => job.source))], ['allClips', 'dailyClips', 'monthlyClips']);
  assert.equal(freshIndexSearch({ ...options, query: '-ネタバレ' }).jobs.length, 0);
});

test('配信者名だけの一致を捨て、タイトルの一致だけをTwitchで検証して保存する', async () => {
  const env = setup();
  const index = { async page() { return { total: 1658, hasNext: true, records: [
    { id: 'real', title: 'mondo高速ヘリ撃破' },
    { id: 'caster-only', title: '空き巣k4sen', login: 'mondo2244' },
    { id: 'renamed', title: 'mondo 古いタイトル' },
    { id: 'deleted', title: 'mondo 削除済み' },
    { id: '../bad', title: 'mondo' },
  ] }; } };
  let requested;
  const api = { async hydrate(slugs) { requested = slugs; return [{ slug: 'real', title: 'mondo高速ヘリ撃破' }, { slug: 'renamed', title: '変更後のタイトル' }]; } };
  const result = await searchIndexPages({ ...env, index, api });
  assert.deepEqual(requested, ['real', 'renamed', 'deleted']);
  assert.deepEqual(env.commits[0].clips.map(clip => clip.slug), ['real']);
  assert.equal(result.added, 1, '検索元の1658件をタイトル一致数として使わない');
  assert.equal(env.scope.jobs[0].page, 2);
  assert.equal(result.remaining, true);
});

test('200件より後の検索結果も進捗から再開し、ANDと除外を適用する', async () => {
  const env = setup();
  env.scope.options.query = 'mondo 初見 -ネタバレ';
  env.scope.jobs[0].page = 8;
  const index = { async page(job) { assert.equal(job.page, 8); return { total: 1501, hasNext: false, records: [
    { id: 'beyond100', title: 'Mondo 初見プレイ' },
    { id: 'excluded', title: 'Mondo 初見 ネタバレ' },
    { id: 'missing-term', title: 'Mondo いつものプレイ' },
  ] }; } };
  const api = { async hydrate(slugs) { assert.deepEqual(slugs, ['beyond100']); return [{ slug: 'beyond100', title: 'Mondo 初見プレイ' }]; } };
  const result = await searchIndexPages({ ...env, index, api });
  assert.equal(result.remaining, false);
  assert.equal(env.scope.jobs[0].page, 9);
  assert.equal(env.commits[0].checkpoint.jobs[0].done, true);
});

test('検索元の失敗や壊れたページを空の検索結果として完了扱いしない', async () => {
  const env = setup();
  const index = { async page() { throw new Error('HTTP 429'); } };
  const result = await searchIndexPages({ ...env, index, api: {} });
  assert.equal(result.remaining, true);
  assert.equal(env.scope.jobs[0].page, 1);
  assert.equal(env.commits.length, 0);
  const broken = new ClipIndex(async () => new Response(JSON.stringify({ records: [], totalRecords: 900 })));
  await assert.rejects(broken.page(env.scope.jobs[0], options, signal()), /続きが読み込まれません/);
});

test('検証中の停止では進捗を進めず、保存済みデータは変更しない', async () => {
  const env = setup();
  const controller = new AbortController();
  const index = { async page() { return { total: 1, hasNext: false, records: [{ id: 'real', title: 'mondo' }] }; } };
  const api = { async hydrate() { controller.abort(); return [{ slug: 'real', title: 'mondo' }]; } };
  await assert.rejects(searchIndexPages({ ...env, index, api, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(env.scope.jobs[0].page, 1);
  assert.equal(env.commits.length, 0);
});

test('別の検索元に同じクリップがあっても重複追加や再検証をしない', async () => {
  const env = setup();
  env.scope.jobs = freshIndexSearch(options).jobs;
  let calls = 0;
  const index = { async page() { return { total: 1, hasNext: false, records: [{ id: 'real', title: 'mondo' }] }; } };
  const api = { async hydrate() { calls++; return [{ slug: 'real', title: 'mondo', fetchedAt: Date.now() }]; } };
  const result = await searchIndexPages({ ...env, index, api });
  assert.equal(result.added, 1);
  assert.equal(calls, 1);
});

test('遅い検索データを一時的に保留しても他のデータから検索できる', async () => {
  const env = setup();
  env.scope.jobs = freshIndexSearch(options).jobs;
  const called = [];
  const index = { async page(job) {
    called.push(job.source);
    if (job.source === 'dailyClips') throw new Error('timeout');
    return { total: 0, hasNext: false, records: [] };
  } };
  const result = await searchIndexPages({ ...env, index, api: {} });
  assert.equal(result.completed, 2);
  assert.equal(result.remaining, true);
  assert.equal(env.scope.jobs[1].page, 1);
  assert.ok(env.scope.jobs[1].retryAt > Date.now());
  called.length = 0;
  await searchIndexPages({ ...env, index, api: {} });
  assert.deepEqual(called, [], '失敗した検索元をすぐに連続で再試行しない');
});

test('HTTP 429ではRetry-Afterを尊重し、同じ検索元へ連続で送らない', async () => {
  const env = setup();
  env.scope.jobs = freshIndexSearch(options).jobs;
  let calls = 0;
  const index = new ClipIndex(async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '120' } }); });
  const result = await searchIndexPages({ ...env, index, api: {} });
  assert.equal(calls, 1);
  assert.match(result.errors[0], /429/);
  assert.ok(env.scope.jobs.every(job => job.retryAt > Date.now() + 110000));
  assert.ok(env.scope.jobs.every(job => job.page === 1 && !job.done));
});
