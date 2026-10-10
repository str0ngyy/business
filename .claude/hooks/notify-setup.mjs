#!/usr/bin/env node
/**
 * Мастер настройки уведомлений Claude Code на телефон.
 *
 *   node .claude/hooks/notify-setup.mjs              пошаговая настройка
 *   node .claude/hooks/notify-setup.mjs --test       отправить тестовое уведомление
 *   node .claude/hooks/notify-setup.mjs --status     показать текущие настройки
 *   node .claude/hooks/notify-setup.mjs --install    включить уведомления во всех проектах
 *   node .claude/hooks/notify-setup.mjs --uninstall  выключить их во всех проектах
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import readline from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  CLAUDE_DIR,
  CONFIG_FILE,
  LOG_FILE,
  configuredProviders,
  loadConfig,
  readEnvFile,
  sendTest,
  telegramCall,
} from './notify.mjs';

const SOURCE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'notify.mjs');
const GLOBAL_SCRIPT = path.join(CLAUDE_DIR, 'hooks', 'claude-notify.mjs');
const GLOBAL_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const HOOK_MARKER = 'claude-notify.mjs';

/**
 * Версия Claude Code, на которой проверено событие StopFailure. Старые версии
 * не знают его, а неизвестное событие может сделать невалидным весь
 * ~/.claude/settings.json вместе с остальными настройками. Поэтому глобально
 * StopFailure ставим, только если версия заведомо подходит.
 */
const STOP_FAILURE_MIN_VERSION = [2, 1, 296];

const TELEGRAM_KEYS = ['CLAUDE_NOTIFY_TELEGRAM_TOKEN', 'CLAUDE_NOTIFY_TELEGRAM_CHAT_ID'];
const NTFY_KEYS = ['CLAUDE_NOTIFY_NTFY_TOPIC'];

const print = (text = '') => stdout.write(`${text}\n`);

// ─── Глобальная установка ───────────────────────────────────────────────────

const toPosix = (file) => file.replace(/\\/g, '/');
const shellQuote = (value) => `"${value.replace(/(["\\$`])/g, '\\$1')}"`;

function readSettings() {
  if (!fs.existsSync(GLOBAL_SETTINGS)) return {};
  const text = fs.readFileSync(GLOBAL_SETTINGS, 'utf8');
  if (!text.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${GLOBAL_SETTINGS} — невалидный JSON. Исправьте его вручную: перезаписывать файл я не буду.`);
  }
  return parsed;
}

function writeSettings(settings) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  if (fs.existsSync(GLOBAL_SETTINGS)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(GLOBAL_SETTINGS, `${GLOBAL_SETTINGS}.backup-${stamp}`);
  }
  const temp = `${GLOBAL_SETTINGS}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(temp, GLOBAL_SETTINGS);
}

/** Убирает только наши хуки, чужие не трогает. Возвращает, сколько убрано. */
function removeOurHooks(settings) {
  let removed = 0;
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(entries)) continue;
    const kept = [];
    for (const entry of entries) {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      const others = hooks.filter((hook) => !String(hook?.command ?? '').includes(HOOK_MARKER));
      removed += hooks.length - others.length;
      if (others.length > 0) kept.push({ ...entry, hooks: others });
      else if (hooks.length === 0) kept.push(entry);
    }
    if (kept.length > 0) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

function isInstalledGlobally() {
  try {
    return JSON.stringify(readSettings().hooks ?? {}).includes(HOOK_MARKER);
  } catch {
    return false;
  }
}

function claudeVersion() {
  const result = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 10_000, shell: process.platform === 'win32' });
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(result.stdout || '');
  return match ? match.slice(1).map(Number) : null;
}

function versionAtLeast(version, minimum) {
  for (let i = 0; i < minimum.length; i += 1) {
    if (version[i] !== minimum[i]) return version[i] > minimum[i];
  }
  return true;
}

