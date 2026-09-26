/**
 * Типы данных дашборда.
 *
 * Держим их в одном месте: и клиент, и API-роут, и слой хранения
 * ссылаются сюда. Когда появится Supabase, схема таблиц будет строиться
 * от этих же типов.
 */

/** Задача из списка дел. */
export interface Task {
  id: string;
  text: string;
  done: boolean;
  /** Помечена как главная — поднимается в «Обзор». */
  starred: boolean;
  /** ISO-время создания, для сортировки и будущей аналитики. */
  createdAt: string;
  /** ISO-время выполнения. null, пока задача открыта. */
  completedAt: string | null;
}

/** Событие в расписании, привязанное к дате и времени. */
export interface AgendaItem {
  id: string;
  /** Дата в формате YYYY-MM-DD (локальная, не UTC). */
  date: string;
  /** Время в формате HH:MM, 24 часа. */
  time: string;
  title: string;
  createdAt: string;
}

/** Сохранённый AI-брифинг. Живёт один день. */
export interface Briefing {
  text: string;
  /** Дата, на которую собран брифинг (YYYY-MM-DD). */
  forDate: string;
  /** ISO-время генерации. */
  generatedAt: string;
}

/** Полное состояние дашборда — то, что уходит в хранилище. */
export interface DashboardState {
  /** Имя для приветствия. Пустая строка = ещё не задано. */
  name: string;
  tasks: Task[];
  agenda: AgendaItem[];
  notes: string;
  briefing: Briefing | null;
  /**
   * Пока true, в интерфейсе показаны демонстрационные записи.
   * Сбрасывается при первом реальном действии пользователя.
   */
  hasExamples: boolean;
  /** Версия схемы — понадобится при миграциях формата. */
  version: number;
}

/** Разделы навигации. */
export type ViewId = "overview" | "tasks" | "schedule" | "notes";

/** Фильтр списка задач. */
export type TaskFilter = "all" | "open" | "done";

/** Ответ API-роута брифинга. */
export interface BriefingResponse {
  text: string;
}

/** Ошибка API-роута брифинга — с кодом, чтобы UI мог различать случаи. */
export interface BriefingError {
  error: string;
  code: "no_api_key" | "rate_limited" | "auth_failed" | "bad_request" | "upstream";
}
