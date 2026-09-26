/**
 * Работа с датами. Всё локальное, без UTC-сдвигов:
 * пользователь планирует день там, где он живёт, а не в Гринвиче.
 */

/** Дата в формате YYYY-MM-DD по локальному времени. */
export function toDateKey(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Сегодняшняя дата в формате YYYY-MM-DD. */
export function today(): string {
  return toDateKey();
}

/** Приветствие по времени суток. */
export function greetingFor(date: Date = new Date()): string {
  const hour = date.getHours();
  if (hour < 6) return "Доброй ночи";
  if (hour < 12) return "Доброе утро";
  if (hour < 18) return "Добрый день";
  return "Добрый вечер";
}

/** «пятница, 26 сентября» — для шапки. */
export function formatLongDate(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
}

/** «26 сентября» — без дня недели, для выбранной даты в расписании. */
export function formatShortDate(dateKey: string): string {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return dateKey;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
  }).format(parsed);
}

/** «14:32» — время генерации брифинга. */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * Разбирает YYYY-MM-DD в локальную дату.
 * `new Date("2026-09-26")` трактуется как UTC и в минусовых поясах
 * даёт предыдущий день — поэтому собираем вручную.
 */
export function parseDateKey(dateKey: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Сдвиг даты на N дней: для кнопок «вчера / завтра». */
export function shiftDateKey(dateKey: string, days: number): string {
  const parsed = parseDateKey(dateKey) ?? new Date();
  parsed.setDate(parsed.getDate() + days);
  return toDateKey(parsed);
}

/** Сравнение времени «HH:MM» для сортировки расписания. */
export function compareTime(a: string, b: string): number {
  return a.localeCompare(b);
}
