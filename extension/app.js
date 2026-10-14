import { PERIODS, filterClips, parseQuery, highlightParts, freshScope, formatViews, webSearchURL } from './lib/core.js';
import { BrowserTwitchAPI } from './lib/browser-reader.js';
import { openStore } from './lib/store.js';
import { collectRound } from './lib/collector.js';

const $ = id => document.getElementById(id);
const isPanel = new URLSearchParams(location.search).get('panel') === '1';
if (isPanel) document.documentElement.dataset.panel = 'true';
const state = {
  clips: new Map(), favorites: new Map(), view: 'explore', hasSearched: false,
  options: { query: '', period: 'ALL_TIME', language: 'JA', sort: 'views', category: '' },
  scope: null, store: null, busy: false, controller: null, visible: 60, results: [],
};
const api = new BrowserTwitchAPI();
let toastTimer;

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.append(use);
  return svg;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2500);
}

function showError(error) {
  console.error(error);
  $('notice').textContent = error.message ?? String(error);
  $('notice').hidden = false;
}

function handle(task) { return (...args) => Promise.resolve().then(() => task(...args)).catch(showError); }

async function savePreferences() {
  if (state.store) await state.store.putMeta({ key: 'preferences', version: 2, options: state.options });
}

async function loadScope() {
  const { period, language } = state.options;
  state.scope = await state.store.read('meta', `${period}:${language}`) ?? freshScope(period, language);
  // Ranking-based cursors go stale. Restart discovery after a day, keeping cached clips.
  if (state.scope.updatedAt && Date.now() - state.scope.updatedAt > 86400000) state.scope = freshScope(period, language);
}