function installGlobally() {
  const settings = readSettings();

  fs.mkdirSync(path.dirname(GLOBAL_SCRIPT), { recursive: true });
  fs.copyFileSync(SOURCE_SCRIPT, GLOBAL_SCRIPT);

  // Абсолютный путь к node: у Claude Desktop, запущенного не из терминала,
  // PATH может не содержать node из Homebrew или nvm.
  const command = `${shellQuote(toPosix(process.execPath))} ${shellQuote(toPosix(GLOBAL_SCRIPT))}`;
  const background = { type: 'command', command, async: true, timeout: 30 };
  const version = claudeVersion();
  const withStopFailure = version !== null && versionAtLeast(version, STOP_FAILURE_MIN_VERSION);

  removeOurHooks(settings);
  settings.hooks ??= {};
  const add = (event, hook) => {
    settings.hooks[event] = [...(settings.hooks[event] ?? []), { hooks: [hook] }];
  };
  // Время старта пишем синхронно: иначе быстрый ответ может прочитать время прошлой задачи.
  add('UserPromptSubmit', { type: 'command', command, timeout: 10 });
  add('Stop', background);
  add('Notification', background);
  if (withStopFailure) add('StopFailure', background);

  writeSettings(settings);
  return { withStopFailure, version };
}

function uninstallGlobally() {
  const settings = readSettings();
  const removed = removeOurHooks(settings);
  if (removed > 0) writeSettings(settings);
  fs.rmSync(GLOBAL_SCRIPT, { force: true });
  return removed;
}

function reportInstall({ withStopFailure, version }) {
  print(`✓ Хуки добавлены в ${GLOBAL_SETTINGS}`);
  print(`  Скрипт: ${GLOBAL_SCRIPT}`);
  if (!withStopFailure) {
    const found = version ? `у вас ${version.join('.')}` : 'команда claude не найдена в PATH';
    print(`  Уведомление об ошибках (StopFailure) не включено: ${found}, нужна ${STOP_FAILURE_MIN_VERSION.join('.')}+.`);
    print('  Обновите Claude Code и запустите установку ещё раз.');
  }
  print('  Перезапустите открытые сессии Claude Code или откройте в них /hooks — так они подхватят изменения.');
}

// ─── Файл настроек ──────────────────────────────────────────────────────────

/** Пустая строка в updates удаляет ключ. */
function writeConfig(updates) {
  const merged = { ...readEnvFile(), ...updates };
  const lines = [
    '# Уведомления Claude Code на телефон. Файл создал notify-setup.mjs.',
    '# Здесь секреты: не публикуйте его и не кладите в git.',
    '',
    ...Object.entries(merged)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => `${key}=${value}`),
  ];
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${lines.join('\n')}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    // Windows не поддерживает права POSIX — файл и так лежит в профиле пользователя.
  }
}

const mask = (secret) => (secret.length > 10 ? `${secret.slice(0, 6)}…${secret.slice(-4)}` : '••••');

// ─── Команды ────────────────────────────────────────────────────────────────

async function commandTest() {
  const config = loadConfig();
  if (configuredProviders(config).length === 0) {
    print('Уведомления ещё не настроены. Запустите: npm run notify:setup');
    return 1;
  }
  const results = await sendTest(config);
  for (const result of results) {
    print(result.ok ? `✓ ${result.provider}: отправлено` : `✗ ${result.provider}: ${result.error}`);
  }
  return results.every((result) => result.ok) ? 0 : 1;
}

function commandStatus() {
  const config = loadConfig();
  const providers = configuredProviders(config).map((provider) => provider.name);
  print(`Файл настроек:   ${fs.existsSync(CONFIG_FILE) ? CONFIG_FILE : 'нет (берутся только переменные окружения)'}`);
  print(`Каналы:          ${providers.length ? providers.join(', ') : 'не настроены'}`);
  if (config.telegram.token) print(`  Telegram:      бот ${mask(config.telegram.token)}, чат ${config.telegram.chatId || '—'}`);
  if (config.ntfy.topic) print(`  ntfy:          ${config.ntfy.server}/${config.ntfy.topic}`);
  print(`Обращение:       ${config.name || 'без имени'}`);
  print(`Порог:           задачи дольше ${config.minSeconds} с`);
  print(`Пересказ ответа: ${config.includeSummary ? 'да' : 'нет'}`);
  print(`Выключено:       ${config.disabled ? 'да (CLAUDE_NOTIFY_DISABLED)' : 'нет'}`);
  print(`Все проекты:     ${isInstalledGlobally() ? `да (${GLOBAL_SETTINGS})` : 'нет, только проекты со своим .claude/settings.json'}`);
  try {
    const tail = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-5);
    print(`\nПоследние записи ${LOG_FILE}:`);
    for (const line of tail) print(`  ${line}`);
  } catch {
    print('\nЖурнал пока пуст.');
  }
  return 0;
}

