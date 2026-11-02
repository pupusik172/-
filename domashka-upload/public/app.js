const tg = window.Telegram?.WebApp;
tg?.ready(); tg?.expand();
const user = tg?.initDataUnsafe?.user;
const userId = String(user?.id || new URLSearchParams(location.search).get('userId') || '1754545781');
const state = { tasks: [], filter: 'todo', editing: null, photos: [], photoSyncs: [], photoThumbs: [], uploading: false, uploadId: 0, uploadPromise: null };
const viewer = { photos: [], index: 0, zoom: 1, offsetX: 0, offsetY: 0, touchStartX: 0, touchStartY: 0, pinchStartDistance: 0, pinchStartZoom: 1, wasPinching: false };
const $ = (id) => document.getElementById(id);
const savedTheme = localStorage.getItem('domashka_theme') || 'orange';
document.body.dataset.theme = savedTheme;
const localKey = `domashka_tasks_${userId}`;
// Some Telegram Desktop builds report an older WebApp version while still
// exposing CloudStorage. Let the API decide; failed calls fall back locally.
const cloudStorage = tg?.CloudStorage || null;
let cloudStorageUsable = Boolean(cloudStorage);
const CLOUD_TIMEOUT = 2500;
const PHOTO_CHUNK_SIZE = 3800;
const PHOTO_MAX_CHUNKS = 700;
const TASKS_CHUNK_SIZE = 3500;
const TASKS_KEY = 'domashka_tasks';
const TASKS_INDEX_KEY = 'domashka_tasks_index';
// Full-size media is served by the dedicated R2-backed worker. CloudStorage
// remains the compatibility path for older tasks and for a temporary outage.
const MEDIA_SERVER_URL = 'https://domashka-media-vault.sparklesgrc.chatgpt.site';
// Keep originals up to the CloudStorage key budget. Only unusually large
// files fall back to a high-quality transfer copy.
const PHOTO_SYNC_MAX_LENGTH = PHOTO_CHUNK_SIZE * 580;
const photoChunkKey = (taskId, photoIndex, chunkIndex) => `domashka_photo_${taskId}_${photoIndex}_${chunkIndex}`;
const photoThumbKey = (taskId, photoIndex) => `domashka_thumb_${taskId}_${photoIndex}`;
const mediaUrl = (taskId, photoIndex, version = '') => `${MEDIA_SERVER_URL}/v1/media/${encodeURIComponent(userId)}/${encodeURIComponent(taskId)}/${photoIndex}${version ? `?v=${encodeURIComponent(version)}` : ''}`;
const splitPhoto = (photo) => Array.from({ length: Math.max(1, Math.ceil(photo.length / PHOTO_CHUNK_SIZE)) }, (_, index) => photo.slice(index * PHOTO_CHUNK_SIZE, (index + 1) * PHOTO_CHUNK_SIZE));
const runBatches = async (jobs, size = 4) => { for (let index = 0; index < jobs.length; index += size) await Promise.all(jobs.slice(index, index + size).map((job) => job())); };
// Every Telegram request must settle, including missing native callbacks.
const cloudRequest = (method, args) => new Promise((resolve, reject) => {
  if (!cloudStorage) return reject(new Error('Telegram CloudStorage недоступен'));
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    error ? reject(new Error(String(error))) : resolve(value || '');
  };
  const timer = setTimeout(() => finish('Telegram не ответил. Запись сохранена на устройстве; синхронизация будет повторена.'), CLOUD_TIMEOUT);
  try { cloudStorage[method](...args, finish); } catch (error) { finish(error.message); }
});
const cloudGet = (key) => cloudRequest('getItem', [key]);
const cloudGetKeys = () => cloudRequest('getKeys', []);
const cloudSet = (key, value) => cloudRequest('setItem', [key, value]);
const cloudRemove = (key) => cloudRequest('removeItem', [key]);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cloudSetWithRetry = async (key, value) => {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { await cloudSet(key, value); return; } catch (error) { lastError = error; await wait(180 * (attempt + 1)); }
  }
  throw lastError;
};
const pendingKey = `${localKey}_pending`;
const photoEngine = (() => {
  let dbPromise;
  const open = () => {
    if (!window.indexedDB) return Promise.resolve(null);
    if (!dbPromise) dbPromise = new Promise((resolve) => {
      const request = indexedDB.open('domashka_photo_engine_v1', 1);
      let settled = false;
      const finish = (db) => { if (settled) { db?.close(); return; } settled = true; clearTimeout(timer); resolve(db); };
      const timer = setTimeout(() => finish(null), 4000);
      request.onupgradeneeded = () => request.result.createObjectStore('photos', { keyPath: 'taskId' });
      request.onsuccess = () => finish(request.result);
      request.onerror = request.onblocked = () => finish(null);
    });
    return dbPromise;
  };
  const get = (store, taskId) => new Promise((resolve) => { const request = store.get(taskId); request.onsuccess = () => resolve(request.result || null); request.onerror = () => resolve(null); });
  return {
    async cache(tasks) {
      try {
        const db = await open();
        if (!db) return false;
        const records = tasks.filter((task) => taskPhotos(task).length).map((task) => ({ taskId: task.id, photos: taskPhotos(task), photoSyncs: task.photoSyncs || taskPhotos(task), photoThumbs: task.photoThumbs || [] }));
        if (!records.length) return true;
        return await new Promise((resolve) => {
          const tx = db.transaction('photos', 'readwrite');
          const timer = setTimeout(() => { try { tx.abort(); } catch {} resolve(false); }, 10000);
          tx.oncomplete = () => { clearTimeout(timer); resolve(true); };
          tx.onerror = tx.onabort = () => { clearTimeout(timer); resolve(false); };
          const store = tx.objectStore('photos');
          records.forEach((record) => store.put(record));
        });
      } catch { return false; }
    },
    async restore(tasks) { const db = await open(); if (!db) return tasks; return Promise.all(tasks.map(async (task) => { if (taskPhotos(task).length) return task; const tx = db.transaction('photos', 'readonly'); const record = await get(tx.objectStore('photos'), task.id); return record?.photos?.length ? { ...task, photos: record.photos, photoSyncs: record.photoSyncs || record.photos, photoThumbs: record.photoThumbs || task.photoThumbs } : task; })); },
    async remove(taskId) { const db = await open(); if (!db) return; await new Promise((resolve) => { const tx = db.transaction('photos', 'readwrite'); tx.objectStore('photos').delete(taskId); tx.oncomplete = resolve; tx.onerror = resolve; }); },
  };
})();
const taskMetadataChunkKey = (index) => `${TASKS_KEY}_${index}`;
const splitText = (value, size) => Array.from({ length: Math.max(1, Math.ceil(value.length / size)) }, (_, index) => value.slice(index * size, (index + 1) * size));
const readCloudTasks = async () => {
  const indexValue = await cloudGet(TASKS_INDEX_KEY);
  const count = Math.min(Math.max(Number(indexValue) || 0, 0), 64);
  if (count) {
    const chunks = [];
    for (let index = 0; index < count; index += 4) {
      chunks.push(...await Promise.all(Array.from({ length: Math.min(4, count - index) }, (_, offset) => cloudGet(taskMetadataChunkKey(index + offset)))));
    }
    return chunks.join('');
  }
  return cloudGet(TASKS_KEY);
};
const writeCloudTasks = async (cloudTasks) => {
  const serialized = JSON.stringify(cloudTasks);
  const chunks = splitText(serialized, TASKS_CHUNK_SIZE);
  const previousCount = Math.min(Math.max(Number(await cloudGet(TASKS_INDEX_KEY)) || 0, 0), 64);
  if (chunks.length === 1 && serialized.length <= TASKS_CHUNK_SIZE) {
    await cloudSet(TASKS_KEY, serialized);
    await cloudSet(TASKS_INDEX_KEY, '0');
  } else {
    await runBatches(chunks.map((chunk, index) => () => cloudSet(taskMetadataChunkKey(index), chunk)));
    await cloudSet(TASKS_INDEX_KEY, String(chunks.length));
    await cloudRemove(TASKS_KEY);
  }
  if (previousCount > chunks.length) await runBatches(Array.from({ length: previousCount - chunks.length }, (_, offset) => () => cloudRemove(taskMetadataChunkKey(chunks.length + offset))));
};
const loadChunkedPhoto = async (task, photoIndex) => {
  const count = Math.min(Math.max(Number(task.photoChunks?.[photoIndex]) || 0, 0), PHOTO_MAX_CHUNKS);
  const chunks = [];
  for (let chunkIndex = 0; chunkIndex < count; chunkIndex += 4) {
    const keys = Array.from({ length: Math.min(4, count - chunkIndex) }, (_, offset) => photoChunkKey(task.id, photoIndex, chunkIndex + offset));
    chunks.push(...await Promise.all(keys.map(cloudGet)));
  }
  if (chunks.length !== count || chunks.some((chunk) => !chunk)) return '';
  return chunks.join('');
};
let tasksCache = null;
let tasksLoadPromise = null;
let cloudMetadataCache = null;
const photoValueCache = new Map();
const mergeTasks = (remote, local) => {
  const merged = new Map(remote.map((task) => [task.id, task]));
  local.forEach((task) => merged.set(task.id, { ...merged.get(task.id), ...task }));
  return [...merged.values()];
};
const mergeLocalPhotos = (remote, local) => {
  const localById = new Map(local.map((task) => [task.id, task]));
  return remote.map((task) => {
    const cached = localById.get(task.id);
    const photos = taskPhotos(cached || {});
    return photos.length ? { ...task, photos, photoSyncs: cached.photoSyncs || photos, photoThumbs: cached.photoThumbs || task.photoThumbs } : task;
  });
};
const loadStoredTasks = async () => {
  const deviceTasks = await photoEngine.restore(JSON.parse(localStorage.getItem(localKey) || '[]'));
  const pending = localStorage.getItem(pendingKey);
  if (pending) {
    const localPending = pending === '1' ? deviceTasks : JSON.parse(pending);
    if (cloudStorageUsable) {
      try {
        const remoteValue = await readCloudTasks();
        const remoteTasks = remoteValue ? JSON.parse(remoteValue) : [];
        const merged = mergeTasks(remoteTasks, localPending);
        queueCloudSync(merged);
        return merged;
      } catch (error) { console.warn('Не удалось объединить локальные и облачные задания:', error.message); }
    }
    queueCloudSync(localPending);
    return localPending;
  }
  if (cloudStorageUsable) {
    let value;
    try { value = await readCloudTasks(); } catch (error) {
      console.warn(error.message);
      return deviceTasks;
    }
    if (value) {
      const stored = JSON.parse(value);
      cloudMetadataCache = stored;
      const tasks = [];
      for (const task of stored) {
        if (Array.isArray(task.photoChunks)) {
          const photoThumbs = [];
          if (Array.isArray(task.photoThumbs)) {
            for (let photoIndex = 0; photoIndex < Math.min(task.photoThumbs.length, 20); photoIndex += 1) {
              photoThumbs.push(task.photoThumbs[photoIndex] ? await cloudGet(photoThumbKey(task.id, photoIndex)) : '');
            }
            tasks.push({ ...task, photos: [], photoThumbs });
          } else {
            const photos = [];
            for (let photoIndex = 0; photoIndex < Math.min(task.photoChunks.length, 20); photoIndex += 1) {
              const photo = await loadChunkedPhoto(task, photoIndex);
              if (photo.startsWith('data:image/')) photos.push(photo);
            }
            tasks.push({ ...task, photos });
          }
        } else if (Array.isArray(task.photoKeys)) {
          const photos = [];
          for (const key of task.photoKeys.slice(0, 20)) {
            const photo = await cloudGet(key);
            if (photo) photos.push(photo);
          }
          tasks.push({ ...task, photos });
        } else if (task.photoKey) {
          const photo = await cloudGet(task.photoKey);
          tasks.push({ ...task, photos: photo ? [photo] : [] });
        } else tasks.push(task.photo ? { ...task, photos: [task.photo] } : task);
      }
      const repaired = mergeLocalPhotos(tasks, deviceTasks);
      if (repaired.some((task, index) => taskPhotos(task).length && !taskPhotos(tasks[index]).length) || repaired.some((task) => task.photos?.length && !task.photoChunks)) await writeStoredTasks(repaired);
      return repaired;
    }
    if (deviceTasks.length) await writeStoredTasks(deviceTasks);
    return deviceTasks;
  }
  return deviceTasks;
};
const readStoredTasks = async () => {
  if (tasksCache) return tasksCache;
  if (!tasksLoadPromise) {
    tasksLoadPromise = loadStoredTasks().then((tasks) => {
      tasksCache = tasks;
      return tasks;
    }).finally(() => { tasksLoadPromise = null; });
  }
  return tasksLoadPromise;
};
const syncStoredTasks = async (tasks, metadataReady = () => {}) => {
  if (cloudStorageUsable) {
    const previous = cloudMetadataCache || JSON.parse(await readCloudTasks() || '[]');
    const cloudTasks = tasks.map(({ photo, photos, photoSyncs, photoKeys, photoChunks, photoThumbs, ...task }) => {
      const mediaReady = Array.isArray(task.mediaUrls) && task.mediaUrls.some(Boolean);
      const attachments = mediaReady ? [] : (Array.isArray(photoSyncs) ? photoSyncs : (Array.isArray(photos) ? photos : (photo ? [photo] : [])));
      const thumbs = Array.isArray(photoThumbs) ? photoThumbs : [];
      if (!attachments.length && photoChunks?.length) return { ...task, photoChunks, photoThumbs: photoChunks.map((_, index) => Boolean(thumbs[index] && thumbs[index].length <= PHOTO_CHUNK_SIZE)) };
      return attachments.length ? { ...task, photoChunks: attachments.map((item) => splitPhoto(item).length), photoThumbs: attachments.map((_, index) => Boolean(thumbs[index] && thumbs[index].length <= PHOTO_CHUNK_SIZE)) } : task;
    });
    const oldPhotoKeys = previous.flatMap((task) => {
      const legacy = task.photoKeys || (task.photoKey ? [task.photoKey] : []);
      const chunked = (task.photoChunks || []).flatMap((count, photoIndex) => Array.from({ length: Math.min(Number(count) || 0, PHOTO_MAX_CHUNKS) }, (_, chunkIndex) => photoChunkKey(task.id, photoIndex, chunkIndex)));
      const thumbs = (task.photoThumbs || []).map((hasThumb, photoIndex) => hasThumb ? photoThumbKey(task.id, photoIndex) : '');
      return [...legacy, ...chunked, ...thumbs];
    }).filter(Boolean);
    const activePhotoKeys = new Set(cloudTasks.flatMap((task) => [
      ...(task.photoChunks || []).flatMap((count, photoIndex) => Array.from({length: count}, (_, chunkIndex) => photoChunkKey(task.id, photoIndex, chunkIndex))),
      ...(task.photoThumbs || []).flatMap((flag, index) => flag ? [photoThumbKey(task.id, index)] : []),
    ]));
    // Failed uploads from older versions can leave orphaned photo chunks and
    // exhaust Telegram's per-user key quota. Remove only keys that are not
    // referenced by the current task manifest.
    try {
      const keys = await cloudGetKeys();
      const orphaned = (Array.isArray(keys) ? keys : []).filter((key) => /^(domashka_photo_|domashka_thumb_)/.test(key) && !activePhotoKeys.has(key));
      await runBatches(orphaned.map((key) => async () => { await cloudRemove(key); photoValueCache.delete(key); }));
    } catch (error) { console.warn('Не удалось очистить старые фото-чанки:', error.message); }
    // Publish the task list first so another device can see the homework even
    // if Telegram closes this Mini App while the photo chunks are uploading.
    await writeCloudTasks(cloudTasks);
    cloudMetadataCache = cloudTasks;
    metadataReady();
    const photosToStore = tasks.flatMap((task) => {
      const mediaReady = Array.isArray(task.mediaUrls) && task.mediaUrls.some(Boolean);
      const attachments = mediaReady ? [] : (Array.isArray(task.photoSyncs) ? task.photoSyncs : (Array.isArray(task.photos) ? task.photos : (task.photo ? [task.photo] : [])));
      const thumbs = Array.isArray(task.photoThumbs) ? task.photoThumbs : [];
      return attachments.flatMap((photo, photoIndex) => [
        ...splitPhoto(photo).map((chunk, chunkIndex) => {
          const key = photoChunkKey(task.id, photoIndex, chunkIndex);
          return photoValueCache.get(key) === chunk ? null : async () => { await cloudSetWithRetry(key, chunk); photoValueCache.set(key, chunk); };
        }),
        ...(thumbs[photoIndex] && thumbs[photoIndex].length <= PHOTO_CHUNK_SIZE ? [(() => { const key = photoThumbKey(task.id, photoIndex); const value = thumbs[photoIndex]; return photoValueCache.get(key) === value ? null : async () => { await cloudSetWithRetry(key, value); photoValueCache.set(key, value); }; })()] : []),
      ].filter(Boolean));
    });
    // Telegram CloudStorage can reject bursts of writes. Serialise photo
    // chunks and retry transient failures without blocking the form.
    await runBatches(photosToStore, 1);
    // Cleanup only after the updated task list is acknowledged.
    await runBatches(oldPhotoKeys.filter((key) => !activePhotoKeys.has(key)).map((key) => async () => { await cloudRemove(key); photoValueCache.delete(key); }));
  }
};
let writeQueue = Promise.resolve();
let syncInFlight = false;
function queueCloudSync(tasks, waitForMetadata = false) {
  if (!cloudStorage) return Promise.resolve();
  const snapshot = JSON.stringify(tasks);
  let resolveMetadata;
  const metadataPromise = new Promise((resolve) => { resolveMetadata = resolve; });
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    syncInFlight = true;
    try {
      await syncStoredTasks(JSON.parse(snapshot), resolveMetadata);
      if (localStorage.getItem(pendingKey) === '1' || localStorage.getItem(pendingKey) === snapshot) localStorage.removeItem(pendingKey);
    } catch (error) {
      console.warn('Синхронизация отложена:', error.message);
      resolveMetadata();
    } finally { syncInFlight = false; }
  });
  return waitForMetadata ? Promise.race([metadataPromise, new Promise((resolve) => setTimeout(resolve, 800))]) : Promise.resolve();
}
const writeStoredTasks = async (tasks) => {
  // Persist before reporting success; quota errors keep the form open.
  const snapshot = JSON.stringify(tasks);
  const cached = await photoEngine.cache(tasks);
  const metadata = tasks.map(({ photos, photo, photoSyncs, ...task }) => task);
  // Both originals and transfer copies belong in IndexedDB. Keeping the
  // transfer copies in localStorage still overflowed its quota for phone photos.
  const localTasks = cached && snapshot.length > 3500000 ? metadata : tasks;
  try { localStorage.setItem(localKey, JSON.stringify(localTasks)); } catch {
    if (!cached) throw new Error('Не удалось сохранить фото на устройстве. Освободите место и повторите.');
    localStorage.setItem(localKey, JSON.stringify(metadata.map(({ photoThumbs, ...task }) => task)));
  }
  if (cloudStorage) localStorage.setItem(pendingKey, '1');
  tasksCache = tasks;
  await queueCloudSync(tasks, true);
};
const deadlineOutboxKey = `${localKey}_deadline_updates`;
let deadlineSyncRunning = false;
let deadlineBootstrapQueued = false;
const canSyncDeadlines = () => Boolean(tg?.initData && userId === '1754545781');
const deadlineMetadata = (task) => ({ id: task.id, title: String(task.title || ''), subject: String(task.subject || ''), dueDate: task.dueDate || '', status: task.status || 'todo' });
const readDeadlineOutbox = () => {
  try { const value = JSON.parse(localStorage.getItem(deadlineOutboxKey) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
};
async function flushDeadlineOutbox() {
  if (!canSyncDeadlines() || deadlineSyncRunning) return;
  deadlineSyncRunning = true;
  try {
    let queue = readDeadlineOutbox();
    while (queue.length) {
      const item = queue[0];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(`${MEDIA_SERVER_URL}/v1/reminder-tasks${item.path}`, {
          method: item.method,
          headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': tg.initData },
          ...(item.body ? { body: JSON.stringify(item.body) } : {}),
          signal: controller.signal, keepalive: true,
        });
        if (!response.ok) throw new Error('Обновление напоминаний отложено');
      } finally { clearTimeout(timer); }
      // Remove only the acknowledged operation, including when a new change
      // was queued while this network request was in flight.
      queue = readDeadlineOutbox().filter((operation) => operation.id !== item.id);
      if (queue.length) localStorage.setItem(deadlineOutboxKey, JSON.stringify(queue));
      else localStorage.removeItem(deadlineOutboxKey);
    }
  } catch (error) { console.warn('Напоминания будут обновлены при восстановлении связи:', error.message); }
  finally { deadlineSyncRunning = false; }
}
function queueDeadlineOperation(method, path, body) {
  if (!canSyncDeadlines()) return false;
  try {
    const queue = readDeadlineOutbox();
    queue.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, method, path, body });
    localStorage.setItem(deadlineOutboxKey, JSON.stringify(queue));
    void flushDeadlineOutbox();
    return true;
  } catch (error) { console.warn('Не удалось сохранить очередь напоминаний:', error.message); return false; }
}
function registerDeadlineTasks(tasks) {
  if (!canSyncDeadlines() || deadlineBootstrapQueued) return;
  deadlineBootstrapQueued = true;
  for (let index = 0; index < tasks.length; index += 100) {
    if (!queueDeadlineOperation('POST', '', { tasks: tasks.slice(index, index + 100).map(deadlineMetadata) })) deadlineBootstrapQueued = false;
  }
  void flushDeadlineOutbox();
}
function updateDeadlineMetadata(task, input) {
  if (!task) return;
  const changes = Object.fromEntries(Object.entries(input).filter(([key]) => ['title', 'subject', 'dueDate', 'status'].includes(key)));
  if (Object.keys(changes).length) queueDeadlineOperation('PATCH', `/${task.id}`, { changes, seed: deadlineMetadata(task) });
}
const localApi = async (path, options = {}) => {
  const tasks = await readStoredTasks();
  const method = options.method || 'GET';
  if (method === 'GET' && path === '/api/tasks') return Promise.resolve({ tasks, userId });
  const match = path.match(/^\/api\/tasks\/(\d+)$/);
  if (method === 'POST') {
    const input = JSON.parse(options.body || '{}');
    const subject = String(input.subject || '').trim() || 'Другое';
    const task = { id: Date.now(), userId, ...input, subject, status: input.status || 'todo', createdAt: new Date().toISOString() };
    await writeStoredTasks([...tasks, task]); updateDeadlineMetadata(task, deadlineMetadata(task)); return task;
  }
  if (match && method === 'PATCH') {
    const input = JSON.parse(options.body || '{}'); const updated = tasks.map((task) => task.id === Number(match[1]) ? { ...task, ...input, subject: String(input.subject ?? task.subject ?? '').trim() || 'Другое' } : task);
    await writeStoredTasks(updated); const task = updated.find((task) => task.id === Number(match[1])); updateDeadlineMetadata(task, input); return task;
  }
  if (match && method === 'DELETE') { await writeStoredTasks(tasks.filter((task) => task.id !== Number(match[1]))); queueDeadlineOperation('DELETE', `/${match[1]}`); return null; }
  return Promise.reject(new Error('Локальный маршрут не найден'));
};
const isPublicMiniApp = !['localhost', '127.0.0.1'].includes(location.hostname);
const api = async (path, options = {}) => {
  if (isPublicMiniApp) return localApi(path, options);
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'X-Telegram-User-Id': userId, ...(options.headers || {}) } });
  if (!response.ok) throw new Error((await response.json()).error || 'Ошибка сети');
  return response.status === 204 ? null : response.json();
};
const dateFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
const shortDate = (value) => value ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(`${value}T12:00:00`)) : 'Без срока';
const taskPhotos = (task) => Array.isArray(task.photos) ? task.photos.filter(Boolean).slice(0, 20) : (task.photo ? [task.photo] : []);
const taskMediaUrls = (task) => Array.isArray(task.mediaUrls) ? task.mediaUrls.slice(0, 20) : [];
const taskPhotoSources = (task) => {
  const photos = taskPhotos(task);
  const mediaUrls = Array.isArray(task.mediaUrls) ? task.mediaUrls.slice(0, 20) : [];
  const count = Math.max(photos.length, mediaUrls.length, Array.isArray(task.photoChunks) ? task.photoChunks.length : 0);
  return Array.from({ length: count }, (_, index) => mediaUrls[index] || photos[index] || '').filter(Boolean);
};
const fetchMedia = async (url, options = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try { return await fetch(url, { ...options, signal: controller.signal }); } finally { clearTimeout(timer); }
};
const dataUrlToBlob = async (value) => {
  const response = await fetch(value);
  if (!response.ok) throw new Error('Не удалось подготовить фото');
  return response.blob();
};
async function uploadMediaPhoto(taskId, photo, photoIndex) {
  if (typeof photo === 'string' && photo.startsWith(`${MEDIA_SERVER_URL}/v1/media/`)) return photo;
  if (!MEDIA_SERVER_URL || !photo?.startsWith('data:image/')) return '';
  const blob = await dataUrlToBlob(photo);
  const response = await fetchMedia(mediaUrl(taskId, photoIndex), {
    method: 'PUT',
    headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-Telegram-User-Id': userId },
    body: blob,
  });
  if (!response.ok) throw new Error('Медиа-сервис временно недоступен');
  const payload = await response.json();
  return typeof payload.url === 'string' ? payload.url : mediaUrl(taskId, photoIndex, Date.now());
}
async function uploadMediaPhotos(taskId, photos) {
  const urls = Array.from({ length: Math.min(photos.length, 20) }, () => '');
  for (let index = 0; index < urls.length; index += 2) {
    const batch = await Promise.all(photos.slice(index, index + 2).map((photo, offset) => uploadMediaPhoto(taskId, photo, index + offset).catch(() => '')));
    batch.forEach((url, offset) => { urls[index + offset] = url; });
    await yieldToBrowser();
  }
  return urls;
}
async function persistMediaUrls(taskId, photos) {
  const mediaUrls = await uploadMediaPhotos(taskId, photos);
  if (mediaUrls.some(Boolean)) await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ mediaUrls }) });
  return mediaUrls;
}
async function migrateTaskMedia(task, photos) {
  if (!task?.id || taskMediaUrls(task).some(Boolean) || !photos?.length) return;
  const mediaUrls = await persistMediaUrls(task.id, photos).catch(() => []);
  if (mediaUrls.some(Boolean)) { task.mediaUrls = mediaUrls; render(); }
}
function groupTasksBySubject(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const subject = String(task.subject || '').trim().replace(/\s+/g, ' ') || 'Без предмета';
    const key = subject.toLocaleLowerCase('ru-RU');
    if (!groups.has(key)) groups.set(key, { subject, tasks: [] });
    groups.get(key).tasks.push(task);
  }
  // Sort only the display list; saved records and their IDs stay unchanged.
  return [...groups.values()].map((group) => ({
    ...group,
    tasks: group.tasks.sort((a, b) => (a.dueDate || '9999-12-31').localeCompare(b.dueDate || '9999-12-31')),
  }));
}
function renderTaskRow(task) {
  const photos = taskPhotos(task);
  const mediaUrls = taskMediaUrls(task);
  const thumbnails = Array.isArray(task.photoThumbs) ? task.photoThumbs.filter(Boolean).slice(0, 20) : [];
  const cover = thumbnails[0] || mediaUrls.find(Boolean) || photos[0];
  const photoCount = Math.max(photos.length, mediaUrls.filter(Boolean).length, Array.isArray(task.photoChunks) ? task.photoChunks.length : 0);
  const hasPhotos = Boolean(cover) || photoCount > 0;
  return `<article class="task-card ${task.status === 'done' ? 'done' : ''}" data-id="${task.id}"><button type="button" class="check" data-action="toggle" aria-label="Отметить выполненным">${task.status === 'done' ? '✓' : ''}</button>${hasPhotos ? `<button type="button" class="photo-button" data-action="view-photo" data-photo-index="0" aria-label="Открыть фото задания">${cover ? `<img class="task-photo" src="${escapeHtml(cover)}" alt="Фото задания" loading="lazy" decoding="async">` : '<span class="task-photo task-photo-placeholder" aria-hidden="true">Фото</span>'}${photoCount > 1 ? `<span class="photo-count">+${photoCount - 1}</span>` : ''}</button>` : ''}<div class="task-main"><div class="task-title">${escapeHtml(task.title)}</div><div class="task-meta"><span class="task-date">${shortDate(task.dueDate)}</span><span class="tag ${task.priority}">${task.priority === 'high' ? 'Важно' : task.priority === 'medium' ? 'Обычный' : 'Можно позже'}</span></div></div><button type="button" class="task-menu" data-action="edit" aria-label="Изменить">•••</button>${task.status === 'done' ? '' : '<button type="button" class="task-delete" data-action="delete" aria-label="Удалить задание" title="Удалить">×</button>'}</article>`;
}
function countLabel(count, forms) {
  const lastTwo = Math.abs(count) % 100;
  const last = lastTwo % 10;
  const form = lastTwo >= 11 && lastTwo <= 14 ? forms[2] : last === 1 ? forms[0] : last >= 2 && last <= 4 ? forms[1] : forms[2];
  return `${count} ${form}`;
}
function subjectIcon(subject) {
  const key = subject.toLocaleLowerCase('ru-RU');
  const paths = key.includes('информат') ? '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4M7 8l-2 2 2 2m10-4 2 2-2 2"/>'
    : key.includes('инжен') ? '<path d="m12 3-8 17m8-17 8 17M7 14h10M12 3v5"/><circle cx="12" cy="5" r="2"/>'
    : key.includes('математ') ? '<path d="M4 7h6M7 4v6m7-3h6M4 17h6m4-2h6m-6 4h6"/>'
    : key.includes('истори') ? '<path d="M12 5C8 2 3 4 3 4v16s5-2 9 1c4-3 9-1 9-1V4s-5-2-9 1Zm0 0v16"/>'
    : key.includes('философ') ? '<path d="M8 15c-5-4-2-11 4-11s9 7 4 11l-1 2H9Zm1 5h6m-5 3h4"/>'
    : key.includes('англий') ? '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18"/>'
    : key.includes('прав') ? '<path d="M12 3v18m-5 0h10M5 6h14M5 6l-3 8h6Zm14 0-3 8h6Z"/>'
    : key.includes('обж') ? '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6ZM8 12l3 3 5-6"/>'
    : '<rect x="5" y="4" width="14" height="18" rx="2"/><path d="M9 3h6v3H9Zm0 8h6m-6 4h6"/>';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}
