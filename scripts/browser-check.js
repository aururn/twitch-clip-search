import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtimeRoot = process.env.SCOUT_NODE_PACKAGES;
const require = createRequire(runtimeRoot ? join(runtimeRoot, '../package.json') : import.meta.url);
const { chromium } = require('playwright');
const live = process.argv.includes('--live');
const profile = mkdtempSync(join(tmpdir(), 'clip-scout-test-'));
const artifacts = join(root, 'artifacts');
mkdirSync(artifacts, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1440, height: 1080 },
  args: [`--disable-extensions-except=${resolve(root, 'extension')}`, `--load-extension=${resolve(root, 'extension')}`],
});
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20000 });
  const id = new URL(worker.url()).hostname;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const requests = [];
  const publicPages = [];
  let fixtureSlow = false;
  if (!live) {
    await context.route('https://www.twitch.tv/directory', route => route.fulfill({ body: '<html></html>' }));
    await context.route(url => url.hostname === 'www.twitch.tv' && /^\/directory\/category\/[^/]+\/clips$/.test(url.pathname), route => {
      const category = new URL(route.request().url()).pathname.split('/')[3];
      publicPages.push(category);
      const name = category.replace(/[^a-z0-9]/gi, '');
      const links = Array.from({ length: 200 }, (_, index) => index === 0 ? 'first' : index === 1 ? 'next' : `other${index}`).map(cursor => `<a href="/tester/clip/${name}-${cursor}"><h4>Fixture clip</h4></a>`).join('');
      route.fulfill({ contentType: 'text/html;charset=utf-8', body: `<html lang="ja"><head><meta charset="utf-8"></head><body><button>言語</button><input type="checkbox" id="ja"><label for="ja">日本語</label><div data-a-target="root-scroller">${links}</div></body></html>` });
    });
    await context.route('https://gql.twitch.tv/gql', async route => {
      const body = route.request().postDataJSON();
      if (!body?.query) return route.fulfill({ contentType: 'application/json', body: '{}' });
      requests.push(body.variables);
      const directory = body.query.includes('ScoutDirectory');
      if (fixtureSlow && !directory) await new Promise(resolve => setTimeout(resolve, 1000));
      const name = body.variables.name ?? 'directory';
      const cursor = body.variables.after;
      const node = {
        slug: `${name.replace(/[^a-z0-9]/gi, '') || 'game'}-${cursor || 'first'}`,
        title: ['Grand Theft Auto V', 'grand-theft-auto-v'].includes(name) ? '大爆笑 ＡＰＥＸ 初見の神プレイ' : `公開クリップ ${name}`,
        viewCount: ['Grand Theft Auto V', 'grand-theft-auto-v'].includes(name) ? 12050 : 980,
        createdAt: new Date().toISOString(), durationSeconds: 27.8, language: 'JA',
        thumbnailURL: '', broadcaster: { login: 'tester', displayName: '配信者テスト' },
        game: { name, displayName: name },
      };
      let data = directory ? { games: { edges: [{ cursor: 'directory-next', node: { name: 'Test Category' } }], pageInfo: { hasNextPage: false } } }
        : { game: { clips: { edges: [{ cursor: cursor ? null : 'next', node }], pageInfo: { hasNextPage: !cursor } } } };
      if (body.query.includes('ScoutMetadata')) {
        data = Object.fromEntries(Object.values(body.variables).map((slug, offset) => [`c${offset}`, { ...node, slug, title: /^grandtheftautov-(first|next)$/.test(slug) ? '大爆笑 ＡＰＥＸ 初見の神プレイ' : '公開クリップ' }]));
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
    });
  }
  await page.goto(`chrome-extension://${id}/app.html`);
  await page.waitForSelector('html[data-ready="true"]');
  await worker.evaluate(() => openScout());
  assert.equal(context.pages().filter(tab => tab.url() === `chrome-extension://${id}/app.html`).length, 1, 'ツールバー起動は既存の検索タブを再利用する');
  await page.screenshot({ path: join(artifacts, 'initial-desktop.png'), fullPage: true });
  await page.locator('#query').fill('爆笑');
  await page.locator('#search-form button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('#stop').hidden, null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#stop').hidden, null, { timeout: 120000 });
  const notices = await page.locator('#notice').allTextContents();
  const resultCount = Number((await page.locator('#result-count').textContent()).replaceAll(',', ''));
  await page.locator('#toast').waitFor({ state: 'hidden' });
  if (live) await page.screenshot({ path: join(artifacts, 'preview.png') });
  await page.screenshot({ path: join(artifacts, `${live ? 'live' : 'fixture'}-results-desktop.png`), fullPage: true });
  console.log(JSON.stringify({ mode: live ? 'live' : 'fixture', resultCount, cacheTotal: await page.locator('#cache-total').textContent(), notices, errors }));
  assert.equal(errors.length, 0);
  if (live) {
    assert.ok(resultCount > 0, '実データでタイトル検索が成功する');
    assert.equal(await page.locator('#notice').isVisible(), false, '実データの収集にエラーがない');
    const nextPage = await page.evaluate(async () => {
      const { BrowserTwitchAPI } = await import('./lib/browser-reader.js');
      const { openStore } = await import('./lib/store.js');
      const store = await openStore();
      const scope = await store.read('meta', 'LAST_MONTH:JA');
      const category = scope.categories.find(item => item.name === 'Grand Theft Auto V');
      const api = new BrowserTwitchAPI();
      const signal = new AbortController().signal;
      const directory = await api.directory(scope.directoryCursor, signal);
      const newCategories = directory.names.filter(item => !scope.categories.some(category => category.slug === item.slug));
      let continuation;
      try {
        const response = await api.clips(category, scope, signal);
        const cached = new Set((await store.read('clips')).map(clip => clip.slug));
        continuation = { count: response.clips.length, newClips: response.clips.filter(clip => !cached.has(clip.slug)).length, cursor: response.cursor };
      } catch (error) { continuation = { restriction: error.message }; }
      return { directoryCount: directory.names.length, newCategories: newCategories.length, directoryWarning: directory.warning ?? null, continuation };
    });
    assert.ok(nextPage.directoryCount > 0, '通常のディレクトリを読める');
    assert.ok(nextPage.newCategories > 0, '新しいカテゴリへ検索範囲を広げられる');
    assert.ok(nextPage.continuation.restriction || nextPage.continuation.newClips > 0, '続きが制限されても正常な空結果として扱わない');
    console.log(JSON.stringify({ liveNextPage: nextPage }));
  }
  if (!live) {
    assert.equal(resultCount, 1);
    assert.equal(await page.locator('#results mark').count(), 1);
    await page.locator('#results .save-button').first().click();
    await page.waitForFunction(() => document.querySelector('#saved-count').textContent === '1');
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    assert.equal(await page.locator('#saved-count').textContent(), '1');
    await page.locator('#collect').click();
    await page.waitForFunction(() => !document.querySelector('#stop').hidden);
    try { await page.waitForFunction(() => document.querySelector('#stop').hidden, null, { timeout: 90000 }); }
    catch (error) { console.log(JSON.stringify({ debug: { detail: await page.locator('#coverage-detail').textContent(), notice: await page.locator('#notice').textContent(), publicPages, requests: requests.length } })); throw error; }
    assert.ok(publicPages.includes('grand-theft-auto-v'), '追加取得で通常のTwitch一覧ページを読む');
    assert.equal(await page.locator('#notice').isVisible(), false, '正常な追加取得にエラーがない');
    assert.ok(requests.some(variables => Object.values(variables).includes('grandtheftautov-next')), '続きにあるクリップの正確な情報を取得する');
    assert.equal(Number(await page.locator('#result-count').textContent()), 2);
    const download = page.waitForEvent('download');
    await page.locator('#export').click();
    assert.ok((await download).suggestedFilename().endsWith('.csv'));
    await page.locator('#saved-tab').click();
    assert.equal(await page.locator('#results .clip-card').count(), 1);
    await page.locator('#about-open').click();
    await page.locator('#clear-cache').click();
    await page.waitForFunction(() => document.querySelector('#cache-total').textContent === '0');
    assert.equal(await page.locator('#saved-count').textContent(), '1');
    await page.locator('#about-close').click();
    await page.locator('#explore-tab').click();
    fixtureSlow = true;
    await page.locator('#collect').click();
    await page.waitForFunction(() => Number(document.querySelector('#cache-total').textContent.replaceAll(',', '')) >= 2);
    await page.locator('#stop').click();
    await page.waitForFunction(() => document.querySelector('#stop').hidden);
    assert.ok(Number(await page.locator('#cache-total').textContent()) < 13, '停止で取得を中断する');
    assert.equal(await page.locator('#saved-count').textContent(), '1', '停止で保存クリップを消さない');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(artifacts, `${live ? 'live' : 'fixture'}-mobile.png`), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'モバイルで横にはみ出さない');
  console.log('Browser checks passed. Temporary test profile: ' + profile);
} finally { await context.close(); }
