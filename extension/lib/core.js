export const PERIODS = {
  LAST_DAY: { label: '過去24時間', days: 1 },
  LAST_WEEK: { label: '過去7日', days: 7 },
  LAST_MONTH: { label: '過去30日', days: 30 },
  ALL_TIME: { label: '全期間', days: Infinity },
};

export const SEED_CATEGORIES = [
  'Grand Theft Auto V', 'Just Chatting', 'VALORANT', 'Apex Legends',
  'Minecraft', 'League of Legends', 'Overwatch 2', 'Escape from Tarkov',
  'Street Fighter 6', 'Dead by Daylight', 'Rust', 'IRL',
];

export function normalize(text) {
  return String(text ?? '').normalize('NFKC').toLocaleLowerCase('ja').trim();
}

export function parseQuery(query) {
  const tokens = [];
  const pattern = /(-?)(?:"([^"]+)"|([^\s"]+))/g;
  for (const match of String(query).matchAll(pattern)) {
    const term = normalize(match[2] ?? match[3]);
    if (term) tokens.push({ term, exclude: match[1] === '-' });
  }
  return tokens;
}

export function matchesTitle(title, tokens) {
  const value = normalize(title);
  return tokens.every(({ term, exclude }) => exclude ? !value.includes(term) : value.includes(term));
}

export function highlightParts(title, tokens) {
  const map = [];
  let normalized = '';
  for (const item of new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(title)) {
    const part = item.segment.normalize('NFKC').toLocaleLowerCase('ja');
    for (let i = 0; i < part.length; i++) map.push({ start: item.index, end: item.index + item.segment.length });
    normalized += part;
  }
  const ranges = [];
  for (const { term, exclude } of tokens) {
    if (exclude) continue;
    let from = 0;
    while (from < normalized.length) {
      const index = normalized.indexOf(term, from);
      if (index < 0) break;
      ranges.push({ start: map[index].start, end: map[index + term.length - 1].end });
      from = index + term.length;
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of ranges) {
    if (merged.length && range.start <= merged.at(-1).end) merged.at(-1).end = Math.max(range.end, merged.at(-1).end);
    else merged.push({ ...range });
  }
  const parts = [];
  let start = 0;
  for (const range of merged) {
    if (range.start > start) parts.push({ text: title.slice(start, range.start), hit: false });
    parts.push({ text: title.slice(range.start, range.end), hit: true });
    start = range.end;
  }
  if (start < title.length) parts.push({ text: title.slice(start), hit: false });
  return parts;
}

export function filterClips(clips, { query = '', period = 'ALL_TIME', language = 'JA', sort = 'views', category = '' } = {}, now = Date.now()) {
  const tokens = parseQuery(query);
  const cutoff = now - (PERIODS[period]?.days ?? 30) * 86400000;
  return clips.filter(clip =>
    matchesTitle(clip.title, tokens) &&
    (language === 'ALL' || clip.language === language) &&
    Date.parse(clip.createdAt) >= cutoff &&
    (!category || clip.category === category),
  ).sort((a, b) => {
    const delta = sort === 'newest' ? Date.parse(b.createdAt) - Date.parse(a.createdAt)
      : sort === 'oldest' ? Date.parse(a.createdAt) - Date.parse(b.createdAt)
        : b.views - a.views;
    return delta || a.slug.localeCompare(b.slug);
  });
}

export function safeImageURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /(^|\.)(jtvnw\.net|twitch\.tv)$/.test(url.hostname) ? url.href : '';
  } catch { return ''; }
}

export function sanitizeClip(node, category) {
  if (!node || !/^[A-Za-z0-9_-]{1,200}$/.test(node.slug ?? '') || typeof node.title !== 'string' || !Number.isFinite(Date.parse(node.createdAt))) return null;
  return {
    slug: node.slug,
    title: node.title.slice(0, 1000),
    url: `https://clips.twitch.tv/${node.slug}`,
    views: Math.max(0, Number(node.viewCount) || 0),
    createdAt: node.createdAt,
    duration: Math.max(0, Number(node.durationSeconds) || 0),
    language: String(node.language ?? '').toUpperCase(),
    image: safeImageURL(node.thumbnailURL),
    broadcaster: String(node.broadcaster?.displayName ?? node.broadcaster?.login ?? '').slice(0, 100),
    login: String(node.broadcaster?.login ?? '').slice(0, 100),
    category: String(node.game?.displayName ?? node.game?.name ?? category ?? '').slice(0, 200),
    fetchedAt: Date.now(),
  };
}

export function freshScope(period, language) {
  return {
    key: `${period}:${language}`, period, language,
    categories: SEED_CATEGORIES.map(name => ({ name, slug: categorySlug(name), cursor: null, pages: 0, done: false, error: '' })),
    broadcasters: [], directoryCursor: null, directoryDone: false, directoryPages: 0, updatedAt: 0,
  };
}

export function mergeCategories(scope, names) {
  const known = new Set(scope.categories.map(item => item.name));
  const slugs = new Set(scope.categories.map(item => item.slug).filter(Boolean));
  for (const item of names) {
    const name = typeof item === 'string' ? item : item?.name;
    const slug = typeof item === 'string' ? '' : item?.slug;
    if (slug && slugs.has(slug)) continue;
    if (typeof name !== 'string' || !name || known.has(name)) continue;
    scope.categories.push({ name, ...(slug ? { slug } : {}), cursor: null, pages: 0, done: false, error: '' });
    known.add(name);
    if (slug) slugs.add(slug);
  }
}

export function categorySlug(name) {
  return String(name).toLowerCase().replaceAll("'", '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
}

export function formatViews(views) {
  return new Intl.NumberFormat('ja-JP', { notation: views >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(views);
}

export function webSearchURL(query) {
  const terms = parseQuery(query).filter(token => !token.exclude);
  const keyword = terms.map(({ term }) => `intitle:"${term.replaceAll('"', '')}"`).join(' ');
  return `https://www.google.com/search?${new URLSearchParams({ q: `(site:clips.twitch.tv OR site:twitch.tv/clip OR site:twitch.tv/*/clip/) ${keyword}` })}`;
}
