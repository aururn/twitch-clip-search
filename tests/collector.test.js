import test from 'node:test';
import assert from 'node:assert/strict';
import { collectRound } from '../extension/lib/collector.js';
import { TwitchAPI } from '../extension/lib/api.js';

function setup() {
  const commits = [];
  const records = [];
  const store = { async commitPage(clips, scope) { commits.push({ clips, scope: structuredClone(scope) }); }, async putMeta(scope) { records.push(structuredClone(scope)); } };
  const scope = { key: 'LAST_MONTH:JA', period: 'LAST_MONTH', language: 'JA', directoryDone: true, updatedAt: 0, categories: [{ name: 'A', cursor: null, pages: 0, done: false, error: '' }, { name: 'B', cursor: null, pages: 0, done: false, error: '' }] };
  return { store, scope, commits, records, signal: new AbortController().signal };
}

test('追加取得は保存したカーソルから進み、完了したカテゴリを再取得しない', async () => {
  const env = setup();
  const requests = [];
  const api = { async clips(category) {
    requests.push([category.name, category.cursor]);
    return { clips: [{ slug: `${category.name}-${category.pages}` }], cursor: category.pages === 0 ? 'next' : null, hasNext: category.pages === 0 };
  } };
  await collectRound({ ...env, api });
  await collectRound({ ...env, api });
  const result = await collectRound({ ...env, api });
  assert.deepEqual(requests, [['A', null], ['B', null], ['A', 'next'], ['B', 'next']]);
  assert.equal(result.remaining, false);
  assert.equal(env.commits[0].scope.categories[0].cursor, 'next');
  assert.equal(env.commits[0].scope.categories[1].pages, 0, 'チェックポイントを後続の変更から守る');
});

test('部分失敗で成功データを失わず、失敗カテゴリを次回再試行する', async () => {
  const env = setup();
  const api = { async clips(category) { if (category.name === 'A') throw new Error('network'); return { clips: [{ slug: 'B1' }], cursor: null, hasNext: false }; } };
  const result = await collectRound({ ...env, api });
  assert.equal(result.errors.length, 1);
  assert.equal(env.scope.categories[0].cursor, null);
  assert.equal(env.scope.categories[0].pages, 0);
  assert.equal(env.commits.length, 1);
  assert.equal(result.remaining, true);
});

test('停止済みの収集は新しいリクエストを送らない', async () => {
  const env = setup();
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(collectRound({ ...env, signal: controller.signal, api: { async clips() { called = true; } } }), { name: 'AbortError' });
  assert.equal(called, false);
});

test('繰り返されたカーソルで無限にページを取得しない', async () => {
  const env = setup();
  env.scope.categories[0].cursor = 'repeated';
  const result = await collectRound({ ...env, api: { async clips() { return { clips: [], cursor: 'repeated', hasNext: true }; } } });
  assert.equal(env.scope.categories[0].done, true);
  assert.equal(result.completed, 2);
});

test('カテゴリ探索が失敗しても既知カテゴリを取得できる', async () => {
  const env = setup();
  env.scope.directoryDone = false;
  const result = await collectRound({ ...env, api: { async directory() { throw new Error('directory error'); }, async clips() { return { clips: [{ slug: 'ok' }], hasNext: false, cursor: null }; } } });
  assert.equal(result.errors[0].category, 'カテゴリ一覧');
  assert.equal(env.commits.length, 2);
});

test('APIは配信者を指定せず言語・期間・カーソルを送る', async () => {
  let payload;
  const api = new TwitchAPI(async (_, options) => {
    payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ data: { game: { clips: { edges: [], pageInfo: { hasNextPage: false } } } } }));
  });
  await api.clips({ name: 'Minecraft', cursor: 'next' }, { period: 'ALL_TIME', language: 'JA' }, new AbortController().signal);
  assert.deepEqual(payload.variables, { name: 'Minecraft', after: 'next', criteria: { period: 'ALL_TIME', languages: ['JA'] } });
  assert.equal(Object.hasOwn(payload.variables.criteria, 'broadcasterID'), false);
});

test('APIの仕様変更を空の正常な結果として扱わない', async () => {
  const api = new TwitchAPI(async () => new Response(JSON.stringify({ errors: [{ message: 'schema changed' }] })));
  await assert.rejects(api.directory(null, new AbortController().signal), /schema changed/);
});
