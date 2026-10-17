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
  channel: 'chromium', headless: true, viewport: { width: 390, height: 844 },
  args: [`--disable-extensions-except=${resolve(root, 'extension')}`, `--load-extension=${resolve(root, 'extension')}`],
});
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20000 });
  const id = new URL(worker.url()).hostname;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const requests = [];
  const metadataRequests = [];
  if (!live) {
    await context.route('https://www.twitch.tv/**', route => route.fulfill({ contentType: 'text/html', body: '<html><body>Twitch test page</body></html>' }));
    await context.route('https://clips.twitch.tv/**', route => route.fulfill({ contentType: 'text/html', body: '<html><body>Clip</body></html>' }));
    await context.route('https://www.twitch-clips-storage.com/api/twitch-clips/clips.php?**', async route => {
      const url = new URL(route.request().url());
      requests.push(Object.fromEntries(url.searchParams));
      if (url.searchParams.get('search') === 'slow') await new Promise(resolve => setTimeout(resolve, 1500));
      if (url.searchParams.get('search') === 'failme') return route.fulfill({ status: 503, body: 'Unavailable' });
      const records = url.searchParams.get('page_number') === '1' ? [
        { id: 'FixtureMondoRanked', title: 'ファン太、mondo高速ヘリ撃破' },
        { id: 'FixtureCasterOnly', title: '空き巣k4sen', login: 'mondo2244' },
        { id: 'FixtureRemoved', title: 'mondo 削除済み' },
        { id: 'FixtureRenamed', title: 'mondo 古いタイトル' },
        ...Array.from({ length: 196 }, (_, index) => ({ id: `unrelated-${index}`, title: '無関係なタイトル' })),
      ] : [{ id: 'FixtureMondoBeyond200', title: 'Mondoと遊ぶ' }];
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ records, totalRecords: 201 }) });
    });
    await context.route('https://gql.twitch.tv/gql', async route => {
      const body = route.request().postDataJSON();
      if (!body?.query || !body.variables) return route.fulfill({ contentType: 'application/json', body: '{}' });
      metadataRequests.push(...Object.values(body.variables));
      const data = Object.fromEntries(Object.values(body.variables).map((slug, offset) => [`c${offset}`, slug === 'FixtureRemoved' ? null : {
        slug, title: slug === 'FixtureRenamed' ? '変更後のタイトル' : slug === 'FixtureMondoRanked' ? 'ファン太、mondo高速ヘリ撃破' : 'Mondoと遊ぶ',
        viewCount: 144409, createdAt: '2023-12-15T17:37:58Z', durationSeconds: 30,
        language: slug === 'FixtureMondoBeyond200' ? 'KO' : 'JA', thumbnailURL: '',
        broadcaster: { login: 'tester', displayName: '配信者テスト' }, game: { name: 'Test Game', displayName: 'Test Game' },
      }]));
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
    });
  }
  await page.goto(`chrome-extension://${id}/app.html?panel=1`);
  await page.waitForSelector('html[data-ready="true"]');
  assert.equal(await page.locator('#language').inputValue(), 'ALL', '初期の日本語フィルターで他言語のタイトル一致を落とさない');
  const panel = await worker.evaluate(async () => ({ options: await chrome.sidePanel.getOptions({}), behavior: await chrome.sidePanel.getPanelBehavior() }));
  assert.equal(panel.options.path, 'app.html?panel=1');
  assert.equal(panel.behavior.openPanelOnActionClick, true);
  await page.locator('#query').fill('mondo');
  await page.locator('#search-form button').click();
  await page.waitForFunction(() => !document.querySelector('#stop').hidden);
  await page.waitForFunction(() => document.querySelector('#stop').hidden, null, { timeout: 65000 });
  const count = () => page.locator('#result-count').textContent().then(value => Number(value.replace(/[^0-9]/g, '')));
  const resultCount = await count();
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(await page.locator('#notice').isVisible(), false, await page.locator('#notice').textContent());
  if (live) {
    assert.ok(resultCount > 10, '実際のmondoタイトルを複数の配信者から取得する');
    assert.ok(await page.locator('a[href="https://clips.twitch.tv/CharmingDarkKangarooWutFace-jXutwg_Zmf0rl3Un"]').count());
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#results img')).slice(0,4).every(img => img.naturalWidth > 0), null, { timeout: 15000 });
    await page.evaluate(async () => Promise.all(Array.from(document.querySelectorAll('#results img')).slice(0,4).map(img => img.decode())));
  } else {
    assert.equal(resultCount, 2, '配信者名のみの一致・削除済み・改題済みを数えない');
    assert.ok(requests.some(item => item.page_number === '2'), '最初の200件より先も自動で検索する');
    assert.equal(metadataRequests.includes('FixtureCasterOnly'), false);
    await page.locator('#results .save-button').first().click();
    await page.waitForFunction(() => document.querySelector('#saved-count').textContent === '1');
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    assert.equal(await count(), 2);
    assert.equal(await page.locator('#saved-count').textContent(), '1');
    const browsing = await context.newPage();
    await browsing.goto('https://www.twitch.tv/directory');
    const before = await worker.evaluate(async () => ({ active: (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id, total: (await chrome.tabs.query({})).length }));
    await page.locator('#results .clip-link').first().click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('別タブ'));
    const after = await worker.evaluate(async () => ({ active: (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id, total: (await chrome.tabs.query({})).length }));
    assert.equal(after.active, before.active);
    assert.equal(after.total, before.total + 1);
    await browsing.close();
    const download = page.waitForEvent('download');
    await page.locator('#export').click();
    assert.ok((await download).suggestedFilename().startsWith('twitch-clip-search-'));
    await page.locator('#query').fill('slow');
    await page.locator('#search-form button').click();
    await page.waitForFunction(() => !document.querySelector('#stop').hidden);
    await page.locator('#stop').click();
    await page.waitForFunction(() => document.querySelector('#stop').hidden);
    assert.equal(await page.locator('#saved-count').textContent(), '1');
    await page.locator('#query').fill('failme');
    await page.locator('#search-form button').click();
    await page.waitForFunction(() => !document.querySelector('#notice').hidden);
    assert.match(await page.locator('#notice').textContent(), /503/);
    await page.waitForFunction(() => document.querySelector('#stop').hidden);
    await page.locator('#query').fill('slow');
    await page.locator('#search-form button').click();
    await page.waitForFunction(() => !document.querySelector('#stop').hidden);
    await page.locator('#query').fill('mondo');
    await page.locator('#search-form button').click();
    await page.waitForFunction(() => document.querySelector('#stop').hidden && document.querySelector('#result-count').textContent === '2件');
    await page.locator('#about-open').click();
    await page.locator('#clear-cache').click();
    await page.waitForFunction(() => document.querySelector('#cache-total').textContent === '0');
    assert.equal(await page.locator('#saved-count').textContent(), '1');
    await page.locator('#about-close').click();
    await page.locator('#saved-tab').click();
    assert.equal(await page.locator('#results .clip-card').count(), 1);
  }
  for (const width of [320,360,390,480,640]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Overflow at ${width}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0,0));
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await page.screenshot({ path: join(artifacts, live ? 'preview-keyword-search.png' : 'fixture-keyword-search.png') });
  console.log(JSON.stringify({ mode: live ? 'live' : 'fixture', query: 'mondo', titleMatches: resultCount, errors, profile }));
} finally { await context.close(); }
