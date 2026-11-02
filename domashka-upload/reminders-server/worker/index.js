const REMINDER_TEXT = 'не забудь внести домашнее задание';
const REMINDER_TIMEZONE = 'Europe/Moscow';
const reminderRuns = new Map();

function reminderClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: REMINDER_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

async function reminderTelegram(env, method, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal: controller.signal,
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.description || 'Telegram отклонил запрос');
    return result.result;
  } finally { clearTimeout(timer); }
}

async function sendHomeworkReminder(env, { dry_run = false } = {}) {
  if (!env.BOT_TOKEN || !env.REMINDER_CHAT_ID || !env.REMINDERS) throw new Error('Напоминание не настроено');
  const clock = reminderClock();
  if (dry_run) {
    await reminderTelegram(env, 'getChat', { chat_id: env.REMINDER_CHAT_ID });
    return { status: 'ready', text: REMINDER_TEXT, time: '17:00', timezone: REMINDER_TIMEZONE, message_sent: false };
  }
  // A late or manually triggered task must not send a surprise night message.
  if (clock.hour !== 17) return { status: 'outside_delivery_window', day: clock.day, timezone: REMINDER_TIMEZONE };
  if (reminderRuns.has(clock.day)) return reminderRuns.get(clock.day);
  const run = (async () => {
    const key = `reminders/homework/${env.REMINDER_CHAT_ID}/${clock.day}.json`;
    const receipt = await env.REMINDERS.get(key);
    if (receipt) return { status: 'already_sent', day: clock.day };
    const message = await reminderTelegram(env, 'sendMessage', { chat_id: env.REMINDER_CHAT_ID, text: REMINDER_TEXT });
    await env.REMINDERS.put(key, JSON.stringify({ day: clock.day, messageId: message.message_id, sentAt: new Date().toISOString() }), {
      httpMetadata: { contentType: 'application/json' },
    });
    return { status: 'sent', day: clock.day, message_id: message.message_id };
  })();
  reminderRuns.set(clock.day, run);
  try { return await run; } finally { reminderRuns.delete(clock.day); }
}

