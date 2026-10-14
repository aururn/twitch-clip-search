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
const profile = mkdtempSync(join(tmpdir(), 'twitch-clip-search-test-'));
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
      const broadcaster = body.query.includes('BroadcasterClips');
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
      if (broadcaster) data = { user: { clips: { edges: [{ node: { ...node, slug: `creator-${body.variables.criteria.period}`, title: '爆笑：カテゴリ上位にはないクリップ' } }], pageInfo: { hasNextPage: false } } } };
      if (body.query.includes('ScoutMetadata')) {
        data = Object.fromEntries(Object.values(body.variables).map((slug, offset) => [`c${offset}`, { ...node, slug, title: /^grandtheftautov-(first|next)$/.test(slug) ? '大爆笑 ＡＰＥＸ 初見の神プレイ' : '公開クリップ' }]));
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
    });
  }
  await page.goto(`chrome-extension://${id}/app.html?panel=1`);
  await page.waitForSelector('html[data-ready="true"]');
  const panel = await worker.evaluate(async () => ({ options: await chrome.sidePanel.getOptions({}), behavior: await chrome.sidePanel.getPanelBehavior() }));
  assert.equal(panel.options.path, 'app.html?panel=1');
  assert.equal(panel.behavior.openPanelOnActionClick, true, '拡張アイコンは新しいページではなくサイドパネルを開く');
  assert.equal(await page.locator('[data-period="ALL_TIME"]').getAttribute('aria-pressed'), 'true', '初期状態で古いクリップを除外しない');
  await page.screenshot({ path: join(artifacts, 'initial-desktop.png'), fullPage: true });
  await page.locator('#query').fill('爆笑');
  await page.locator('#search-form button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('#stop').hidden, null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#stop').hidden, null, { timeout: 120000 });
  const notices = await page.locator('#notice').allTextContents();
  const resultCount = Number((await page.locator('#result-count').textContent()).replace(/[^0-9]/g, ''));
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
      const scope = await store.read('meta', 'ALL_TIME:JA');
      const category = scope.categories.find(item => item.name === 'Grand Theft Auto V');
      const api = new BrowserTwitchAPI();
      const signal = new AbortController().signal;
      let directory;
      try { directory = await api.directory(scope.directoryCursor, signal); }
      catch (error) { directory = { names: [], warning: error.message }; }
      const newCategories = directory.names.filter(item => !scope.categories.some(category => category.slug === item.slug));
      let continuation;
      try {
        const response = await api.clips(category, scope, signal);
        const cached = new Set((await store.read('clips')).map(clip => clip.slug));
        continuation = { count: response.clips.length, newClips: response.clips.filter(clip => !cached.has(clip.slug)).length, cursor: response.cursor };
      } catch (error) { continuation = { restriction: error.message }; }
      return { directoryCount: directory.names.length, newCategories: newCategories.length, directoryWarning: directory.warning ?? null, continuation };
    });
    assert.ok(nextPage.directoryCount > 0 || nextPage.directoryWarning, 'ディレクトリが止まっても完全取得扱いしない');
    assert.ok(nextPage.continuation.restriction || nextPage.continuation.newClips > 0, '続きが制限されても正常な空結果として扱わない');
    console.log(JSON.stringify({ liveNextPage: nextPage }));
  }
  if (!live) {
    assert.equal(resultCount, 3);
    assert.equal(await page.locator('#results mark').count(), 3);
    assert.ok(requests.some(item => item.login === 'tester'), '配信者入力なしでカテゴリ外のクリップも取得する');
    const browsing = await context.newPage();
    await browsing.goto('https://www.twitch.tv/directory');
    const activeBefore = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
    const tabsBefore = await worker.evaluate(async () => (await chrome.tabs.query({})).length);
    await page.locator('#results .clip-link').first().click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('別タブ'));
    const afterClick = await worker.evaluate(async () => ({ active: (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id, count: (await chrome.tabs.query({})).length }));
    assert.equal(afterClick.active, activeBefore, '視聴中のタブのフォーカスを奪わない');
    assert.equal(afterClick.count, tabsBefore + 1, 'バックグラウンドにクリップを一度だけ開く');
    await context.route('https://www.twitch.tv/directory?cleanup=1', route => route.fulfill({ contentType: 'text/html', body: '<html><body>Loading</body></html>' }));
    const scanning = await context.newPage();
    await scanning.goto(`chrome-extension://${id}/app.html?panel=1`);
    await scanning.waitForSelector('html[data-ready="true"]');
    await scanning.evaluate(async () => {
      const { PublicPageReader } = await import('./lib/browser-reader.js');
      void new PublicPageReader().scan('https://www.twitch.tv/directory?cleanup=1', 'directory', 100, 'ALL', new AbortController().signal).catch(() => {});
    });
    await page.waitForFunction(async () => (await chrome.tabs.query({})).some(tab => tab.url?.includes('cleanup=1')));
    await scanning.close();
    await page.waitForFunction(async () => !(await chrome.tabs.query({})).some(tab => tab.url?.includes('cleanup=1')));
    assert.equal(browsing.isClosed(), false, 'パネルを閉じてもユーザーのTwitchタブは閉じない');
    await browsing.close();
    await page.locator('#results .save-button').first().click();
    await page.waitForFunction(() => document.querySelector('#saved-count').textContent === '1');
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    assert.equal(await page.locator('#saved-count').textContent(), '1');
    await page.locator('#collect').click();
    await page.waitForFunction(() => !document.querySelector('#stop').hidden);
    try { await page.waitForFunction(() => document.querySelector('#stop').hidden, null, { timeout: 90000 }); }
    catch (error) { console.log(JSON.stringify({ debug: { detail: await page.locator('#coverage-detail').textContent(), notice: await page.locator('#notice').textContent(), publicPages, requests: requests.length } })); throw error; }
    assert.equal(Number((await page.locator('#result-count').textContent()).replace(/[^0-9]/g, '')), 5, '別の期間も取得してタイトルの取りこぼしを減らす');
    await page.locator('#collect').click();
    await page.waitForFunction(() => !document.querySelector('#stop').hidden);
    await page.waitForFunction(() => document.querySelector('#stop').hidden, null, { timeout: 90000 });
    assert.ok(publicPages.includes('grand-theft-auto-v'), '追加取得で通常のTwitch一覧ページも読む');
    assert.equal(await page.locator('#notice').isVisible(), false, '正常な追加取得にエラーがない');
    assert.ok(requests.some(variables => Object.values(variables).includes('grandtheftautov-next')), '続きにあるクリップの正確な情報を取得する');
    assert.ok(Number((await page.locator('#result-count').textContent()).replace(/[^0-9]/g, '')) > 5);
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