// ─── Мастер ─────────────────────────────────────────────────────────────────

async function setupTelegram(ask, confirm, current, apiBase) {
  print('\nTelegram');
  print('  1. Откройте в Telegram @BotFather, отправьте /newbot, придумайте имя и username бота.');
  print('  2. BotFather пришлёт токен вида 123456789:AAH…');

  let token;
  let bot;
  for (;;) {
    const answer = await ask(current.token ? '  Токен (Enter — оставить сохранённый)' : '  Токен');
    token = answer || current.token;
    if (!token) continue;
    try {
      bot = await telegramCall({ token, apiBase }, 'getMe');
      break;
    } catch (error) {
      print(`  ✗ Не получилось: ${error.message}`);
      print('    Проверьте токен и интернет (Ctrl+C — выйти).');
    }
  }
  print(`  ✓ Бот @${bot.username} найден.`);

  if (current.chatId && token === current.token && (await confirm(`  Слать в сохранённый чат ${current.chatId}?`, true))) {
    return { token, chatId: current.chatId };
  }

  print(`  3. Откройте https://t.me/${bot.username}, нажмите «Старт» или напишите боту что угодно.`);
  print('     Жду сообщение до двух минут…');
  for (;;) {
    const chatId = await waitForTelegramChat({ token, apiBase });
    if (chatId) {
      print(`  ✓ Чат найден: ${chatId}`);
      return { token, chatId };
    }
    print('  Сообщение не пришло.');
    const manual = await ask('  Введите chat_id вручную или нажмите Enter, чтобы подождать ещё');
    if (manual) return { token, chatId: manual };
  }
}

async function waitForTelegramChat(telegram, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const updates = await telegramCall(telegram, 'getUpdates', { timeout: 0, allowed_updates: ['message'] });
      const last = updates.filter((update) => update.message?.chat?.id).at(-1);
      if (last) {
        // Подтверждаем прочитанное, чтобы старые сообщения не мешали при повторной настройке.
        await telegramCall(telegram, 'getUpdates', { offset: last.update_id + 1, timeout: 0 }).catch(() => {});
        return String(last.message.chat.id);
      }
    } catch (error) {
      print(`  ✗ ${error.message}`);
      return '';
    }
    await sleep(2_000);
  }
  return '';
}

async function setupNtfy(ask, current) {
  const topic = current.topic || `claude-${crypto.randomBytes(8).toString('hex')}`;
  print('\nntfy');
  print('  1. Установите приложение ntfy:');
  print('       iPhone:  https://apps.apple.com/app/ntfy/id1625396347');
  print('       Android: https://play.google.com/store/apps/details?id=io.heckel.ntfy');
  print('     Когда приложение спросит про уведомления, разрешите их.');
  print(`  2. Нажмите «+» и подпишитесь на канал:  ${topic}`);
  print('     Сервер оставьте по умолчанию (ntfy.sh).');
  print('  Имя канала работает как пароль: кто его знает, тот видит уведомления. Никому его не показывайте.');
  await ask('  Нажмите Enter, когда подпишетесь');
  return { topic };
}

/**
 * Вопросы в терминале. Строки копятся в очереди: rl.question теряет то, что
 * пришло пачкой (вставили токен вместе с Enter, ответы переданы через pipe).
 */
function createPrompter() {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
  const queued = [];
  const waiting = [];
  let closed = false;
  const aborted = () => Object.assign(new Error('ввод прерван'), { code: 'ABORT_ERR' });

  rl.on('line', (line) => {
    const next = waiting.shift();
    if (next) next.resolve(line);
    else queued.push(line);
  });
  rl.on('close', () => {
    closed = true;
    for (const next of waiting.splice(0)) next.reject(aborted());
  });
  // Без обработчика Ctrl+C в терминальном режиме лишь ставит ввод на паузу.
  rl.on('SIGINT', () => {
    print('\nОтменено.');
    process.exit(130);
  });

  const question = (text) => {
    rl.setPrompt(text);
    rl.prompt();
    if (queued.length > 0) {
      const line = queued.shift();
      if (!stdin.isTTY) print(line);
      return Promise.resolve(line);
    }
    if (closed) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
      waiting.push({
        resolve: (line) => {
          if (!stdin.isTTY) print(line);
          resolve(line);
        },
        reject,
      });
    });
  };
  return { question, close: () => rl.close() };
}

