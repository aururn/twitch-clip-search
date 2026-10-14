import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserTwitchAPI, PublicPageReader } from '../extension/lib/browser-reader.js';

test('追加取得では通常の公開一覧を読み、制限されたAPIカーソルを送らない', async () => {
  const scans = [];
  const reader = { async scan(...args) { scans.push(args); return { items: Array.from({ length: 200 }, (_, index) => ({ slug: index ? `real-${index}` : 'real-clip' })), exhausted: false }; } };
  let rawRequests = 0;
  const api = new BrowserTwitchAPI(async () => { rawRequests++; throw new Error('must not send cursor'); }, reader);
  api.hydrate = async slugs => slugs.map(slug => ({ slug }));
  const signal = new AbortController().signal;
  const page = await api.clips({ name: 'Grand Theft Auto V', slug: 'grand-theft-auto-v', cursor: 'MTAw' }, { period: 'LAST_MONTH', language: 'JA' }, signal);
  assert.equal(rawRequests, 0);
  assert.equal(scans[0][0], 'https://www.twitch.tv/directory/category/grand-theft-auto-v/clips?range=30d');
  assert.equal(scans[0][2], 200);
  assert.equal(scans[0][3], 'JA');
  assert.equal(page.clips[0].slug, 'real-clip');
  assert.equal(page.hasNext, true);
  assert.equal(page.cursor, 'page:200');
});

test('公開一覧の追加読み込みが止まったときは成功した終端として保存しない', async () => {
  const reader = { async scan() { return { items: [{ slug: 'old-clip' }], exhausted: true }; } };
  const api = new BrowserTwitchAPI(async () => { throw new Error('must not request restricted cursor'); }, reader);
  await assert.rejects(api.clips({ name: 'Minecraft', cursor: 'MTAw' }, { period: 'LAST_MONTH', language: 'JA' }, new AbortController().signal), /続きが読み込まれません/);
});

test('ディレクトリの追加取得は公開ページのカテゴリ範囲を広げる', async () => {
  let target;
  const reader = { async scan(url, mode, amount) { target = amount; return { items: Array.from({ length: amount }, (_, index) => ({ name: `Game ${index}`, slug: `game-${index}` })), exhausted: false }; } };
  const api = new BrowserTwitchAPI(async () => { throw new Error('must not request restricted cursor'); }, reader);
  const page = await api.directory('page:100', new AbortController().signal);
  assert.equal(target, 150);
  assert.equal(page.cursor, 'page:150');
  assert.equal(page.hasNext, true);
});

test('確認画面を回避せずエラーを出し、作成したタブだけ閉じる', async () => {
  const closed = [];
  const reader = new PublicPageReader({
    tabs: { async create() { return { id: 7 }; }, async update() {}, async remove(id) { closed.push(id); } },
    scripting: { async executeScript() { return [{ result: { blocked: true, message: '確認画面' } }]; } },
  });
  await assert.rejects(reader.scan('https://www.twitch.tv/directory', 'directory', 50, 'ALL', new AbortController().signal), /確認画面/);
  assert.deepEqual(closed, [7]);
});

test('停止済みの公開ページ読み取りはタブを開かない', async () => {
  let created = false;
  const reader = new PublicPageReader({ tabs: { async create() { created = true; } } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(reader.scan('https://www.twitch.tv/directory', 'directory', 50, 'ALL', controller.signal), { name: 'AbortError' });
  assert.equal(created, false);
});