const DEADLINE_TEXTS = { 2: 'до сдачи Д/З осталось 2 дня', 1: 'до сдачи Д/З остался 1 день' };
function remainingDays(dueDate, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate || '')) return NaN;
  return (Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000;
}
async function deadlineTasks(env, taskId = '') {
  if (!env.DEADLINE_SOURCE_URL || !env.DEADLINE_SERVICE_KEY) throw new Error('Источник сроков не настроен');
  const url = new URL('/v1/reminder-tasks', env.DEADLINE_SOURCE_URL);
  if (taskId) url.searchParams.set('id', taskId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url.toString(), { headers: { 'X-Reminder-Service-Key': env.DEADLINE_SERVICE_KEY }, signal: controller.signal, redirect: 'manual' });
    if (!response.ok) throw new Error('Не удалось получить актуальные сроки заданий');
    const result = await response.json();
    if (!Array.isArray(result.tasks)) throw new Error('Некорректный список сроков');
    return result.tasks;
  } finally { clearTimeout(timer); }
}
function deadlineMessage(task, days) {
  const due = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: REMINDER_TIMEZONE }).format(new Date(`${task.dueDate}T12:00:00Z`));
  return `${DEADLINE_TEXTS[days]}\n\n${task.subject ? `${task.subject} — ` : ''}${task.title}\nСрок: ${due}`;
}
async function sendDeadlineReminders(env, { dry_run = false } = {}) {
  if (!env.BOT_TOKEN || !env.REMINDER_CHAT_ID || !env.REMINDERS) throw new Error('Напоминания не настроены');
  const clock = reminderClock();
  if (!dry_run && clock.hour !== 17) return { status: 'outside_delivery_window', day: clock.day };
  const tasks = await deadlineTasks(env);
  const eligible = tasks.filter((task) => !task.deleted && task.status !== 'done' && [1, 2].includes(remainingDays(task.dueDate, clock.day)));
  if (dry_run) {
    await reminderTelegram(env, 'getChat', { chat_id: env.REMINDER_CHAT_ID });
    return { status: 'ready', registered: tasks.length, eligible: eligible.length, time: '17:00', timezone: REMINDER_TIMEZONE, message_sent: false };
  }
  let sent = 0, skipped = 0;
  const errors = [];
  for (const task of eligible) {
    const days = remainingDays(task.dueDate, clock.day);
    const key = `reminders/deadlines/${env.REMINDER_CHAT_ID}/${task.id}/${task.dueDate}-${days}.json`;
    const lock = await env.REMINDERS.put(key, JSON.stringify({ state: 'pending', startedAt: new Date().toISOString() }), {
      onlyIf: new Headers({ 'If-None-Match': '*' }), httpMetadata: { contentType: 'application/json' },
    });
    if (!lock) { skipped += 1; continue; }
    let sendAttempted = false;
    try {
      // Re-read after claiming this notification: another device may have just
      // completed, deleted or rescheduled the homework.
      const latest = (await deadlineTasks(env, task.id)).find((item) => String(item.id) === String(task.id));
      if (!latest || latest.deleted || latest.status === 'done' || latest.dueDate !== task.dueDate) {
        await env.REMINDERS.delete(key); skipped += 1; continue;
      }
      sendAttempted = true;
      const message = await reminderTelegram(env, 'sendMessage', { chat_id: env.REMINDER_CHAT_ID, text: deadlineMessage(latest, days) });
      await env.REMINDERS.put(key, JSON.stringify({ state: 'sent', messageId: message.message_id, sentAt: new Date().toISOString() }), { httpMetadata: { contentType: 'application/json' } });
      sent += 1;
    } catch (error) {
      if (!sendAttempted) await env.REMINDERS.delete(key);
      errors.push({ taskId: task.id, error: error.message });
    }
  }
  return { status: errors.length ? 'partial' : 'checked', day: clock.day, sent, skipped, errors };
}
async function sendDeadlineTest(env, requestId) {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId || '')) throw new Error('Некорректный номер проверки');
  const key = `reminders/tests/${env.REMINDER_CHAT_ID}/${requestId}.json`;
  const lock = await env.REMINDERS.put(key, JSON.stringify({ state: 'pending' }), { onlyIf: new Headers({ 'If-None-Match': '*' }), httpMetadata: { contentType: 'application/json' } });
  if (!lock) return { status: 'already_sent' };
  const text = 'Проверка напоминаний ✅\n\nдо сдачи Д/З осталось 2 дня\n\nЗа день до срока придёт повторное сообщение, если задание не отмечено как «Готово».';
  const message = await reminderTelegram(env, 'sendMessage', { chat_id: env.REMINDER_CHAT_ID, text });
  await env.REMINDERS.put(key, JSON.stringify({ state: 'sent', messageId: message.message_id, sentAt: new Date().toISOString() }), { httpMetadata: { contentType: 'application/json' } });
  return { status: 'sent', message_id: message.message_id };
}


// This service is owner-private in Sites. Dispatch verifies the owner or
// a Sites service token before this worker is reached; it has no public entry.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return Response.json({ok: true, service: 'domashka-reminders'});
    if (request.method !== 'POST' || !['/reminders/homework', '/reminders/deadlines', '/reminders/deadlines/test'].includes(url.pathname)) return Response.json({error: 'Not found'}, {status: 404});
    try {
      const input = await request.json();
      if (url.pathname === '/reminders/deadlines/test') {
        if (Object.keys(input).some((key) => key !== 'request_id')) return Response.json({error: 'Invalid request'}, {status: 400});
        return Response.json(await sendDeadlineTest(env, input.request_id));
      }
      if (Object.keys(input).some(key => key !== 'dry_run') || (input.dry_run !== undefined && typeof input.dry_run !== 'boolean')) return Response.json({error: 'Invalid request'}, {status: 400});
      return Response.json(url.pathname === '/reminders/deadlines' ? await sendDeadlineReminders(env, input) : await sendHomeworkReminder(env, input));
    } catch (error) { return Response.json({error: error.message || 'Reminder failed'}, {status: 502}); }
  },
};