async function commandWizard() {
  const prompter = createPrompter();
  const ask = async (question, fallback = '') => {
    const hint = fallback ? ` [${fallback}]` : '';
    return (await prompter.question(`${question}${hint}: `)).trim() || fallback;
  };
  const confirm = async (question, byDefault = true) => {
    const answer = (await prompter.question(`${question} ${byDefault ? '[Д/н]' : '[д/Н]'}: `)).trim().toLowerCase();
    if (!answer) return byDefault;
    return ['д', 'да', 'y', 'yes'].includes(answer);
  };

  try {
    const saved = readEnvFile();
    const defaults = loadConfig();
    print('🔔 Уведомления Claude Code на телефон\n');
    print('Куда присылать?');
    print('  1) ntfy — бесплатное приложение для iPhone и Android, без регистрации');
    print('  2) Telegram — бот в вашем Telegram');
    print('  3) Оба');
    let choice = '';
    while (!['1', '2', '3'].includes(choice)) choice = await ask('Выбор', '1');

    const updates = {};
    if (choice === '1' || choice === '3') {
      const ntfy = await setupNtfy(ask, { topic: saved.CLAUDE_NOTIFY_NTFY_TOPIC || '' });
      updates.CLAUDE_NOTIFY_NTFY_TOPIC = ntfy.topic;
    } else {
      for (const key of NTFY_KEYS) updates[key] = '';
    }

    if (choice === '2' || choice === '3') {
      const telegram = await setupTelegram(
        ask,
        confirm,
        { token: saved.CLAUDE_NOTIFY_TELEGRAM_TOKEN || '', chatId: saved.CLAUDE_NOTIFY_TELEGRAM_CHAT_ID || '' },
        defaults.telegram.apiBase,
      );
      updates.CLAUDE_NOTIFY_TELEGRAM_TOKEN = telegram.token;
      updates.CLAUDE_NOTIFY_TELEGRAM_CHAT_ID = telegram.chatId;
    } else {
      for (const key of TELEGRAM_KEYS) updates[key] = '';
    }

    const name = await ask('\nКак к вам обращаться в уведомлениях', defaults.name);
    updates.CLAUDE_NOTIFY_NAME = name;

    print('\nКороткие задачи обычно делаются, пока вы у компьютера, — о них не пишу.');
    let minSeconds = '';
    while (!/^\d+$/.test(minSeconds)) {
      minSeconds = await ask('Присылать, если задача шла дольше (секунд, 0 — всегда)', String(defaults.minSeconds));
    }
    updates.CLAUDE_NOTIFY_MIN_SECONDS = minSeconds;

    writeConfig(updates);
    print(`\n✓ Настройки сохранены в ${CONFIG_FILE}`);

    print('Отправляю тестовое уведомление…');
    const results = await sendTest(loadConfig());
    for (const result of results) {
      print(result.ok ? `  ✓ ${result.provider}: отправлено` : `  ✗ ${result.provider}: ${result.error}`);
    }
    if (results.some((result) => !result.ok)) {
      print(`  Подробности в журнале: ${LOG_FILE}`);
    }

    print('');
    if (isInstalledGlobally()) {
      print('Хуки уже стоят во всех проектах — обновляю скрипт до текущей версии.');
      reportInstall(installGlobally());
    } else if (await confirm('Включить уведомления во всех проектах на этом компьютере?', true)) {
      reportInstall(installGlobally());
    } else {
      print('Хорошо. Уведомления будут работать в проектах, где есть .claude/settings.json с этими хуками.');
    }

    print('\nГотово. Проверить ещё раз: npm run notify:test');
    return 0;
  } finally {
    prompter.close();
  }
}

// ─── Точка входа ────────────────────────────────────────────────────────────

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--test')) return commandTest();
  if (args.has('--status')) return commandStatus();
  if (args.has('--install')) {
    reportInstall(installGlobally());
    return 0;
  }
  if (args.has('--uninstall')) {
    const removed = uninstallGlobally();
    print(removed > 0 ? `✓ Хуки убраны из ${GLOBAL_SETTINGS}` : 'Глобальных хуков не было.');
    if (fs.existsSync(CONFIG_FILE)) {
      print(`  Настройки каналов остались в ${CONFIG_FILE} — удалите файл, если они больше не нужны.`);
    }
    return 0;
  }
  return commandWizard();
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error?.code === 'ABORT_ERR') {
    print('\nОтменено.');
    process.exitCode = 130;
  } else {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  }
}
