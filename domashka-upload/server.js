import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const DATA_FILE = join(ROOT, 'data.json');

function loadEnv() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const raw = requireFile(envPath);
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

// Synchronous only during boot, so the rest of the server can stay async.
function requireFile(path) {
  return readFileSync(path, 'utf8');
}

loadEnv();
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_ID = String(process.env.ADMIN_ID || '');
const MINI_APP_URL = process.env.MINI_APP_URL || `http://localhost:${PORT}`;

const DEFAULT_DATA = { tasks: [], nextId: 1 };
let db = DEFAULT_DATA;

async function loadData() {
  try {
    db = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  } catch {
    db = structuredClone(DEFAULT_DATA);
    await saveData();
  }
}

let saveTimer;
async function saveData() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeFile(DATA_FILE, JSON.stringify(db, null, 2)), 100);
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 30_000_000) reject(new Error('Payload too large'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function userId(req, url) {
  return String(req.headers['x-telegram-user-id'] || url.searchParams.get('userId') || ADMIN_ID || 'local');
}

function taskForUser(task, id) {
  return task.userId === id || (id === ADMIN_ID && task.userId === ADMIN_ID);
}

function cleanTask(input, current = {}) {
  const title = String(input.title ?? current.title ?? '').trim().slice(0, 120);
  const subject = String(input.subject ?? current.subject ?? 'Другое').trim().slice(0, 40);
  const dueDate = String(input.dueDate ?? current.dueDate ?? '').slice(0, 10);
  const priority = ['low', 'medium', 'high'].includes(input.priority) ? input.priority : (current.priority || 'medium');
  const status = ['todo', 'progress', 'done'].includes(input.status) ? input.status : (current.status || 'todo');
  const rawPhotos = Array.isArray(input.photos) ? input.photos : (typeof input.photo === 'string' ? [input.photo] : (current.photos || (current.photo ? [current.photo] : [])));
  const rawMediaUrls = Array.isArray(input.mediaUrls) ? input.mediaUrls : (current.mediaUrls || []);
  // Keep the original data URL. Image quality must not depend on the API
  // round trip; the Mini App handles transfer copies separately when needed.
  const photos = rawPhotos.filter((photo) => typeof photo === 'string' && photo.startsWith('data:image/')).slice(0, 20);
  const mediaUrls = rawMediaUrls.filter((url) => typeof url === 'string' && /^https:\/\//.test(url)).slice(0, 20);
  if (!title) throw new Error('Название задания обязательно');
  return { title, subject: subject || 'Другое', dueDate, priority, status, photos, mediaUrls, photo: photos[0] || '' };
}

async function api(req, res, url) {
  const id = userId(req, url);
  if (url.pathname === '/api/health') return json(res, 200, { ok: true, bot: Boolean(BOT_TOKEN), admin: ADMIN_ID || null });
  if (!url.pathname.startsWith('/api/')) return false;

  try {
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      const tasks = db.tasks.filter((task) => taskForUser(task, id)).sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
      return json(res, 200, { tasks, userId: id });
    }
    if (req.method === 'GET' && url.pathname === '/api/stats') {
      const tasks = db.tasks.filter((task) => taskForUser(task, id));
      const done = tasks.filter((task) => task.status === 'done').length;
      const progress = tasks.filter((task) => task.status === 'progress').length;
      const overdue = tasks.filter((task) => task.status !== 'done' && task.dueDate && task.dueDate < new Date().toISOString().slice(0, 10)).length;
      return json(res, 200, { total: tasks.length, done, progress, overdue });
    }
    if (req.method === 'POST' && url.pathname === '/api/tasks') {
      const input = await body(req);
      const task = { id: db.nextId++, userId: id, ...cleanTask(input), createdAt: new Date().toISOString() };
      db.tasks.push(task); await saveData();
      return json(res, 201, task);
    }
    const match = url.pathname.match(/^\/api\/tasks\/(\d+)$/);
    if (match) {
      const task = db.tasks.find((item) => item.id === Number(match[1]) && taskForUser(item, id));
      if (!task) return json(res, 404, { error: 'Задание не найдено' });
      if (req.method === 'PATCH') {
        const input = await body(req);
        Object.assign(task, cleanTask(input, task), { updatedAt: new Date().toISOString() });
        await saveData(); return json(res, 200, task);
      }
      if (req.method === 'DELETE') {
        db.tasks = db.tasks.filter((item) => item.id !== task.id); await saveData();
        return json(res, 204, {});
      }
    }
    return json(res, 404, { error: 'Маршрут не найден' });
  } catch (error) {
    return json(res, 400, { error: error.message || 'Ошибка запроса' });
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
async function serveStatic(req, res, url) {
  let requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = normalize(join(PUBLIC_DIR, requested));
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Forbidden' });
  try {
    const content = await readFile(file);
    const isHtml = extname(file) === '.html';
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable' });
    res.end(content);
  } catch {
    json(res, 404, { error: 'Файл не найден' });
  }
}

async function telegram(method, payload = {}) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

async function startBot() {
  if (!BOT_TOKEN) { console.warn('BOT_TOKEN is missing; bot polling is disabled'); return; }
  try {
    await telegram('deleteWebhook', { drop_pending_updates: false });
    await telegram('setMyCommands', { commands: [{ command: 'start', description: 'Открыть дневник заданий' }, { command: 'today', description: 'Задания на сегодня' }, { command: 'help', description: 'Как пользоваться' }] });
    if (MINI_APP_URL.startsWith('https://')) {
      await telegram('setChatMenuButton', { chat_id: ADMIN_ID ? Number(ADMIN_ID) : undefined, menu_button: { type: 'web_app', text: 'Домашка', web_app: { url: MINI_APP_URL } } });
    } else {
      console.warn('MINI_APP_URL is local; Telegram Web App buttons require an HTTPS URL.');
    }
    console.log(`Telegram bot connected; Mini App URL: ${MINI_APP_URL}`);
  } catch (error) { console.error('Telegram setup failed:', error.message); }

  let offset = 0;
  const poll = async () => {
    try {
      const updates = await telegram('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
      for (const update of updates) {
        offset = update.update_id + 1;
        const message = update.message;
        if (!message?.chat?.id) continue;
        const chatId = message.chat.id;
        const text = message.text || '';
        if (text.startsWith('/start')) {
          const payload = { chat_id: chatId, text: `Привет! Здесь можно быстро записать домашние задания, расставить приоритеты и отмечать выполненное.\n\nЛокальный адрес мини‑апп: ${MINI_APP_URL}` };
          if (MINI_APP_URL.startsWith('https://')) payload.reply_markup = { inline_keyboard: [[{ text: 'Открыть дневник', web_app: { url: MINI_APP_URL } }]] };
          await telegram('sendMessage', payload);
        } else if (text.startsWith('/today')) {
          const today = new Date().toISOString().slice(0, 10);
          const tasks = db.tasks.filter((task) => task.userId === String(chatId) && task.dueDate === today && task.status !== 'done');
          await telegram('sendMessage', { chat_id: chatId, text: tasks.length ? `На сегодня:\n${tasks.map((task) => `• ${task.title} — ${task.subject}`).join('\n')}` : 'На сегодня заданий нет 🎉' });
        } else if (text.startsWith('/help')) {
          await telegram('sendMessage', { chat_id: chatId, text: 'Нажми «Домашка» в меню бота, чтобы открыть мини‑приложение. Добавляй задания, выбирай срок и отмечай готовность.' });
        }
      }
    } catch (error) { console.error('Telegram polling:', error.message); }
    setTimeout(poll, 500);
  };
  poll();
}

await loadData();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) { await api(req, res, url); return; }
  if (req.method === 'GET') { await serveStatic(req, res, url); return; }
  json(res, 405, { error: 'Method not allowed' });
});

server.listen(PORT, () => {
  console.log(`Mini App running at ${MINI_APP_URL}`);
  console.log(`Admin ID: ${ADMIN_ID || 'not set'}`);
  startBot();
});
