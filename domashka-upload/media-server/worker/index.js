const MAX_MEDIA_BYTES = 30 * 1024 * 1024;
const MAX_INDEX = 20;
const MEDIA_PREFIX = 'media';
const allowedContentTypes = /^(image|video|audio)\//i;

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  const allowed = origin === 'https://domashka-mini-app.sparklesgrc.chatgpt.site'
    || origin === 'http://localhost:3000';
  return {
    'Access-Control-Allow-Origin': allowed ? origin : '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-User-Id, X-Telegram-Init-Data, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, ETag, Accept-Ranges',
    'Vary': 'Origin',
  };
}

function response(body, init, request) {
  return new Response(body, { ...init, headers: { ...corsHeaders(request), ...(init?.headers || {}) } });
}

function json(value, status, request) {
  return response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }, request);
}

async function verifyReminderUser(request, env) {
  const raw = request.headers.get('X-Telegram-Init-Data') || '';
  if (!env.BOT_TOKEN || !env.REMINDER_CHAT_ID || !raw || raw.length > 16000) return null;
  const params = new URLSearchParams(raw);
  if (new Set([...params.keys()]).size !== [...params.keys()].length) return null;
  const hash = params.get('hash') || '';
  if (!/^[a-f0-9]{64}$/i.test(hash)) return null;
  const age = Date.now() / 1000 - Number(params.get('auth_date'));
  if (!Number.isFinite(age) || age < -300 || age > 86400) return null;
  params.delete('hash');
  const encoder = new TextEncoder();
  const hmac = async (key, value) => {
    const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return crypto.subtle.sign('HMAC', imported, encoder.encode(value));
  };
  const secret = await hmac(encoder.encode('WebAppData'), env.BOT_TOKEN);
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const data = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, value]) => `${name}=${value}`).join('\n');
  const valid = await crypto.subtle.verify('HMAC', key, Uint8Array.from(hash.match(/../g), (value) => parseInt(value, 16)), encoder.encode(data));
  if (!valid) return null;
  try {
    const id = String(JSON.parse(params.get('user') || '{}').id || '');
    return id === String(env.REMINDER_CHAT_ID) ? id : null;
  } catch { return null; }
}

function reminderTaskMetadata(input) {
  const id = String(input?.id || '');
  if (!/^\d{1,20}$/.test(id)) throw new Error('Некорректный номер задания');
  const dueDate = String(input.dueDate || '');
  if (dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(Date.parse(`${dueDate}T00:00:00Z`)) || new Date(`${dueDate}T00:00:00Z`).toISOString().slice(0, 10) !== dueDate)) throw new Error('Некорректная дата');
  return { id, title: String(input.title || 'Домашнее задание').trim().slice(0, 120), subject: String(input.subject || '').trim().slice(0, 40), dueDate, status: ['todo', 'progress', 'done'].includes(input.status) ? input.status : 'todo' };
}

async function updateReminderTask(env, userId, id, mode, changes = {}, seed = {}) {
  const key = `reminder-tasks/${userId}/${id}.json`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const object = await env.MEDIA.get(key);
    const current = object ? await object.json() : null;
    // Loading an older device must not undo completion or resurrect a deletion.
    if (current && (mode === 'bootstrap' || current.deleted)) return current;
    const next = mode === 'delete'
      ? { id, userId, deleted: true, updatedAt: new Date().toISOString() }
      : { ...reminderTaskMetadata({ ...(current || seed), ...changes, id }), userId, updatedAt: new Date().toISOString() };
    const onlyIf = new Headers(object ? { 'If-Match': object.httpEtag } : { 'If-None-Match': '*' });
    const saved = await env.MEDIA.put(key, JSON.stringify(next), { onlyIf, httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } });
    if (saved) return next;
  }
  throw new Error('Задание обновляется с другого устройства. Повторите запрос.');
}

async function listReminderTasks(env, id) {
  const prefix = `reminder-tasks/${env.REMINDER_CHAT_ID}/`;
  if (id) {
    const record = await env.MEDIA.get(`${prefix}${id}.json`);
    const task = record ? await record.json() : null;
    return task && !task.deleted ? [task] : [];
  }
  const tasks = [];
  let cursor;
  do {
    const page = await env.MEDIA.list({ prefix, limit: 100, ...(cursor ? { cursor } : {}) });
    for (let index = 0; index < page.objects.length; index += 4) {
      const records = await Promise.all(page.objects.slice(index, index + 4).map(async ({ key }) => {
        const object = await env.MEDIA.get(key);
        return object ? object.json() : null;
      }));
      tasks.push(...records.filter((task) => task && !task.deleted));
    }
    cursor = page.truncated ? page.cursor : null;
  } while (cursor);
  return tasks;
}