function updateFilters() {
  document.querySelectorAll('[data-period]').forEach(button => {
    const selected = button.dataset.period === state.options.period;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  $('language').value = state.options.language;
  $('sort').value = state.options.sort;
}

function updateCategoryOptions() {
  const available = filterClips([...state.clips.values(), ...state.favorites.values()], { ...state.options, query: '', category: '' });
  const categories = [...new Set(available.map(clip => clip.category))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ja'));
  const selected = state.options.category;
  $('category').replaceChildren(new Option('すべてのカテゴリ', ''), ...categories.map(name => new Option(name, name)));
  if (selected && categories.includes(selected)) $('category').value = selected;
  else state.options.category = '';
}

function updateCoverage() {
  $('cache-total').textContent = state.clips.size.toLocaleString('ja-JP');
  $('saved-count').textContent = state.favorites.size.toLocaleString('ja-JP');
}

function setBusy(busy) {
  state.busy = busy;
  $('collect').hidden = busy;
  $('stop').hidden = !busy;
  $('progress-track').hidden = !busy;
  $('cache-summary').hidden = busy;
  $('coverage-title').hidden = !busy;
  $('coverage-detail').hidden = !busy;
  $('progress-bar').style.width = '0%';
  $('language').disabled = busy;
  $('category').disabled = busy;
  $('refresh-scope').disabled = busy;
  $('clear-cache').disabled = busy;
  document.querySelectorAll('[data-period]').forEach(button => { button.disabled = busy; });
  $('results').setAttribute('aria-busy', String(busy));
}

function createCard(clip, tokens) {
  const article = element('article', 'clip-card');
  const link = element('a', 'clip-link');
  link.href = clip.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', `${clip.title} — ${clip.broadcaster}のクリップをTwitchで開く`);
  if (isPanel) link.addEventListener('click', event => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    handle(async () => {
      await chrome.tabs.create({ url: clip.url, active: false });
      toast('クリップを別タブに開きました');
    })();
  });
  const thumbnail = element('div', 'clip-image');
  const fallback = element('div', 'thumb-fallback', 'TWITCH CLIP');
  thumbnail.append(fallback);
  if (clip.image) {
    fallback.hidden = true;
    const img = element('img');
    img.src = clip.image;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => { img.remove(); fallback.hidden = false; });
    thumbnail.append(img);
  }
  const seconds = Math.round(clip.duration);
  const duration = seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '';
  if (duration) thumbnail.append(element('span', 'clip-duration', duration));
  const play = element('div', 'play-overlay');
  const playCircle = element('span');
  playCircle.append(icon('play'));
  play.append(playCircle);
  thumbnail.append(play);
  const content = element('div', 'clip-content');
  const title = element('h3');
  title.title = clip.title;
  for (const part of highlightParts(clip.title, tokens)) title.append(part.hit ? element('mark', '', part.text) : document.createTextNode(part.text));
  const category = element('div', 'clip-category', clip.category);
  category.title = clip.category;
  content.append(title);
  link.append(thumbnail, content);
  const footer = element('div', 'clip-footer');
  const name = element('span', 'broadcaster', clip.broadcaster);
  name.title = clip.broadcaster;
  const save = element('button', 'save-button');
  save.append(icon('bookmark'));
  const updateSave = () => {
    const saved = state.favorites.has(clip.slug);
    save.classList.toggle('saved', saved);
    save.title = saved ? '保存を解除' : 'クリップを保存';
    save.setAttribute('aria-label', `${clip.title}：${save.title}`);
    save.setAttribute('aria-pressed', String(saved));
  };
  updateSave();
  save.addEventListener('click', handle(async () => {
    const enabled = !state.favorites.has(clip.slug);
    await state.store.favorite(clip, enabled);
    if (enabled) state.favorites.set(clip.slug, clip);
    else state.favorites.delete(clip.slug);
    updateSave();
    updateCoverage();
    toast(enabled ? 'クリップを保存しました' : '保存を解除しました');
    if (state.view === 'saved') render();
  }));
  footer.append(name, category, save);
  const metadata = element('div', 'clip-meta');
  const views = element('span', 'clip-views');
  views.textContent = `${formatViews(clip.views)} 回視聴`;
  const date = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', year: 'numeric' }).format(new Date(clip.createdAt));
  metadata.append(views, element('span', '', date));
  article.append(link, footer, metadata);
  return article;
}

function render() {
  updateCoverage();
  const saved = state.view === 'saved';
  $('explore-tab').classList.toggle('active', !saved);
  $('saved-tab').classList.toggle('active', saved);
  $('explore-tab').setAttribute('aria-pressed', String(!saved));
  $('saved-tab').setAttribute('aria-pressed', String(saved));
  state.results = filterClips([...(saved ? state.favorites : state.clips).values()], state.options);
  $('result-count').textContent = `${state.results.length.toLocaleString('ja-JP')}件`;
  $('result-count').title = '取得済みのクリップ内で一致した件数。Twitch全体の総件数ではありません。';
  $('results-title').textContent = saved ? '保存したクリップ' : state.options.query ? `「${state.options.query}」の検索結果` : state.hasSearched ? '公開クリップ' : 'クリップを探す';
  $('export').disabled = state.results.length === 0;
  const tokens = parseQuery(state.options.query);
  $('results').replaceChildren(...state.results.slice(0, state.visible).map(clip => createCard(clip, tokens)));
  $('empty-state').hidden = state.results.length > 0;
  $('show-more').hidden = state.results.length <= state.visible;
  $('shown-count').textContent = state.results.length ? `${Math.min(state.visible, state.results.length).toLocaleString('ja-JP')} / ${state.results.length.toLocaleString('ja-JP')} 件を表示` : '';
  const initial = !state.hasSearched && !saved;
  $('empty-title').textContent = state.busy ? '取得中…' : initial ? 'キーワードを入力してください。' : saved ? '保存したクリップがありません。' : '取得済みのクリップには一致がありません。';
  $('empty-text').textContent = state.busy || initial ? '' : '検索条件を変更するか、クリップを追加取得してください。';
  $('empty-text').hidden = state.busy || initial;
  $('empty-text').style.whiteSpace = 'pre-line';
  $('browse').hidden = state.busy || !initial;
  $('web-search').hidden = saved || state.busy || !state.options.query;
  $('web-search').href = webSearchURL(state.options.query);
}

async function collect(refresh = false, rounds = 2) {
  if (state.busy || !state.store) return;
  state.hasSearched = true;
  $('notice').hidden = true;
  const callback = async lock => {
    if (!lock) { toast('別のTwitchクリップ検索タブで取得中です'); return; }
    // Reload the cursor after obtaining the lock, to avoid duplicate scans across tabs.
    await loadScope();
    if (refresh) state.scope = freshScope(state.options.period, state.options.language);
    state.controller = new AbortController();
    const signal = state.controller.signal;
    setBusy(true);
    render();
    let lastRender = 0;
    try {
      $('coverage-title').textContent = '公開クリップを取得しています';
      $('coverage-detail').textContent = 'Twitchに接続しています…';
      await api.initialize(signal);
      const errors = [];
      let remaining = true;
      const initialCount = state.clips.size;
      for (let round = 0; round < rounds && remaining; round++) {
        const result = await collectRound({
          api, store: state.store, scope: state.scope, signal,
          knownClips: state.clips.values(), query: state.options.query,
          onPage(clips) {
            clips.forEach(clip => state.clips.set(clip.slug, clip));
            if (Date.now() - lastRender > 600) { render(); lastRender = Date.now(); }
          },
          onProgress(progress) {
            $('coverage-title').textContent = `取得中 · ${state.clips.size.toLocaleString('ja-JP')}件`;
            $('coverage-detail').textContent = `${progress.stage}${progress.errors ? ` · ${progress.errors}件の取得エラー` : ''}`;
            $('progress-bar').style.width = `${progress.total ? progress.completed / progress.total * 100 : 0}%`;
          },
        });
        errors.push(...result.errors);
        remaining = result.remaining;
        if (result.completed === 0 || result.errors.length >= 4) break;
      }
      if (errors.length) {
        const first = errors[0];
        $('notice').textContent = `一部を取得できませんでした。取得済みの結果は検索できます。${first.source}: ${first.message}`;
        $('notice').hidden = false;
      }
      toast(`${(state.clips.size - initialCount).toLocaleString('ja-JP')}件を追加しました${remaining ? '。さらに取得できます' : ''}`);
    } catch (error) {
      if (error.name === 'AbortError' || signal.aborted) toast('取得を停止しました。取得済みの結果は残ります');
      else showError(error);
    } finally {
      setBusy(false);
      state.controller = null;
      updateCategoryOptions();
      render();
    }
  };
  await navigator.locks.request('clip-scout-collection', { ifAvailable: true }, callback);
}

async function search() {
  state.options.query = $('query').value.trim();
  state.view = 'explore';
  state.visible = 60;
  state.hasSearched = true;
  await savePreferences();
  render();
  if (!state.busy) await collect();
}

async function changeScope() {
  state.visible = 60;
  state.options.category = '';
  await loadScope();
  updateFilters();
  updateCategoryOptions();
  await savePreferences();
  render();
  if (state.hasSearched && state.view === 'explore' && !state.scope.updatedAt) await collect();
}

function csvEscape(value) { return `"${String(value ?? '').replaceAll('"', '""')}"`; }
function exportCSV() {
  // Prefix formula-like values for spreadsheet safety.
  const text = value => csvEscape(/^[\s]*[=+@-]/.test(String(value)) ? `'${value}` : value);
  const lines = [['タイトル', '配信者', 'カテゴリ', '視聴回数', '作成日時', 'URL'].map(csvEscape).join(',')];
  for (const clip of state.results) lines.push([clip.title, clip.broadcaster, clip.category, clip.views, clip.createdAt, clip.url].map(text).join(','));
  const url = URL.createObjectURL(new Blob(['\uFEFF', lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const link = element('a');
  link.href = url;
  link.download = `twitch-clip-search-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function initialize() {
  state.store = await openStore();
  const [clips, favorites, preferences] = await Promise.all([
    state.store.read('clips'), state.store.read('favorites'), state.store.read('meta', 'preferences'),
  ]);
  clips.forEach(clip => state.clips.set(clip.slug, clip));
  favorites.forEach(clip => state.favorites.set(clip.slug, clip));
  const options = preferences?.options;
  if (options) {
    if (preferences.version === 2 && Object.hasOwn(PERIODS, options.period)) state.options.period = options.period;
    if (['JA', 'ALL', 'EN', 'KO'].includes(options.language)) state.options.language = options.language;
    if (['views', 'newest', 'oldest'].includes(options.sort)) state.options.sort = options.sort;
    if (typeof options.query === 'string') state.options.query = options.query.slice(0, 300);
  }
  $('query').value = state.options.query;
  state.hasSearched = clips.length > 0;
  await loadScope();
  updateFilters();
  updateCategoryOptions();
  render();
  await savePreferences();

  $('search-form').addEventListener('submit', event => { event.preventDefault(); handle(search)(); });
  $('collect').addEventListener('click', handle(() => collect()));
  $('stop').addEventListener('click', () => state.controller?.abort());
  $('browse').addEventListener('click', handle(async () => { $('query').value = ''; await search(); }));
  document.querySelectorAll('[data-period]').forEach(button => button.addEventListener('click', handle(async () => {
    if (state.busy || state.options.period === button.dataset.period) return;
    state.options.period = button.dataset.period;
    await changeScope();
  })));
  $('language').addEventListener('change', handle(async () => { state.options.language = $('language').value; await changeScope(); }));
  $('category').addEventListener('change', () => { state.options.category = $('category').value; state.visible = 60; render(); });
  $('sort').addEventListener('change', handle(async () => { state.options.sort = $('sort').value; render(); await savePreferences(); }));
  $('explore-tab').addEventListener('click', () => { state.view = 'explore'; state.visible = 60; render(); });
  $('saved-tab').addEventListener('click', () => { state.view = 'saved'; state.visible = 60; render(); });
  $('show-more').addEventListener('click', () => { state.visible += 60; render(); });
  $('export').addEventListener('click', exportCSV);
  $('about-open').addEventListener('click', () => $('about-dialog').showModal());
  $('about-close').addEventListener('click', () => $('about-dialog').close());
  $('about-dialog').addEventListener('click', event => {
    const bounds = $('about-dialog').getBoundingClientRect();
    if (event.target === $('about-dialog') && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) $('about-dialog').close();
  });
  $('refresh-scope').addEventListener('click', handle(async () => { $('about-dialog').close(); await collect(true); }));
  $('clear-cache').addEventListener('click', handle(async () => {
    await state.store.clearCache();
    state.clips.clear();
    state.scope = freshScope(state.options.period, state.options.language);
    state.hasSearched = false;
    await savePreferences();
    updateCategoryOptions();
    render();
    toast('取得データを消去しました。保存したクリップは残っています');
  }));
  document.addEventListener('keydown', event => {
    if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && !$('about-dialog').open) {
      event.preventDefault(); $('query').focus();
    }
  });
  window.addEventListener('beforeunload', event => { if (state.busy) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => state.controller?.abort());
  document.documentElement.dataset.ready = 'true';
}

initialize().catch(error => { showError(error); $('collect').disabled = true; });
