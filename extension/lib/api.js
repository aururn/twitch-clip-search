import { sanitizeClip } from './core.js';

// Public website client identifier, not an account token or application secret.
const WEBSITE_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const ENDPOINT = 'https://gql.twitch.tv/gql';
const DIRECTORY_QUERY = `query ScoutDirectory($after: Cursor) {
  games(first: 50, after: $after) {
    edges { cursor node { name slug } } pageInfo { hasNextPage }
  }
}`;
const CLIPS_QUERY = `query ScoutClips($name: String!, $after: Cursor, $criteria: GameClipsInput!) {
  game(name: $name) {
    clips(first: 100, after: $after, criteria: $criteria) {
      edges { cursor node {
        slug title viewCount createdAt durationSeconds language thumbnailURL
        broadcaster { login displayName } game { name displayName }
      } }
      pageInfo { hasNextPage }
    }
  }
}`;

export function abortError() { return new DOMException('取得を停止しました', 'AbortError'); }

export function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const stop = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

export class TwitchAPI {
  constructor(fetchImpl = globalThis.fetch.bind(globalThis)) {
    this.fetch = fetchImpl;
    this.clientID = WEBSITE_CLIENT_ID;
  }

  async initialize(signal) {
    // Refresh the public identifier if the Twitch web client changes it.
    try {
      const response = await this.fetch('https://www.twitch.tv/directory', {
        credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });
      if (response.ok) {
        const html = await response.text();
        this.clientID = html.match(/clientId\s*[:=]\s*"([a-z0-9]+)"/i)?.[1] ?? WEBSITE_CLIENT_ID;
      }
    } catch (error) { if (signal.aborted) throw abortError(); }
  }

  async request(query, variables, signal) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal?.aborted) throw abortError();
      let response;
      try {
        response = await this.fetch(ENDPOINT, {
          method: 'POST', credentials: 'omit',
          headers: { 'Client-ID': this.clientID, 'Content-Type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        });
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (attempt === 2) throw new Error('Twitchに接続できませんでした。接続を確認して再度お試しください。');
        await pause(800 * (attempt + 1), signal);
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt === 2) throw new Error('Twitchが混雑しています。少し待って再度お試しください。');
        const retry = Math.max(1000, Math.min(10000, Number(response.headers.get('Retry-After')) * 1000 || 1500 * (attempt + 1)));
        await pause(retry, signal);
        continue;
      }
      if (!response.ok) throw new Error(`Twitchから取得できませんでした（HTTP ${response.status}）。`);
      const data = await response.json();
      if (data.errors?.length || !data.data) {
        if (data.errors?.some(error => /integrity/i.test(error.message))) throw new Error('Twitchがこのデータの自動取得を制限しています。取得済みデータは検索できます。');
        throw new Error(`Twitchの取得形式が変更された可能性があります: ${data.errors?.[0]?.message ?? 'データなし'}`);
      }
      return data.data;
    }
  }

  async directory(cursor, signal) {
    const data = await this.request(DIRECTORY_QUERY, { after: cursor }, signal);
    const connection = data.games;
    if (!connection?.edges || !connection.pageInfo) throw new Error('カテゴリ一覧の取得形式が変わっています。');
    return {
      names: connection.edges.map(edge => edge.node).filter(node => node?.name),
      cursor: connection.edges.at(-1)?.cursor ?? null,
      hasNext: Boolean(connection.pageInfo.hasNextPage),
    };
  }

  async clips(category, scope, signal) {
    const criteria = { period: scope.period };
    if (scope.language !== 'ALL') criteria.languages = [scope.language];
    const query = category.slug ? CLIPS_QUERY.replace('game(name: $name)', 'game(slug: $name)') : CLIPS_QUERY;
    const data = await this.request(query, { name: category.slug ?? category.name, after: category.cursor, criteria }, signal);
    if (!data.game) return { clips: [], cursor: null, hasNext: false };
    const connection = data.game.clips;
    if (!connection?.edges || !connection.pageInfo) throw new Error('クリップの取得形式が変わっています。');
    return {
      clips: connection.edges.map(edge => sanitizeClip(edge.node, category.name)).filter(Boolean),
      cursor: connection.edges.at(-1)?.cursor ?? null,
      hasNext: Boolean(connection.pageInfo.hasNextPage),
    };
  }

  async hydrate(slugs, signal) {
    const result = [];
    // Twitch permits at most 15 root aliases. Keep each request below that limit.
    const batchSize = 10;
    for (let index = 0; index < slugs.length; index += batchSize) {
      const batch = slugs.slice(index, index + batchSize);
      const variables = Object.fromEntries(batch.map((slug, offset) => [`s${offset}`, slug]));
      const declaration = batch.map((_, offset) => `$s${offset}: ID!`).join(', ');
      const fields = batch.map((_, offset) => `c${offset}: clip(slug: $s${offset}) {
        slug title viewCount createdAt durationSeconds language thumbnailURL
        broadcaster { login displayName } game { name displayName }
      }`).join('\n');
      const data = await this.request(`query ScoutMetadata(${declaration}) { ${fields} }`, variables, signal);
      result.push(...Object.values(data).map(node => sanitizeClip(node)).filter(Boolean));
      if (index + batchSize < slugs.length) await pause(100, signal);
    }
    return result;
  }
}
