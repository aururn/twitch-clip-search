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
  assert.equal(result.errors[0].source, 'カテゴリ一覧');
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

test('カテゴリ上位にないクリップを配信者の自動発見で追加し、期間の進捗を保存する', async () => {
  const env = setup();
  env.scope.period = 'ALL_TIME';
  env.scope.categories = [env.scope.categories[0]];
  const ranked = { slug: 'ranked', login: 'creator', broadcaster: 'Creator', title: '爆笑', language: 'JA' };
  const calls = [];
  const api = {
    async clips() { return { clips: [ranked], cursor: 'next', hasNext: true }; },
    async broadcasterClips(login, period) {
      calls.push([login, period]);
      return { clips: [ranked, { ...ranked, slug: period, title: '爆笑：カテゴリ上位にないクリップ' }], hasNext: true };
    },
  };
  const first = await collectRound({ ...env, api, query: '爆笑' });
  assert.equal(first.added, 2, '重複を追加件数に数えない');
  assert.equal(env.commits.at(-1).clips[1].slug, 'ALL_TIME');
  assert.deepEqual(env.commits.at(-1).scope.broadcasters[0].periods, ['ALL_TIME']);
  await collectRound({ ...env, api, knownClips: [ranked, { slug: 'ALL_TIME' }] });
  assert.deepEqual(calls, [['creator', 'ALL_TIME'], ['creator', 'LAST_MONTH']], '次の期間へ進み同じ上位100件を再取得しない');
  assert.equal(env.scope.categories[0].pages, 1, '未取得の配信者を制限されたカテゴリの続きより優先する');
});

test('配信者の取得が失敗しても結果と未完了のチェックポイントを保持する', async () => {
  const env = setup();
  env.scope.categories = [];
  const clip = { slug: 'old', login: 'creator', title: '爆笑', language: 'JA' };
  const api = { async broadcasterClips() { throw new Error('network'); } };
  const failed = await collectRound({ ...env, api, knownClips: [clip] });
  assert.equal(failed.errors.length, 1);
  assert.deepEqual(env.scope.broadcasters[0].periods, []);
  api.broadcasterClips = async () => ({ clips: [clip, { ...clip, slug: 'new' }], hasNext: false });
  const retry = await collectRound({ ...env, api, knownClips: [clip] });
  assert.equal(retry.added, 1);
  assert.deepEqual(env.scope.broadcasters[0].periods, ['LAST_MONTH']);
});

test('一致したタイトルの配信者を優先するが、配信者名をタイトル検索には使わない', async () => {
  const env = setup();
  env.scope.categories = [];
  const clips = [
    { slug: 'A', login: 'alice', title: '普通', language: 'JA' },
    { slug: 'B', login: 'bob', title: '大爆笑', language: 'JA' },
  ];
  const calls = [];
  const api = { async broadcasterClips(login) { calls.push(login); return { clips: [], hasNext: false }; } };
  await collectRound({ ...env, api, knownClips: clips, query: '爆笑', broadcasterLimit: 1 });
  assert.deepEqual(calls, ['bob']);
});

test('配信者の取得にログイン名と期間を送り、欠けたデータを成功扱いしない', async () => {
  let payload;
  const api = new TwitchAPI(async (_, options) => {
    payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ data: { user: { clips: { edges: [], pageInfo: { hasNextPage: false } } } } }));
  });
  await api.broadcasterClips('creator', 'ALL_TIME', new AbortController().signal);
  assert.deepEqual(payload.variables, { login: 'creator', criteria: { period: 'ALL_TIME' } });
  api.fetch = async () => new Response(JSON.stringify({ data: { user: {} } }));
  await assert.rejects(api.broadcasterClips('creator', 'ALL_TIME', new AbortController().signal), /取得形式/);
});
