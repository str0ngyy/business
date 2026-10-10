#!/usr/bin/env node
/**
 * Push-уведомления на телефон из хуков Claude Code.
 *
 * События:
 *   UserPromptSubmit — запоминает, когда началась задача (ничего не отправляет);
 *   Stop             — «Готово», если задача шла дольше порога;
 *   Notification     — «Нужно решение»: запрос разрешения или вопрос посреди задачи;
 *   StopFailure      — «Остановился с ошибкой»: лимит использования, сбой API.
 *
 * Каналы: приложение ntfy и/или Telegram-бот. Настройки берутся из переменных окружения,
 * а если их нет — из ~/.claude/notify.env (его создаёт мастер notify-setup.mjs).
 *
 * Без зависимостей, Node 18+. В режиме хука всегда завершается с кодом 0:
 * сбой уведомления не должен мешать работе Claude.
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CLAUDE_DIR = path.join(os.homedir(), '.claude');
export const CONFIG_FILE = path.join(CLAUDE_DIR, 'notify.env');
export const STATE_DIR = path.join(CLAUDE_DIR, 'notify-state');
export const LOG_FILE = path.join(STATE_DIR, 'notify.log');
const LOCK_DIR = path.join(STATE_DIR, 'locks');

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const STATE_TTL_MS = 7 * DAY_MS;
const HTTP_TIMEOUT_MS = 15_000;
const LOG_MAX_BYTES = 256 * 1024;
const SUMMARY_MAX_CHARS = 320;
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
const DEFAULT_MIN_SECONDS = 60;

let debugEnabled = false;

// ─── Настройки ──────────────────────────────────────────────────────────────

/** Читает файл вида KEY=VALUE. Комментарии и пустые строки пропускаются. */
export function readEnvFile(file = CONFIG_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
    if (quoted) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

const isOn = (value) => /^(1|true|yes|on)$/i.test(value);
const isOff = (value) => /^(0|false|no|off)$/i.test(value);

/** Переменные окружения важнее файла: так удобно настраивать облачные сессии. */
export function loadConfig(env = process.env) {
  const file = readEnvFile();
  const get = (key, fallback = '') => String(env[key] || file[key] || fallback).trim();
  const minSeconds = Number.parseFloat(get('CLAUDE_NOTIFY_MIN_SECONDS', String(DEFAULT_MIN_SECONDS)));

  return {
    disabled: isOn(get('CLAUDE_NOTIFY_DISABLED')),
    debug: isOn(get('CLAUDE_NOTIFY_DEBUG')),
    minSeconds: Number.isFinite(minSeconds) && minSeconds >= 0 ? minSeconds : DEFAULT_MIN_SECONDS,
    includeSummary: !isOff(get('CLAUDE_NOTIFY_INCLUDE_SUMMARY')),
    telegram: {
      token: get('CLAUDE_NOTIFY_TELEGRAM_TOKEN'),
      chatId: get('CLAUDE_NOTIFY_TELEGRAM_CHAT_ID'),
      apiBase: get('CLAUDE_NOTIFY_TELEGRAM_API', 'https://api.telegram.org').replace(/\/+$/, ''),
    },
    ntfy: {
      server: get('CLAUDE_NOTIFY_NTFY_SERVER', 'https://ntfy.sh').replace(/\/+$/, ''),
      topic: get('CLAUDE_NOTIFY_NTFY_TOPIC'),
      token: get('CLAUDE_NOTIFY_NTFY_TOKEN'),
    },
  };
}

// ─── Каналы доставки ────────────────────────────────────────────────────────

const PROVIDERS = [
  {
    name: 'ntfy',
    isConfigured: (config) => Boolean(config.ntfy.topic),
    send: sendNtfy,
  },
  {
    name: 'Telegram',
    isConfigured: (config) => Boolean(config.telegram.token && config.telegram.chatId),
    send: sendTelegram,
  },
];

export function configuredProviders(config) {
  return PROVIDERS.filter((provider) => provider.isConfigured(config));
}

/** Отправляет во все настроенные каналы параллельно. Ошибка одного не мешает другим. */
export async function sendAll(config, notification) {
  return Promise.all(
    configuredProviders(config).map(async (provider) => {
      try {
        await provider.send(config, notification);
        log(`sent ${notification.kind} via ${provider.name}: ${notification.title}`);
        return { provider: provider.name, ok: true };
      } catch (error) {
        log(`error ${provider.name}: ${error.message}`);
        return { provider: provider.name, ok: false, error: error.message };
      }
    }),
  );
}

export async function sendTest(config = loadConfig()) {
  return sendAll(config, {
    kind: 'test',
    emoji: '🔔',
    tag: 'bell',
    priority: 3,
    title: 'Тест · уведомления Claude Code',
    body: 'Всё настроено. Когда Claude закончит задачу или ему понадобится решение, сообщение придёт сюда.',
  });
}

/** Вызов Bot API. Нужен и хуку, и мастеру настройки (getMe, getUpdates). */
export async function telegramCall(telegram, method, payload = {}) {
  const response = await postJson(`${telegram.apiBase}/bot${telegram.token}/${method}`, payload);
  let data = null;
  try {
    data = JSON.parse(response.text);
  } catch {
    // Ниже покажем сырой ответ.
  }
  if (!response.ok || !data?.ok) {
    const reason = data?.description || response.text.slice(0, 200) || 'пустой ответ';
    throw new Error(`Telegram ${response.status}: ${reason}`);
  }
  return data.result;
}

async function sendTelegram(config, notification) {
  const lines = [`${notification.emoji} <b>${escapeHtml(notification.title)}</b>`];
  if (notification.body) lines.push(escapeHtml(notification.body));

  const payload = {
    chat_id: config.telegram.chatId,
    text: lines.join('\n'),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  };
  if (notification.url) {
    payload.reply_markup = { inline_keyboard: [[{ text: 'Открыть сессию', url: notification.url }]] };
  }
  await telegramCall(config.telegram, 'sendMessage', payload);
}

async function sendNtfy(config, notification) {
  // JSON-публикация в корень сервера: в заголовках HTTP кириллица ломается, в теле — нет.
  const payload = {
    topic: config.ntfy.topic,
    title: notification.title,
    message: notification.body || notification.title,
    tags: [notification.tag],
    priority: notification.priority ?? 3,
  };
  if (notification.url) payload.click = notification.url;

  const headers = config.ntfy.token ? { Authorization: `Bearer ${config.ntfy.token}` } : {};
  const response = await postJson(`${config.ntfy.server}/`, payload, headers);
  if (!response.ok) {
    throw new Error(`ntfy ${response.status}: ${response.text.slice(0, 200) || 'пустой ответ'}`);
  }
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

async function postJson(url, payload, headers = {}) {
  const body = JSON.stringify(payload);
  const allHeaders = { 'Content-Type': 'application/json', ...headers };

  // Встроенный fetch игнорирует HTTPS_PROXY, а curl его учитывает. За прокси
  // (облачные сессии, корпоративные сети) сразу идём через curl.
  if (typeof fetch === 'function' && !proxyConfigured()) {
    try {
      return await fetchPost(url, body, allHeaders);
    } catch (error) {
      if (!curlAvailable()) throw new Error(describeNetworkError(error));
    }
  }
  return curlPost(url, body, allHeaders);
}

function proxyConfigured() {
  return ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'].some((key) => process.env[key]);
}

async function fetchPost(url, body, headers) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  return { ok: response.ok, status: response.status, text: await response.text() };
}

function describeNetworkError(error) {
  const code = error?.cause?.code || error?.name;
  return code ? `сеть недоступна (${code})` : `сеть недоступна: ${error?.message || error}`;
}

let curlFound;
function curlAvailable() {
  curlFound ??= spawnSync('curl', ['--version'], { stdio: 'ignore' }).status === 0;
  return curlFound;
}

function curlPost(url, body, headers) {
  if (!curlAvailable()) throw new Error('нет ни fetch, ни curl — обновите Node.js до версии 18+');

  // URL и заголовки уходят во временный конфиг, а не в аргументы:
  // в них токены, а аргументы процесса видны другим пользователям через ps.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-notify-'));
  const configPath = path.join(dir, 'curl.conf');
  try {
    const quote = (value) => `"${String(value).replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ')}"`;
    const lines = [
      `url = ${quote(url)}`,
      ...Object.entries(headers).map(([name, value]) => `header = ${quote(`${name}: ${value}`)}`),
    ];
    fs.writeFileSync(configPath, `${lines.join('\n')}\n`, { mode: 0o600 });

    const result = spawnSync(
      'curl',
      [
        '-sS',
        '--max-time', String(Math.ceil(HTTP_TIMEOUT_MS / 1000)),
        '-K', configPath,
        '--data-binary', '@-',
        '-w', '\n%{http_code}',
      ],
      { input: body, encoding: 'utf8', timeout: HTTP_TIMEOUT_MS + 5_000 },
    );
    if (result.error) throw result.error;

    const output = result.stdout || '';
    const cut = output.lastIndexOf('\n');
    const status = Number(output.slice(cut + 1)) || 0;
    if (status === 0) {
      const reason = (result.stderr || '').trim() || `curl завершился с кодом ${result.status}`;
      throw new Error(`сеть недоступна: ${reason}`);
    }
    return { ok: status >= 200 && status < 300, status, text: output.slice(0, Math.max(cut, 0)) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─── Состояние между хуками ─────────────────────────────────────────────────

const slug = (value) => String(value || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
const stateFile = (sessionId) => path.join(STATE_DIR, `${slug(sessionId)}.json`);

function readState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(sessionId), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(sessionId, state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const file = stateFile(sessionId);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state));
  fs.renameSync(temp, file);
}

const lockPath = (key) => path.join(LOCK_DIR, crypto.createHash('sha1').update(key).digest('hex'));

/**
 * Атомарно «забирает» событие: true — отправляет этот процесс, false — его уже
 * отправили. Защищает от дублей, когда хук стоит и глобально, и в проекте,
 * и от повторного «Готово» в рамках одной задачи.
 */
function claimOnce(key, ttlMs) {
  const dir = lockPath(key);
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  try {
    fs.mkdirSync(dir);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  let age;
  try {
    age = Date.now() - fs.statSync(dir).mtimeMs;
  } catch {
    return false;
  }
  if (age < ttlMs) return false;

  fs.rmSync(dir, { recursive: true, force: true });
  try {
    fs.mkdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

function pruneOldState() {
  const now = Date.now();
  for (const dir of [STATE_DIR, LOCK_DIR]) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === 'locks' || name.startsWith('notify.log')) continue;
      const full = path.join(dir, name);
      try {
        if (now - fs.statSync(full).mtimeMs > STATE_TTL_MS) fs.rmSync(full, { recursive: true, force: true });
      } catch {
        // Файл мог удалить параллельный процесс.
      }
    }
  }
}

// ─── Журнал ─────────────────────────────────────────────────────────────────

function log(message) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch {
      // Журнала ещё нет.
    }
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Журнал — не повод ронять хук.
  }
}

function debug(message) {
  if (debugEnabled) log(`debug ${message}`);
}

// ─── Текст уведомлений ──────────────────────────────────────────────────────

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return minutes ? `${hours} ч ${minutes} мин` : `${hours} ч`;
  if (minutes) return seconds ? `${minutes} мин ${seconds} с` : `${minutes} мин`;
  return `${seconds} с`;
}