async function reminderTasksApi(request, env, url) {
  if (!env.MEDIA) return json({ error: 'Хранилище недоступно' }, 503, request);
  const match = url.pathname.match(/^\/v1\/reminder-tasks(?:\/(\d{1,20}))?$/);
  if (!match) return json({ error: 'Маршрут не найден' }, 404, request);
  try {
    if (request.method === 'GET') {
      if (!env.DEADLINE_SERVICE_KEY || request.headers.get('X-Reminder-Service-Key') !== env.DEADLINE_SERVICE_KEY) return json({ error: 'Доступ запрещён' }, 403, request);
      const id = url.searchParams.get('id');
      if (id && !/^\d{1,20}$/.test(id)) return json({ error: 'Некорректный номер задания' }, 400, request);
      return json({ tasks: await listReminderTasks(env, id) }, 200, request);
    }
    const userId = await verifyReminderUser(request, env);
    if (!userId) return json({ error: 'Откройте приложение через Telegram для настройки напоминаний' }, 401, request);
    if (request.method === 'DELETE' && match[1]) {
      await updateReminderTask(env, userId, match[1], 'delete');
      return json({ ok: true }, 200, request);
    }
    const raw = await request.text();
    if (raw.length > 200000) return json({ error: 'Слишком большой запрос' }, 413, request);
    const input = JSON.parse(raw || '{}');
    if (request.method === 'POST' && !match[1] && Array.isArray(input.tasks) && input.tasks.length <= 100) {
      const tasks = input.tasks.map(reminderTaskMetadata);
      for (let index = 0; index < tasks.length; index += 4) await Promise.all(tasks.slice(index, index + 4).map((task) => updateReminderTask(env, userId, task.id, 'bootstrap', task, task)));
      return json({ ok: true, registered: tasks.length }, 200, request);
    }
    if (request.method === 'PATCH' && match[1]) {
      const changes = Object.fromEntries(Object.entries(input.changes || {}).filter(([key]) => ['title', 'subject', 'dueDate', 'status'].includes(key)));
      await updateReminderTask(env, userId, match[1], 'patch', changes, input.seed || {});
      return json({ ok: true }, 200, request);
    }
    return json({ error: 'Некорректный запрос' }, 400, request);
  } catch (error) { return json({ error: error.message || 'Не удалось обновить напоминание' }, 400, request); }
}

function route(request) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 5 || parts[0] !== 'v1' || parts[1] !== 'media') return null;
  const userId = decodeURIComponent(parts[2]);
  const taskId = decodeURIComponent(parts[3]);
  const photoIndex = Number(parts[4]);
  if (!/^\d+$/.test(userId) || !/^\d+$/.test(taskId) || !Number.isInteger(photoIndex) || photoIndex < 0 || photoIndex >= MAX_INDEX) return null;
  return { userId, taskId, photoIndex, key: `${MEDIA_PREFIX}/${userId}/${taskId}/${photoIndex}` };
}

function parseRange(value, size) {
  if (!value || !value.startsWith('bytes=') || !Number.isFinite(size)) return null;
  const match = value.slice(6).split(',')[0].trim().match(/^(\d*)-(\d*)$/);
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2] || 0));
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) return null;
  end = Math.min(end, size - 1);
  return { start, end, length: end - start + 1 };
}

async function readMedia(request, env, match) {
  const object = await env.MEDIA.get(match.key);
  if (!object) return json({ error: 'Медиафайл не найден' }, 404, request);
  const requestedRange = parseRange(request.headers.get('Range'), object.size);
  const rangeObject = requestedRange ? await env.MEDIA.get(match.key, { range: { offset: requestedRange.start, length: requestedRange.length } }) : object;
  const headers = {
    'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'ETag': object.httpEtag,
    'Accept-Ranges': 'bytes',
    'Content-Length': String(requestedRange?.length || object.size),
  };
  if (requestedRange) {
    headers['Content-Range'] = `bytes ${requestedRange.start}-${requestedRange.end}/${object.size}`;
    return response(request.method === 'HEAD' ? null : rangeObject.body, { status: 206, headers }, request);
  }
  return response(request.method === 'HEAD' ? null : object.body, { status: 200, headers }, request);
}

async function putMedia(request, env, match) {
  const claimedUser = String(request.headers.get('X-Telegram-User-Id') || '');
  if (claimedUser !== match.userId) return json({ error: 'Неверный пользователь' }, 403, request);
  const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
  const length = Number(request.headers.get('Content-Length') || 0);
  if (!allowedContentTypes.test(contentType) || (length && length > MAX_MEDIA_BYTES)) return json({ error: 'Неподдерживаемый или слишком большой файл' }, 413, request);
  const body = await request.arrayBuffer();
  if (!body.byteLength || body.byteLength > MAX_MEDIA_BYTES) return json({ error: 'Файл пустой или слишком большой' }, 413, request);
  await env.MEDIA.put(match.key, body, {
    httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { userId: match.userId, taskId: match.taskId, photoIndex: String(match.photoIndex) },
  });
  const url = new URL(request.url);
  url.search = `?v=${Date.now()}`;
  return json({ ok: true, url: url.toString() }, 201, request);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return response(null, { status: 204 }, request);
    const url = new URL(request.url);
    if (url.pathname.startsWith('/v1/reminder-tasks')) return reminderTasksApi(request, env, url);
    if (url.pathname === '/health') return json({ ok: true, service: 'domashka-media' }, 200, request);
    const match = route(request);
    if (!match) return json({ error: 'Маршрут не найден' }, 404, request);
    if (!env.MEDIA) return json({ error: 'Хранилище медиа не подключено' }, 503, request);
    try {
      if (request.method === 'PUT') return await putMedia(request, env, match);
      if (request.method === 'GET' || request.method === 'HEAD') return await readMedia(request, env, match);
      if (request.method === 'DELETE') {
        const claimedUser = String(request.headers.get('X-Telegram-User-Id') || '');
        if (claimedUser !== match.userId) return json({ error: 'Неверный пользователь' }, 403, request);
        await env.MEDIA.delete(match.key);
        return response(null, { status: 204 }, request);
      }
      return json({ error: 'Метод не поддерживается' }, 405, request);
    } catch (error) {
      return json({ error: error?.message || 'Ошибка медиа-сервера' }, 500, request);
    }
  },
};
