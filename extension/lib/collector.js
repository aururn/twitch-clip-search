import { mergeCategories } from './core.js';
import { pause, abortError } from './api.js';

// A round first expands breadth, then continues less-visited categories.
// Two requests at a time; every successful page is persisted with its cursor.
export async function collectRound({ api, store, scope, signal, onPage = () => {}, onProgress = () => {}, limit = 60 }) {
  if (signal.aborted) throw abortError();
  const errors = [];
  onProgress({ stage: 'カテゴリを探しています', completed: 0, total: limit });
  if (!scope.directoryDone) {
    try {
      const directory = await api.directory(scope.directoryCursor, signal);
      mergeCategories(scope, directory.names);
      if (directory.warning) errors.push({ category: 'カテゴリ一覧', message: directory.warning });
      const repeated = directory.cursor === scope.directoryCursor;
      scope.directoryCursor = directory.cursor;
      scope.directoryDone = !directory.hasNext || !directory.cursor || repeated;
      scope.directoryPages += 1;
      await store.putMeta(structuredClone(scope));
    } catch (error) {
      if (signal.aborted) throw abortError();
      errors.push({ category: 'カテゴリ一覧', message: error.message });
    }
  }
  const pending = scope.categories.filter(category => !category.done).sort((a, b) => a.pages - b.pages);
  const newCategories = pending.filter(category => !category.pages).slice(0, limit);
  // Continuing a public page is slower than reading its initial metadata.
  const queue = [...newCategories, ...pending.filter(category => category.pages > 0).slice(0, Math.min(6, limit - newCategories.length))];
  let completed = 0;
  let added = 0;
  let consecutiveFailures = 0;
  for (let index = 0; index < queue.length; index += 2) {
    if (signal.aborted) throw abortError();
    const batch = queue.slice(index, index + 2);
    const outcomes = await Promise.allSettled(batch.map(category => api.clips(category, scope, signal)));
    if (signal.aborted) throw abortError();
    for (let offset = 0; offset < outcomes.length; offset++) {
      const category = batch[offset];
      const outcome = outcomes[offset];
      if (outcome.status === 'rejected') {
        category.error = outcome.reason.message;
        errors.push({ category: category.name, message: category.error });
        consecutiveFailures++;
      } else {
        consecutiveFailures = 0;
        const page = outcome.value;
        const previousCursor = category.cursor;
        category.cursor = page.cursor;
        category.done = !page.hasNext || !page.cursor || page.cursor === previousCursor;
        category.pages++;
        category.error = '';
        scope.updatedAt = Date.now();
        // Snapshot now: IndexedDB data and the paging checkpoint advance together.
        await store.commitPage(page.clips, structuredClone(scope));
        added += page.clips.length;
        onPage(page.clips);
      }
      completed++;
      onProgress({ stage: category.name, completed, total: queue.length, added, errors: errors.length });
    }
    if (consecutiveFailures >= 4) break;
    if (index + 2 < queue.length) await pause(250, signal);
  }
  await store.putMeta(structuredClone(scope));
  const remaining = scope.categories.some(category => !category.done) || !scope.directoryDone;
  return { added, completed, errors, remaining };
}