/** Markdown-ответ Claude → короткий простой текст для экрана блокировки. */
export function summarize(markdown, maxChars = SUMMARY_MAX_CHARS) {
  const plain = String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '• ')
    .replace(/^[ \t]*\|.*\|[ \t]*$/gm, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (plain.length <= maxChars) return plain;
  const cut = plain.slice(0, maxChars);
  const boundary = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return `${(boundary > maxChars * 0.5 ? cut.slice(0, boundary + 1) : cut).trim()}…`;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && block.text)
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/** Последний ответ Claude: из события, а в старых версиях Claude Code — из хвоста транскрипта. */
function lastAssistantText(input) {
  const direct = input.last_assistant_message;
  if (typeof direct === 'string' && direct.trim()) return direct;
  if (direct && typeof direct === 'object') {
    const text = textFromContent(direct.content ?? direct.message?.content);
    if (text) return text;
  }
  return lastAssistantTextFromTranscript(input.transcript_path);
}

function lastAssistantTextFromTranscript(file) {
  if (!file) return '';
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (entry?.type !== 'assistant') continue;
      const text = textFromContent(entry.message?.content);
      if (text) return text;
    }
  } catch {
    // Нет транскрипта — уведомление уйдёт без пересказа.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return '';
}

function describeInputRequest(message) {
  const text = String(message || '').trim();
  const permission = /needs your permission to use (.+)$/i.exec(text);
  if (permission) return `Claude просит разрешение: ${permission[1]}`;
  if (!text || /waiting for your input/i.test(text)) return 'Claude ждёт ответа';
  return text;
}

