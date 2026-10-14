import { mergeCategories, matchesTitle, parseQuery } from './core.js';
import { pause, abortError } from './api.js';

// Category rankings discover broadcasters. Their own rankings add clips outside
// a category's top 100. Each period has a checkpoint, and only two requests run
// at a time. No channel input or account credentials are required.
export async function collectRound({ api, store, scope, signal, onPage = () => {}, onProgress = () => {}, limit = 60, broadcasterLimit = 40, knownClips = [], query = '' }) {
  if (signal.aborted) throw abortError();
  const errors = [];
  const known = new Set();
  const tokens = parseQuery(query);
  const priorities = new Map();
  scope.broadcasters ??= [];
  const broadcasters = new Map(scope.broadcasters.map(item => [item.login, item]));
  const periods = scope.period === 'ALL_TIME' ? ['ALL_TIME', 'LAST_MONTH', 'LAST_WEEK', 'LAST_DAY'] : [scope.period];
  const discover = clips => {
    for (const clip of clips) {
      if (!/^[a-z0-9_]{1,25}$/i.test(clip.login ?? '')) continue;
      if (scope.language !== 'ALL' && clip.language !== scope.language) continue;
      if (!broadcasters.has(clip.login)) {
        const item = { login: clip.login, name: clip.broadcaster || clip.login, periods: [], error: '' };
        broadcasters.set(clip.login, item);
        scope.broadcasters.push(item);
      }
      if (tokens.some(token => !token.exclude) && matchesTitle(clip.title, tokens)) priorities.set(clip.login, (priorities.get(clip.login) ?? 0) + 1);
    }
  };
  for (const clip of knownClips) { known.add(clip.slug); discover([clip]); }
  let completed = 0;
  let added = 0;
  let consecutiveFailures = 0;
  const commit = async clips => {
    discover(clips);
    scope.updatedAt = Date.now();
    await store.commitPage(clips, structuredClone(scope));
    for (const clip of clips) {
      if (!known.has(clip.slug)) added++;
      known.add(clip.slug);
    }
    onPage(clips);
  };
  onProgress({ stage: 'カテゴリを探しています', completed: 0, total: limit + broadcasterLimit });
  const pendingBroadcasters = api.broadcasterClips && scope.broadcasters.some(item => periods.some(period => !item.periods.includes(period)));
  if (!scope.directoryDone && (!scope.directoryCursor || !pendingBroadcasters)) {
    try {
      const directory = await api.directory(scope.directoryCursor, signal);
      mergeCategories(scope, directory.names);
      if (directory.warning) errors.push({ source: 'カテゴリ一覧', message: directory.warning });
      const repeated = directory.cursor === scope.directoryCursor;
      scope.directoryCursor = directory.cursor;
      scope.directoryDone = !directory.hasNext || !directory.cursor || repeated;
      scope.directoryPages += 1;
      await store.putMeta(structuredClone(scope));
    } catch (error) {
      if (signal.aborted) throw abortError();
      errors.push({ source: 'カテゴリ一覧', message: error.message });
    }
  }
  const pending = scope.categories.filter(category => !category.done).sort((a, b) => a.pages - b.pages);
  const newCategories = pending.filter(category => !category.pages).slice(0, limit);
  // Prefer unseen broadcaster rankings to repeatedly hitting a blocked category
  // continuation. Retain the normal-page fallback once these are exhausted.
  const hasBroadcasters = api.broadcasterClips && scope.broadcasters.some(item => periods.some(period => !item.periods.includes(period)));
  const queue = [...newCategories, ...(!hasBroadcasters ? pending.filter(category => category.pages > 0).slice(0, Math.min(6, limit - newCategories.length)) : [])];
  const runBatch = async (jobs, request, success, total) => {
    for (let index = 0; index < jobs.length; index += 2) {
      if (signal.aborted) throw abortError();
      const batch = jobs.slice(index, index + 2);
      const outcomes = await Promise.allSettled(batch.map(request));
      if (signal.aborted) throw abortError();
      for (let offset = 0; offset < outcomes.length; offset++) {
        const job = batch[offset];
        const outcome = outcomes[offset];
        if (outcome.status === 'rejected') {
          job.error = outcome.reason.message;
          errors.push({ source: job.name, message: job.error });
          consecutiveFailures++;
        } else {
          consecutiveFailures = 0;
          await success(job, outcome.value);
        }
        completed++;
        onProgress({ stage: job.name, completed, total, added, errors: errors.length });
      }
      if (consecutiveFailures >= 4) break;
      if (index + 2 < jobs.length) await pause(250, signal);
    }
  };
  await runBatch(queue, category => api.clips(category, scope, signal), async (category, page) => {
    const previousCursor = category.cursor;
    category.cursor = page.cursor;
    category.done = !page.hasNext || !page.cursor || page.cursor === previousCursor;
    category.pages++;
    category.error = '';
    await commit(page.clips);
  }, queue.length + broadcasterLimit);
  if (consecutiveFailures < 4 && api.broadcasterClips) {
    const creators = scope.broadcasters.filter(item => periods.some(period => !item.periods.includes(period)))
      .sort((a, b) => a.periods.length - b.periods.length || (priorities.get(b.login) ?? 0) - (priorities.get(a.login) ?? 0) || a.login.localeCompare(b.login))
      .slice(0, broadcasterLimit);
    await runBatch(creators, creator => api.broadcasterClips(creator.login, periods.find(period => !creator.periods.includes(period)), signal), async (creator, page) => {
      creator.periods.push(periods.find(period => !creator.periods.includes(period)));
      creator.error = '';
      creator.partial = page.hasNext;
      await commit(page.clips);
    }, completed + creators.length);
  }
  await store.putMeta(structuredClone(scope));
  const remaining = scope.categories.some(category => !category.done) || !scope.directoryDone || scope.broadcasters.some(item => periods.some(period => !item.periods.includes(period)));
  return { added, completed, errors, remaining };
}
