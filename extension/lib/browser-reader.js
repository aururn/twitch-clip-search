import { TwitchAPI, pause, abortError } from './api.js';
import { categorySlug } from './core.js';

// This runs in an isolated world on a normal, public Twitch page. It reads
// rendered links and uses the site's language control and ordinary scrolling.
// It does not inspect cookies, app state, request headers, or integrity tokens.
export function readPublicPage(mode, action = 'read', language = 'ALL') {
  if (!document.body) return { ready: false, items: [] };
  const bodyText = document.body.innerText;
  if (/verify you are human|unusual traffic|確認してください.*ロボット/i.test(bodyText) || document.querySelector('iframe[src*="captcha"]')) {
    return { blocked: true, message: 'Twitchの確認画面が表示されました。通常のTwitchページで確認してから再度お試しください。' };
  }
  if (action === 'language-open') {
    const button = [...document.querySelectorAll('button')].find(node => /^(言語|Language|Languages)$/.test(node.textContent.trim()));
    if (!button) return { ready: false };
    button.click();
    return { ready: true };
  }
  if (action === 'language-select') {
    const options = { JA: ['日本語', 'Japanese'], EN: ['English', '英語'], KO: ['한국어', 'Korean', '韓国語'] };
    const labels = [...document.querySelectorAll('label[for]')].filter(label => document.getElementById(label.htmlFor)?.type === 'checkbox');
    const selected = language === 'ALL' ? null : labels.find(label => options[language]?.includes(label.textContent.trim()));
    if (!labels.length || (language !== 'ALL' && !selected)) return { ready: false };
    for (const label of labels) {
      const input = document.getElementById(label.htmlFor);
      if (input.checked !== (label === selected)) label.click();
    }
    const button = [...document.querySelectorAll('button')].find(node => /^(言語|Language|Languages)$/.test(node.textContent.trim()));
    button?.click();
    return { ready: true };
  }
  const items = [];
  if (mode === 'directory') {
    for (const heading of document.querySelectorAll('a[href^="/directory/category/"] h2[title]')) {
      const anchor = heading.closest('a');
      const slug = anchor.getAttribute('href').match(/^\/directory\/category\/([^/?#]+)/)?.[1];
      if (slug) items.push({ slug: decodeURIComponent(slug), name: heading.getAttribute('title') });
    }
  } else {
    for (const anchor of document.querySelectorAll('a[href*="/clip/"]')) {
      const slug = anchor.getAttribute('href').match(/\/clip\/([A-Za-z0-9_-]+)(?:[/?#]|$)/)?.[1];
      if (slug && (anchor.querySelector('h4') || anchor.querySelector('img'))) items.push({ slug });
    }
  }
  const scroller = document.querySelector('[data-a-target="root-scroller"]') ?? document.scrollingElement;
  const before = scroller?.scrollTop ?? 0;
  if (action === 'scroll' && scroller) scroller.scrollTop = scroller.scrollHeight;
  return { ready: items.length > 0, items, height: scroller?.scrollHeight ?? 0, top: before, empty: /クリップがありません|No clips found|No clips available/i.test(bodyText) };
}

export class PublicPageReader {
  constructor(chromeAPI = globalThis.chrome) { this.chrome = chromeAPI; }

  async scan(url, mode, target, language, signal) {
    if (signal.aborted) throw abortError();
    const tab = await this.chrome.tabs.create({ url: 'about:blank', active: false });
    const items = new Map();
    const run = async action => {
      if (signal.aborted) throw abortError();
      const result = await this.chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPublicPage, args: [mode, action, language] });
      const data = result[0]?.result;
      if (data?.blocked) throw new Error(data.message);
      return data;
    };
    try {
      await pause(100, signal);
      await this.chrome.tabs.update(tab.id, { url, muted: true });
      let ready = false;
      for (let tries = 0; tries < 40; tries++) {
        try { const snapshot = await run('read'); ready = snapshot?.ready || snapshot?.empty; }
        catch (error) { if (signal.aborted || /確認画面/.test(error.message)) throw error; }
        if (ready) break;
        await pause(500, signal);
      }
      if (!ready) throw new Error('Twitchの公開一覧を読み込めませんでした。Twitchで一覧が開けるか確認してください。');
      if (mode === 'clips') {
        if (!(await run('language-open'))?.ready) throw new Error('Twitchの言語フィルターを確認できませんでした。');
        await pause(200, signal);
        if (!(await run('language-select'))?.ready) throw new Error('Twitchの言語フィルターを設定できませんでした。');
        await pause(1200, signal);
      }
      let unchanged = 0;
      let previousSize = -1;
      let previousHeight = -1;
      let exhausted = false;
      for (let step = 0; step < Math.min(80, Math.ceil(target / 10) + 15); step++) {
        const snapshot = await run('scroll');
        for (const item of snapshot?.items ?? []) items.set(item.slug, item);
        if (items.size >= target) break;
        if (items.size === previousSize && snapshot?.height === previousHeight) unchanged++;
        else unchanged = 0;
        previousSize = items.size;
        previousHeight = snapshot?.height;
        if (unchanged >= 5 || snapshot?.empty) { exhausted = true; break; }
        await pause(700, signal);
      }
      return { items: [...items.values()].slice(0, target), exhausted };
    } finally {
      // Close only the tab created by this scan, including on cancellation.
      try { await this.chrome.tabs.remove(tab.id); } catch { /* Already closed by the user. */ }
    }
  }
}

export class BrowserTwitchAPI extends TwitchAPI {
  constructor(fetchImpl, reader = new PublicPageReader()) { super(fetchImpl); this.reader = reader; }

  async directory(cursor, signal) {
    if (!cursor) return super.directory(cursor, signal);
    const previous = cursor.startsWith('page:') ? Number(cursor.slice(5)) : 50;
    const target = previous + 50;
    const data = await this.reader.scan('https://www.twitch.tv/directory', 'directory', target, 'ALL', signal);
    if (!data.items.length) throw new Error('Twitchのカテゴリ一覧を読み込めませんでした。取得済みの結果は検索できます。');
    return {
      names: data.items, cursor: `page:${data.items.length}`, hasNext: !data.exhausted && data.items.length >= target,
      warning: data.items.length < previous ? 'Twitchの一覧の追加読み込みが止まりました。表示できたカテゴリを追加し、取得済みの結果は保持しています。' : '',
    };
  }

  async clips(category, scope, signal) {
    // Cursor pagination on the unauthenticated metadata API is restricted.
    // Continue via the normal public website, letting its own client load cards.
    if (!category.cursor) return super.clips(category, scope, signal);
    const previous = category.cursor.startsWith('page:') ? Number(category.cursor.slice(5)) : 100;
    const target = previous + 100;
    const ranges = { LAST_DAY: '24hr', LAST_WEEK: '7d', LAST_MONTH: '30d', ALL_TIME: 'all' };
    const slug = category.slug ?? categorySlug(category.name);
    const url = `https://www.twitch.tv/directory/category/${encodeURIComponent(slug)}/clips?range=${ranges[scope.period]}`;
    const data = await this.reader.scan(url, 'clips', target, scope.language, signal);
    if (data.items.length < previous) throw new Error('Twitchの公開一覧で続きが読み込まれませんでした。取得済みの結果は残ります。通常のTwitchページで一覧を確認してください。');
    const clips = await this.hydrate(data.items.map(item => item.slug), signal);
    return { clips, cursor: `page:${data.items.length}`, hasNext: !data.exhausted && data.items.length >= target };
  }
}
