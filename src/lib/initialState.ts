/**
 * Стартовое состояние дашборда.
 *
 * При первом запуске показываем несколько демонстрационных записей —
 * пустой экран ничего не объясняет, а заполненный сразу показывает,
 * как всё устроено. Над карточками при этом висит честная плашка
 * «это примеры», и они исчезают при первом реальном действии.
 */

import { today } from "@/lib/date";
import { SCHEMA_VERSION } from "@/lib/storage";
import type { DashboardState } from "@/types/dashboard";

/** Короткий уникальный id. Для локальных данных этого достаточно. */
export function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createInitialState(): DashboardState {
  const now = new Date().toISOString();
  const date = today();

  return {
    name: "",
    notes: "",
    briefing: null,
    hasExamples: true,
    version: SCHEMA_VERSION,
    tasks: [
      {
        id: createId(),
        text: "Составить план на неделю",
        done: false,
        starred: true,
        createdAt: now,
        completedAt: null,
      },
      {
        id: createId(),
        text: "Ответить на важные сообщения",
        done: false,
        starred: true,
        createdAt: now,
        completedAt: null,
      },
      {
        id: createId(),
        text: "Разобрать входящие",
        done: true,
        starred: false,
        createdAt: now,
        completedAt: now,
      },
    ],
    agenda: [
      { id: createId(), date, time: "09:00", title: "Планирование дня", createdAt: now },
      { id: createId(), date, time: "12:30", title: "Работа над проектом", createdAt: now },
      { id: createId(), date, time: "18:00", title: "Тренировка", createdAt: now },
    ],
  };
}

/** Пустое состояние — после очистки примеров или сброса. */
export function createEmptyState(): DashboardState {
  return {
    name: "",
    notes: "",
    briefing: null,
    hasExamples: false,
    version: SCHEMA_VERSION,
    tasks: [],
    agenda: [],
  };
}
