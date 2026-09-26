/**
 * Слой хранения данных.
 *
 * Сейчас данные лежат в localStorage браузера. Это сознательное решение
 * для старта: ноль внешних сервисов, ноль ключей, работает офлайн.
 *
 * Когда понадобится синхронизация между телефоном и ноутбуком, меняется
 * ТОЛЬКО этот файл: реализуется тот же интерфейс DashboardStorage поверх
 * Supabase, а компоненты и хук остаются нетронутыми. Ради этого слой
 * и выделен отдельно.
 */

import type { DashboardState } from "@/types/dashboard";

const STORAGE_KEY = "pult.dashboard.v1";

/** Текущая версия схемы данных. Растёт при несовместимых изменениях. */
export const SCHEMA_VERSION = 1;

export interface DashboardStorage {
  load(): Promise<DashboardState | null>;
  save(state: DashboardState): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Проверка формы данных из хранилища.
 *
 * localStorage — это строка, которую мог испортить кто угодно: старая
 * версия приложения, ручная правка, сбой. Доверять ей нельзя, поэтому
 * проверяем структуру до того, как отдать состояние в интерфейс.
 */
function isDashboardState(value: unknown): value is DashboardState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<DashboardState>;
  return (
    typeof candidate.name === "string" &&
    Array.isArray(candidate.tasks) &&
    Array.isArray(candidate.agenda) &&
    typeof candidate.notes === "string" &&
    typeof candidate.hasExamples === "boolean"
  );
}

class LocalDashboardStorage implements DashboardStorage {
  async load(): Promise<DashboardState | null> {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return isDashboardState(parsed) ? parsed : null;
    } catch {
      // Приватный режим, переполнение, битый JSON — не повод падать.
      // Пользователь получит чистый дашборд вместо белого экрана.
      return null;
    }
  }

  async save(state: DashboardState): Promise<void> {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Квота исчерпана или запись запрещена — интерфейс продолжает
      // работать с состоянием в памяти.
    }
  }

  async clear(): Promise<void> {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // см. выше
    }
  }
}

export const dashboardStorage: DashboardStorage = new LocalDashboardStorage();
