export function openStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('clip-scout', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('clips', { keyPath: 'slug' });
      request.result.createObjectStore('favorites', { keyPath: 'slug' });
      request.result.createObjectStore('meta', { keyPath: 'key' });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(new ScoutStore(request.result));
  });
}

class ScoutStore {
  constructor(db) { this.db = db; }

  read(store, key) {
    return new Promise((resolve, reject) => {
      const request = this.db.transaction(store).objectStore(store)[key === undefined ? 'getAll' : 'get'](key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  write(stores, fn) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(stores, 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('保存が中断されました'));
      fn(transaction);
    });
  }

  async commitPage(clips, scope) {
    await this.write(['clips', 'meta'], transaction => {
      for (const clip of clips) transaction.objectStore('clips').put(clip);
      transaction.objectStore('meta').put(structuredClone(scope));
    });
  }

  putMeta(record) { return this.write(['meta'], tx => tx.objectStore('meta').put(record)); }
  favorite(clip, enabled) {
    return this.write(['favorites'], tx => enabled ? tx.objectStore('favorites').put(clip) : tx.objectStore('favorites').delete(clip.slug));
  }
  clearCache() {
    return this.write(['clips', 'meta'], tx => { tx.objectStore('clips').clear(); tx.objectStore('meta').clear(); });
  }
}