function renderSubjectTiles(groups) {
  $('subjectsSection').classList.toggle('hidden', groups.length === 0);
  $('subjectTotal').textContent = countLabel(groups.length, ['предмет', 'предмета', 'предметов']);
  $('subjectTiles').innerHTML = groups.map((group, index) => `<button type="button" class="subject-tile" data-subject-target="subject-group-${index}" aria-label="${escapeHtml(group.subject)} — перейти к заданиям"><span class="subject-tile-icon">${subjectIcon(group.subject)}</span><span><span class="subject-tile-name">${escapeHtml(group.subject)}</span><span class="subject-tile-count">${countLabel(group.tasks.length, ['задание', 'задания', 'заданий'])}</span></span></button>`).join('');
}
function renderWorkload(tasks) {
  const now = new Date();
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + index, 12);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return { date, count: tasks.filter((task) => task.status !== 'done' && task.dueDate === key).length };
  });
  const peak = Math.max(1, ...days.map((day) => day.count));
  const total = days.reduce((sum, day) => sum + day.count, 0);
  const weekDay = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });
  const fullDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
  $('workloadSummary').textContent = countLabel(total, ['задание', 'задания', 'заданий']);
  $('workloadBars').innerHTML = days.map((day, index) => `<div class="workload-day ${day.count ? '' : 'is-empty'} ${index === 0 ? 'is-today' : ''}" role="listitem" aria-label="${fullDate.format(day.date)}: ${countLabel(day.count, ['задание', 'задания', 'заданий'])}"><div class="workload-pillar" aria-hidden="true"><span class="workload-count">${day.count || '·'}</span><span class="workload-column" style="--bar-height:${day.count ? Math.round(26 + day.count / peak * 75) : 12}px"></span></div><span class="workload-label">${index === 0 ? 'сегодня' : weekDay.format(day.date)}</span></div>`).join('');
}
function render() {
  const visible = state.tasks.filter((task) => state.filter === 'all' || task.status === state.filter);
  const groups = groupTasksBySubject(visible);
  $('taskList').innerHTML = groups.map((group, index) => `<section class="subject-group" aria-labelledby="subject-group-${index}"><header class="subject-group-header"><h3 class="task-subject" id="subject-group-${index}">${escapeHtml(group.subject)}</h3><span class="subject-group-count" aria-label="Количество заданий">${group.tasks.length}</span></header><div class="subject-group-tasks">${group.tasks.map(renderTaskRow).join('')}</div></section>`).join('');
  renderSubjectTiles(groups);
  renderWorkload(state.tasks);
  $('emptyState').classList.toggle('hidden', visible.length > 0); $('taskList').classList.toggle('hidden', visible.length === 0);
  const all = state.tasks.length, done = state.tasks.filter((t) => t.status === 'done').length, progress = state.tasks.filter((t) => t.status === 'progress').length, todo = state.tasks.filter((t) => t.status === 'todo').length;
  $('statTotal').textContent = all; $('statDone').textContent = done; $('statOverdue').textContent = state.tasks.filter((t) => t.status !== 'done' && t.dueDate && t.dueDate < isoToday()).length;
  $('countAll').textContent = all; $('countDone').textContent = done; $('countProgress').textContent = progress; $('countTodo').textContent = todo;
  const percent = all ? Math.round(done / all * 100) : 0; $('progressBar').style.width = `${percent}%`; $('progressText').textContent = `${percent}% готово`;
  document.querySelectorAll('.filter').forEach((button) => { button.classList.toggle('active', button.dataset.filter === state.filter); button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter)); });
}
function escapeHtml(value) { return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function isoToday() { return new Date().toISOString().slice(0, 10); }
async function refresh() { const result = await api('/api/tasks'); state.tasks = result.tasks; registerDeadlineTasks(state.tasks); render(); }
function setPhotoPreview(photos, thumbnails = state.photoThumbs) { const preview = $('photoPreview'); const items = photos.slice(0, 20); preview.innerHTML = items.map((photo, index) => `<img src="${escapeHtml(thumbnails[index] || photo)}" alt="Предпросмотр фото" loading="lazy" decoding="async">`).join(''); preview.classList.toggle('hidden', items.length === 0); $('photoHelp').textContent = items.length ? `Прикреплено фото: ${items.length} из 20` : 'Можно выбрать до 20 фото из галереи'; }
function yieldToBrowser() { return new Promise((resolve) => setTimeout(resolve, 0)); }
function compressPhoto(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const source = URL.createObjectURL(file);
    const timer = setTimeout(() => { cleanup(); reject(new Error('Не удалось открыть фото. Выберите файл из галереи ещё раз.')); }, 20000);
    const cleanup = () => { clearTimeout(timer); URL.revokeObjectURL(source); image.onload = null; image.onerror = null; };
    image.decoding = 'async';
    image.onload = async () => {
      clearTimeout(timer);
      try {
        await yieldToBrowser();
        // Keep the original file for the full-size viewer. Re-encoding
        // photographed documents makes small text unreadable. Canvas below
        // is used only for the lightweight card thumbnail.
        const result = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(new Error('Не удалось прочитать изображение'));
          reader.onabort = () => reject(new Error('Чтение фото прервано'));
          reader.readAsDataURL(file);
        });
        let syncPhoto = result;
        if (syncPhoto.length > PHOTO_SYNC_MAX_LENGTH) {
          let size = 2400;
          for (let attempt = 0; attempt < 6 && syncPhoto.length > PHOTO_SYNC_MAX_LENGTH; attempt += 1) {
            const syncCanvas = document.createElement('canvas');
            const scale = Math.min(1, size / Math.max(image.width, image.height));
            syncCanvas.width = Math.max(1, Math.round(image.width * scale));
            syncCanvas.height = Math.max(1, Math.round(image.height * scale));
            syncCanvas.getContext('2d').drawImage(image, 0, 0, syncCanvas.width, syncCanvas.height);
            syncPhoto = syncCanvas.toDataURL('image/jpeg', 0.92 - attempt * 0.03);
            syncCanvas.width = syncCanvas.height = 1;
            size *= 0.86;
            await yieldToBrowser();
          }
        }
        const thumbnailCanvas = document.createElement('canvas');
        const thumbnailScale = Math.min(1, 160 / Math.max(image.width, image.height));
        thumbnailCanvas.width = Math.max(1, Math.round(image.width * thumbnailScale));
        thumbnailCanvas.height = Math.max(1, Math.round(image.height * thumbnailScale));
        thumbnailCanvas.getContext('2d').drawImage(image, 0, 0, thumbnailCanvas.width, thumbnailCanvas.height);
        let thumbnail = thumbnailCanvas.toDataURL('image/jpeg', 0.55);
        while (thumbnail.length > PHOTO_CHUNK_SIZE && thumbnailCanvas.width > 16) {
          const smaller = document.createElement('canvas');
          smaller.width = Math.max(1, Math.floor(thumbnailCanvas.width * 0.7));
          smaller.height = Math.max(1, Math.floor(thumbnailCanvas.height * 0.7));
          smaller.getContext('2d').drawImage(thumbnailCanvas, 0, 0, smaller.width, smaller.height);
          thumbnailCanvas.width = smaller.width; thumbnailCanvas.height = smaller.height;
          thumbnailCanvas.getContext('2d').drawImage(smaller, 0, 0);
          thumbnail = thumbnailCanvas.toDataURL('image/jpeg', 0.5);
          smaller.width = smaller.height = 1;
        }
        thumbnailCanvas.width = 1;
        thumbnailCanvas.height = 1;
        cleanup();
        resolve({ photo: result, syncPhoto, thumbnail });
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    image.onerror = () => { cleanup(); reject(new Error('Не удалось открыть изображение')); };
    image.src = source;
  });
}
async function hydrateTaskPhotos(task) { if (!task || !Array.isArray(task.photoChunks) || taskPhotos(task).length >= task.photoChunks.length || !cloudStorageUsable) return taskPhotos(task || {}); const photos = []; for (let photoIndex = 0; photoIndex < Math.min(task.photoChunks.length, 20); photoIndex += 1) { const photo = await loadChunkedPhoto(task, photoIndex); if (photo.startsWith('data:image/')) photos.push(photo); } task.photos = photos; return photos; }
async function openTaskPhoto(task, index = 0) {
  const directSources = taskPhotoSources(task);
  if (directSources.some(Boolean)) { openPhoto(directSources, index); void migrateTaskMedia(task, taskPhotos(task)); return; }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    task.photos = [];
    const photos = await hydrateTaskPhotos(task);
    const sources = taskPhotoSources({ ...task, photos });
    if (sources.some(Boolean)) { openPhoto(sources, index); void migrateTaskMedia(task, photos); return; }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  alert('Фото ещё синхронизируется. Открой задание через несколько секунд.');
}
async function openModal(task = null) {
  // Media URLs are already ready to display. Do not block editing on legacy
  // chunks, or drop these attachments when adding more photos on another device.
  if (task && taskPhotoSources(task).length < (task.photoChunks?.length || 0)) await hydrateTaskPhotos(task);
  state.editing = task;
  state.photos = taskPhotoSources(task || {});
  state.photoSyncs = state.photos.map((photo, index) => task?.photoSyncs?.[index] || photo);
  state.photoThumbs = state.photos.map((photo, index) => task?.photoThumbs?.[index] || photo);
  $('modalTitle').textContent = task ? 'Изменить задание' : 'Добавить задание';
  const form = $('taskForm');
  form.reset();
  if (task) Object.entries(task).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].value = value; });
  setPhotoPreview(state.photos);
  $('modalBackdrop').classList.remove('hidden');
  setTimeout(() => form.elements.title.focus(), 50);
}
function closeModal() { state.uploadId += 1; state.uploading = false; state.uploadPromise = null; $('photoInput').disabled = false; $('photoInput').value = ''; const submit = $('taskForm').querySelector('[type="submit"]'); submit.disabled = false; submit.textContent = 'Сохранить задание'; $('modalBackdrop').classList.add('hidden'); state.editing = null; state.photos = []; state.photoSyncs = []; state.photoThumbs = []; }
function clampZoom(value) { return Math.min(4, Math.max(1, value)); }
function applyPhotoTransform() { $('photoLightboxImage').style.transform = `translate3d(${viewer.offsetX}px, ${viewer.offsetY}px, 0) scale(${viewer.zoom})`; $('photoZoomReset').textContent = `${viewer.zoom.toFixed(1)}×`; }
function resetPhotoZoom() { viewer.zoom = 1; viewer.offsetX = 0; viewer.offsetY = 0; applyPhotoTransform(); }
function zoomPhoto(step) { viewer.zoom = clampZoom(viewer.zoom + step); if (viewer.zoom === 1) { viewer.offsetX = 0; viewer.offsetY = 0; } applyPhotoTransform(); }
function updatePhotoViewer() { const total = viewer.photos.length; $('photoLightboxImage').src = viewer.photos[viewer.index] || ''; $('photoViewerCount').textContent = `${viewer.index + 1} / ${total}`; $('photoPrev').classList.toggle('hidden', total < 2); $('photoNext').classList.toggle('hidden', total < 2); resetPhotoZoom(); }
function openPhoto(photos, index = 0) { viewer.photos = photos; viewer.index = Math.max(0, Math.min(index, photos.length - 1)); updatePhotoViewer(); $('photoLightbox').classList.remove('hidden'); document.body.classList.add('viewer-open'); }
function closePhoto() { $('photoLightbox').classList.add('hidden'); $('photoLightboxImage').src = ''; viewer.photos = []; viewer.index = 0; resetPhotoZoom(); document.body.classList.remove('viewer-open'); }
function changePhoto(step) { if (viewer.photos.length < 2) return; viewer.index = (viewer.index + step + viewer.photos.length) % viewer.photos.length; updatePhotoViewer(); }
function touchDistance(touches) { const dx = touches[0].clientX - touches[1].clientX; const dy = touches[0].clientY - touches[1].clientY; return Math.hypot(dx, dy); }
async function save(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  try {
    if (state.uploadPromise) await state.uploadPromise;
    const data = Object.fromEntries(new FormData(form));
    data.photos = state.photos.slice(0, 20);
    data.photoSyncs = state.photoSyncs.slice(0, 20);
    data.photoThumbs = state.photoThumbs.slice(0, 20);
    data.photo = data.photos[0] || '';
    submit.disabled = true;
    submit.textContent = 'Сохраняем…';
    const saved = state.editing
      ? await api(`/api/tasks/${state.editing.id}`, { method: 'PATCH', body: JSON.stringify(data) })
      : await api('/api/tasks', { method: 'POST', body: JSON.stringify(data) });
    // Upload originals directly to the media worker. The task remains usable
    // through CloudStorage if the worker is temporarily unavailable.
    if (saved?.id && data.photos.length) {
      submit.textContent = 'Загружаем фото…';
      const mediaUpload = persistMediaUrls(saved.id, data.photos);
      const mediaUrls = await Promise.race([mediaUpload, wait(12000).then(() => null)]);
      if (mediaUrls === null) mediaUpload.catch(() => {});
    }
    closeModal();
    await refresh();
    tg?.HapticFeedback?.notificationOccurred('success');
  } catch (error) {
    submit.disabled = false;
    submit.textContent = 'Сохранить задание';
    alert(error.message || 'Не удалось сохранить задание');
  }
}
async function toggle(task) { const next = task.status === 'done' ? 'todo' : 'done'; await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) }); await refresh(); tg?.HapticFeedback?.impactOccurred('light'); }
async function removeTask(task) {
  if (!window.confirm(`Удалить задание «${task.title}»?`)) return;
  try {
    // Deleting metadata never requires hydrating unrelated photo chunks.
    // The previous all-tasks hydration made deletion hang on an old photo.
    await api(`/api/tasks/${task.id}`, { method: 'DELETE' });
    await photoEngine.remove(task.id);
    state.tasks = state.tasks.filter((item) => item.id !== task.id);
    render();
    tg?.HapticFeedback?.notificationOccurred('success');
  } catch (error) { alert(error.message); }
}
$('todayLabel').textContent = dateFmt.format(new Date()); $('greeting').textContent = user?.first_name ? `${user.first_name}, держим учебу под контролем` : 'Держим учебу под контролем'; $('avatar').textContent = (user?.first_name || 'Д').slice(0, 1).toUpperCase();
$('themeButton').onclick = () => { $('themePanel').classList.toggle('hidden'); $('themeButton').setAttribute('aria-expanded', String(!$('themePanel').classList.contains('hidden'))); };
document.querySelectorAll('[data-theme-choice]').forEach((button) => button.classList.toggle('active', button.dataset.themeChoice === savedTheme));
document.querySelectorAll('[data-theme-choice]').forEach((button) => button.onclick = () => { const theme = button.dataset.themeChoice; document.body.dataset.theme = theme; localStorage.setItem('domashka_theme', theme); document.querySelectorAll('[data-theme-choice]').forEach((item) => item.classList.toggle('active', item === button)); });
$('addBtn').onclick = () => openModal(); $('emptyAddBtn').onclick = () => openModal(); $('closeBtn').onclick = closeModal; $('modalBackdrop').onclick = (event) => { if (event.target === $('modalBackdrop')) closeModal(); }; $('taskForm').onsubmit = save;
$('quickAddBtn').onclick = () => openModal();
$('subjectTiles').onclick = (event) => {
  const target = event.target.closest('[data-subject-target]');
  if (!target) return;
  $(target.dataset.subjectTarget)?.closest('.subject-group')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
};
$('subjectPreset').onchange = (event) => { if (event.target.value) $('subjectInput').value = event.target.value; event.target.value = ''; };
// The visible picker is the native file input itself. Avoid synthetic click()
// plus the enclosing label's activation: Telegram WebView can block or repeat it.
$('photoInput').onchange = async (event) => {
  const input = event.currentTarget;
  const files = Array.from(input.files || []);
  if (!files.length) return;
  if (state.uploading) {
    alert('Подожди, пока завершится обработка уже выбранных фото.');
    return;
  }
  const remaining = 20 - state.photos.length;
  if (remaining <= 0) {
    alert('Уже прикреплено 20 фото — это максимум.');
    return;
  }
  const selected = files.slice(0, remaining);
  if (files.length > remaining) alert(`Можно добавить ещё только ${remaining} фото.`);
  const uploadId = state.uploadId + 1;
  state.uploadId = uploadId;
  state.uploading = true;
  input.disabled = true;
  const uploadPromise = (async () => {
    let failed = 0;
    try {
      for (let index = 0; index < selected.length; index += 1) {
        if (state.uploadId !== uploadId) return;
        $('photoHelp').textContent = `Обрабатываем фото ${index + 1} из ${selected.length}…`;
        await yieldToBrowser();
        let processed;
        try { processed = await compressPhoto(selected[index]); } catch { failed += 1; continue; }
        const { photo, syncPhoto, thumbnail } = processed;
        if (state.uploadId !== uploadId) return;
        state.photos = [...state.photos, photo].slice(0, 20);
        state.photoSyncs = [...state.photoSyncs, syncPhoto].slice(0, 20);
        state.photoThumbs = [...state.photoThumbs, thumbnail].slice(0, 20);
        setPhotoPreview(state.photos);
        await yieldToBrowser();
      }
      if (failed) alert(`Не удалось обработать фото: ${failed}. Остальные фото добавлены.`);
    } catch {
      alert('Не удалось обработать одно из фото. Попробуй выбрать другие изображения.');
    } finally {
      if (state.uploadId === uploadId) {
        state.uploading = false;
        state.uploadPromise = null;
        // Keep the native file references alive until every file has been read.
        input.value = '';
        input.disabled = false;
        setPhotoPreview(state.photos);
      }
    }
  })();
  state.uploadPromise = uploadPromise;
  await uploadPromise;
};
$('photoLightboxClose').onclick = closePhoto; $('photoPrev').onclick = () => changePhoto(-1); $('photoNext').onclick = () => changePhoto(1); $('photoZoomOut').onclick = () => zoomPhoto(-0.25); $('photoZoomIn').onclick = () => zoomPhoto(0.25); $('photoZoomReset').onclick = resetPhotoZoom; $('photoLightbox').onclick = (event) => { if (event.target === $('photoLightbox')) closePhoto(); }; $('photoLightboxImage').ondblclick = () => { if (viewer.zoom === 1) zoomPhoto(1); else resetPhotoZoom(); }; $('photoLightboxImage').onwheel = (event) => { event.preventDefault(); zoomPhoto(event.deltaY < 0 ? 0.25 : -0.25); }; $('photoLightbox').ontouchstart = (event) => { if (event.touches.length === 2) { viewer.wasPinching = true; viewer.pinchStartDistance = touchDistance(event.touches); viewer.pinchStartZoom = viewer.zoom; } else { viewer.touchStartX = event.touches[0].clientX; viewer.touchStartY = event.touches[0].clientY; viewer.wasPinching = false; } }; $('photoLightbox').ontouchmove = (event) => { if (event.touches.length === 2) { event.preventDefault(); viewer.zoom = clampZoom(viewer.pinchStartZoom * (touchDistance(event.touches) / viewer.pinchStartDistance)); if (viewer.zoom === 1) { viewer.offsetX = 0; viewer.offsetY = 0; } applyPhotoTransform(); } else if (viewer.zoom > 1 && !viewer.wasPinching) { event.preventDefault(); viewer.offsetX += event.touches[0].clientX - viewer.touchStartX; viewer.offsetY += event.touches[0].clientY - viewer.touchStartY; viewer.touchStartX = event.touches[0].clientX; viewer.touchStartY = event.touches[0].clientY; applyPhotoTransform(); } }; $('photoLightbox').ontouchend = (event) => { if (viewer.wasPinching) { viewer.wasPinching = false; return; } const distance = event.changedTouches[0].clientX - viewer.touchStartX; if (viewer.zoom === 1 && Math.abs(distance) >= 48) changePhoto(distance < 0 ? 1 : -1); }; window.addEventListener('keydown', (event) => { if (event.key === 'Escape') closePhoto(); if (event.key === 'ArrowLeft') changePhoto(-1); if (event.key === 'ArrowRight') changePhoto(1); if (event.key === '+' || event.key === '=') zoomPhoto(0.25); if (event.key === '-') zoomPhoto(-0.25); });
document.querySelectorAll('.filter').forEach((button) => button.onclick = () => { state.filter = button.dataset.filter; render(); });
$('taskList').onclick = async (event) => { const card = event.target.closest('.task-card'); const task = state.tasks.find((item) => item.id === Number(card?.dataset.id)); if (!task) return; const actionTarget = event.target.closest('[data-action]'); const action = actionTarget?.dataset.action; if (action === 'toggle') await toggle(task); if (action === 'view-photo') await openTaskPhoto(task, Number(actionTarget.dataset.photoIndex || 0)); if (action === 'edit') await openModal(task); if (action === 'delete' && task.status !== 'done') await removeTask(task); };
setInterval(() => { if (!cloudStorage || syncInFlight) return; const pending = localStorage.getItem(pendingKey); if (pending) { try { const tasks = pending === '1' ? (tasksCache || photoEngine.restore(JSON.parse(localStorage.getItem(localKey) || '[]'))) : JSON.parse(pending); Promise.resolve(tasks).then(queueCloudSync).catch((error) => console.warn(error.message)); } catch (error) { console.warn(error.message); } } }, 5000);
refresh().catch((error) => { console.error(error); $('emptyState').classList.remove('hidden'); });
setInterval(flushDeadlineOutbox, 30000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void flushDeadlineOutbox(); });