function describeFailure(input) {
  const details = [input.error, input.error_type, input.reason, input.message, input.stop_reason]
    .map((value) => (typeof value === 'string' ? value : value ? JSON.stringify(value) : ''))
    .filter(Boolean)
    .join(' · ')
    .slice(0, 300);
  if (/rate.?limit|usage.?limit|quota|429/i.test(details)) {
    return `Упёрся в лимит использования.\n${details}`;
  }
  return details || 'Задача прервалась из-за ошибки API.';
}

function projectName(input) {
  const dir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  return path.basename(dir) || dir;
}

/** В облачной сессии кнопка в уведомлении открывает её на claude.ai. */
function sessionUrl() {
  const match = /\/sessions\/cse_([A-Za-z0-9]+)/.exec(process.env.CLAUDE_CODE_REMOTE_SDK_URL || '');
  return match ? `https://claude.ai/code/session_${match[1]}` : '';
}

// ─── Логика хука ────────────────────────────────────────────────────────────

export async function handleHook(input, config = loadConfig()) {
  debugEnabled = config.debug;
  const event = input?.hook_event_name;
  const sessionId = input?.session_id || 'unknown';

  if (event === 'UserPromptSubmit') {
    const now = Date.now();
    writeState(sessionId, { turnId: `${now}-${process.pid}`, startedAt: now });
    return;
  }

  const state = readState(sessionId);
  const turnId = state.turnId || 'unknown-turn';
  const lockKey = (suffix) => `${sessionId}:${turnId}:${suffix}`;
  const elapsedMs = state.startedAt ? Date.now() - state.startedAt : null;
  // Короткая задача — человек, скорее всего, ещё у компьютера. Время неизвестно
  // (хук поставили посреди сессии) — лучше лишнее уведомление, чем пропущенное.
  const longEnough = elapsedMs === null || elapsedMs >= config.minSeconds * 1000;

  if (event === 'Stop') {
    if (!state.stoppedAt) writeState(sessionId, { ...state, stoppedAt: Date.now() });
    pruneOldState();
  }

  if (config.disabled) return debug(`skip ${event}: уведомления выключены`);
  if (configuredProviders(config).length === 0) return debug(`skip ${event}: каналы не настроены`);

  const project = projectName(input);
  let notification;

  switch (event) {
    case 'Stop': {
      if (!longEnough) return debug(`skip Stop: задача заняла ${formatDuration(elapsedMs)}`);
      if (!claimOnce(lockKey('done'), DAY_MS)) return debug('skip Stop: уже отправлено');
      const summary = config.includeSummary ? summarize(lastAssistantText(input)) : '';
      notification = {
        kind: 'done',
        emoji: '✅',
        tag: 'white_check_mark',
        priority: 3,
        title: `Готово · ${project}`,
        body: [elapsedMs !== null ? `Заняло ${formatDuration(elapsedMs)}` : '', summary].filter(Boolean).join('\n\n'),
      };
      break;
    }

    case 'Notification': {
      const type = input.notification_type || '';
      const message = String(input.message || '');
      if (type === 'auth_success') return;
      const idle = type === 'idle_prompt' || (!type && /waiting for your input/i.test(message));
      // «Жду ввода» после завершённой задачи дублирует «Готово».
      if (idle && state.stoppedAt) return debug('skip Notification: задача уже завершена');
      if (!longEnough) return debug('skip Notification: задача только началась');
      if (!claimOnce(lockKey(`input:${type}:${message}`), 30_000)) return debug('skip Notification: дубль');
      notification = {
        kind: 'input',
        emoji: '✋',
        tag: 'raised_hand',
        priority: 4,
        title: `Нужно решение · ${project}`,
        body: describeInputRequest(message),
      };
      break;
    }

    case 'StopFailure': {
      if (!claimOnce(lockKey('failure'), MINUTE_MS)) return debug('skip StopFailure: дубль');
      notification = {
        kind: 'error',
        emoji: '❌',
        tag: 'x',
        priority: 4,
        title: `Остановился с ошибкой · ${project}`,
        body: describeFailure(input),
      };
      break;
    }

    default:
      return;
  }

  const url = sessionUrl();
  if (url) notification.url = url;
  await sendAll(config, notification);
}

// ─── Точка входа ────────────────────────────────────────────────────────────

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function runTestCommand() {
  const config = loadConfig();
  if (configuredProviders(config).length === 0) {
    console.error('Уведомления не настроены. Запустите мастер: node .claude/hooks/notify-setup.mjs');
    return 1;
  }
  const results = await sendTest(config);
  for (const result of results) {
    console.log(result.ok ? `✓ ${result.provider}: отправлено` : `✗ ${result.provider}: ${result.error}`);
  }
  return results.every((result) => result.ok) ? 0 : 1;
}

async function main() {
  if (process.argv.includes('--test')) {
    process.exitCode = await runTestCommand();
    return;
  }
  if (process.stdin.isTTY) {
    console.log('Это хук Claude Code: он получает событие через stdin.');
    console.log('Проверить доставку:  node notify.mjs --test');
    console.log('Настроить:           node .claude/hooks/notify-setup.mjs');
    return;
  }

  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return;
  }
  try {
    await handleHook(input);
  } catch (error) {
    log(`error ${input?.hook_event_name}: ${error?.stack || error}`);
  }
}

function isEntryPoint() {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) await main();
