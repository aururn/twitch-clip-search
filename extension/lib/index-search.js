import { matchesTitle, parseQuery, PERIODS } from './core.js';
import { abortError } from './api.js';

export const INDEX_HOME = 'https://www.twitch-clips-storage.com/app/twitch-clips-jp/';
const ENDPOINT = 'https://www.twitch-clips-storage.com/api/twitch-clips/clips.php';
const PAGE_SIZE = 200;

export function freshIndexSearch(options) {
  const raw = [...String(options.query ?? '').matchAll(/(-?)(?:"([^"]+)"|([^\s"]+))/g)].find(match => match[1] !== '-');
  const first = raw ? (raw[2] ?? raw[3]).normalize('NFKC').toLocaleLowerCase('ja') : '';
  const terms = first ? [...new Set([first,
    first.replace(/[ァ-ヶ]/g, char => String.fromCharCode(char.charCodeAt(0) - 0x60)),
    first.replace(/[ぁ-ゖ]/g, char => String.fromCharCode(char.charCodeAt(0) + 0x60)),
  ])] : [];
  const sources = options.period === 'ALL_TIME' ? ['allClips', 'dailyClips', 'monthlyClips'] : ['dailyClips'];
  return {
    key: `index:v1:${JSON.stringify(options)}`, options: structuredClone(options), updatedAt: 0,
    jobs: terms.flatMap(term => sources.map(source => ({ term, source, page: 1, done: false }))),
  };
}

function tokyoDate(value) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

// This is the same public, unauthenticated search endpoint used by the source's
// own web interface. No bulk catalogue download, tracking call or login is used.
export class ClipIndex {
  constructor(fetchImpl = globalThis.fetch.bind(globalThis)) { this.fetch = fetchImpl; }

  async page(job, options, signal, now = Date.now()) {
    if (signal.aborted) throw abortError();
    const days = PERIODS[options.period]?.days ?? Infinity;
    const url = new URL(ENDPOINT);
    url.search = new URLSearchParams({
      selectDatabase: job.source, search: job.term, page_number: String(job.page),
      data_quantity: String(PAGE_SIZE), remove_tag: 'true', dateType: 'creation-time',
      target_start_date: Number.isFinite(days) ? tokyoDate(now - days * 86400000) : '2016-05-01',
      target_start_time: '00:00', target_end_date: tokyoDate(now), target_end_time: '23:59',
      sort_order: options.sort === 'views' ? 'views' : 'date',
      sort_direction: options.sort === 'oldest' ? 'asc' : 'desc',
    });
    const response = await this.fetch(url.href, {
      credentials: 'omit', referrerPolicy: 'no-referrer',
      signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
    });
    if (!response.ok) {
      const error = new Error(`検索元から取得できませんでした（HTTP ${response.status}）。取得済みの結果は残ります。`);
      error.status = response.status;
      const retry = response.headers.get('Retry-After');
      const delay = retry && Number.isFinite(Number(retry)) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
      error.retryAt = Date.now() + Math.max(60000, Number.isFinite(delay) ? delay : 0);
      throw error;
    }
    const data = await response.json();
    const total = Number(data.totalRecords);
    if (!Array.isArray(data.records) || !/^\d+$/.test(String(data.totalRecords)) || !Number.isSafeInteger(total) || total < 0 || data.error) throw new Error('検索元の応答形式が変わっています。');
    if (!data.records.length && total > (job.page - 1) * PAGE_SIZE) throw new Error('検索元の続きが読み込まれませんでした。');
    return { records: data.records, total, hasNext: job.page * PAGE_SIZE < total };
  }
}

export async function searchIndexPages({ index, api, store, scope, signal, knownClips = new Map(), onPage = () => {}, onProgress = () => {} }) {
  if (signal.aborted) throw abortError();
  const tokens = parseQuery(scope.options.query);
  const pending = scope.jobs.filter(job => !job.done && !(job.retryAt > Date.now()));
  const errors = [];
  if (!pending.length && scope.jobs.some(job => !job.done)) errors.push('検索元の再試行は少し待ってから行ってください。取得済みの結果は検索できます。');
  let completed = 0;
  let added = 0;
  for (const job of pending) {
    if (signal.aborted) throw abortError();
    onProgress({ completed, total: pending.length, stage: 'タイトルを検索しています' });
    try {
      const page = await index.page(job, scope.options, signal);
      // The source also matches broadcaster names. Never count those as title
      // matches, and never present its totalRecords as a title-result count.
      const slugs = [...new Set(page.records.filter(record =>
        /^[A-Za-z0-9_-]{1,200}$/.test(record.id ?? '') && typeof record.title === 'string' && matchesTitle(record.title, tokens),
      ).map(record => record.id))];
      const recent = [];
      const missing = [];
      for (const slug of slugs) {
        const cached = knownClips.get(slug);
        if (cached && Date.now() - cached.fetchedAt < 3600000) recent.push(cached);
        else missing.push(slug);
      }
      // Verify current titles, availability, timestamps and languages on Twitch.
      // Deleted clips disappear here; stale index titles cannot create matches.
      const hydrated = missing.length ? await api.hydrate(missing, signal) : [];
      if (signal.aborted) throw abortError();
      const clips = [...recent, ...hydrated].filter(clip => matchesTitle(clip.title, tokens));
      const next = { ...job, page: job.page + 1, done: !page.hasNext };
      const snapshot = structuredClone(scope);
      Object.assign(snapshot.jobs[scope.jobs.indexOf(job)], next);
      snapshot.updatedAt = Date.now();
      await store.commitPage(clips, snapshot);
      Object.assign(job, next);
      scope.updatedAt = snapshot.updatedAt;
      for (const clip of clips) {
        if (!knownClips.has(clip.slug)) added++;
        knownClips.set(clip.slug, clip);
      }
      onPage(clips);
      completed++;
    } catch (error) {
      if (signal.aborted || error.name === 'AbortError') throw abortError();
      errors.push(error.message);
      job.retryAt = error.retryAt ?? Date.now() + 60000;
      if (error.status === 429 || error.status === 503) for (const item of scope.jobs) item.retryAt = job.retryAt;
      await store.putMeta?.(structuredClone(scope));
      if (error.status === 429 || error.status === 503) break;
    }
  }
  return { added, completed, errors, remaining: scope.jobs.some(job => !job.done) };
}
