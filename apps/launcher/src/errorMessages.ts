/**
 * @file errorMessages.ts
 * Unified client-side error presentation (Task 4).
 *
 * Errors arriving from `invoke()` are strings shaped
 * `MACHINE_CODE[|req=<id>][|<detail>]`. `parseError` splits that into
 * `{ code, requestId, detail }`; `humanError` resolves the code to a
 * Russian, user-safe message — raw Rust/JS error text NEVER reaches the UI.
 */

export const ERROR_MESSAGES: Record<string, string> = {
  NETWORK_ERROR: 'Ошибка сети. Проверьте подключение к интернету.',
  SERVER_UNAVAILABLE: 'Сервер недоступен. Попробуйте позже.',
  UNAUTHORIZED: 'Требуется авторизация.',
  SESSION_EXPIRED: 'Сессия истекла. Войдите заново.',
  FORBIDDEN: 'Недостаточно прав.',
  INVALID_CREDENTIALS: 'Неверный email или пароль.',
  INVALID_EMAIL: 'Некорректный email.',
  EMAIL_TAKEN: 'Этот email уже зарегистрирован.',
  PASSWORD_TOO_SHORT: 'Пароль слишком короткий (минимум 6 символов).',
  HWID_REQUIRED: 'Не удалось определить устройство.',
  HWID_MISMATCH: 'Аккаунт привязан к другому устройству.',
  HWID_UNAVAILABLE: 'Не удалось определить идентификатор устройства.',
  HWID_RESET_COOLDOWN: 'Отвязка устройства доступна раз в 7 дней.',
  TOO_MANY_ATTEMPTS: 'Слишком много попыток. Попробуйте позже.',
  SUBSCRIPTION_REQUIRED: 'Требуется активная подписка.',
  LICENSE_DENIED: 'Лицензия не подтверждена.',
  GAME_NOT_FOUND: 'Игра не найдена.',
  BUILD_NOT_UPLOADED: 'Сборка не загружена.',
  VERSION_EXISTS: 'Такая версия уже существует.',
  INVALID_SLUG: 'Некорректный идентификатор игры.',
  INVALID_VERSION: 'Некорректная версия.',
  INVALID_BUILD: 'Архив сборки не прошёл проверку.',
  HASH_MISMATCH: 'Контрольная сумма файла не совпала — загрузка отклонена.',
  DOWNLOAD_FAILED: 'Не удалось скачать игру.',
  INSTALL_FAILED: 'Не удалось установить игру.',
  LAUNCH_FAILED: 'Не удалось запустить игру.',
  HANDSHAKE_TIMEOUT: 'Игра не ответила при запуске (15 с).',
  EXECUTABLE_MISSING: 'Исполняемый файл не найден.',
  EXECUTABLE_OUTSIDE_INSTALL_DIR: 'Исполняемый файл вне каталога установки.',
  EXECUTABLE_NAME_MISMATCH: 'Исполняемый файл не совпадает с каталогом.',
  GAME_ALREADY_RUNNING: 'Игра уже запущена.',
  GAME_RUNNING: 'Игра запущена — остановите её сначала.',
  GAME_NOT_RUNNING: 'Игра не запущена.',
  NOT_INSTALLED: 'Игра не установлена.',
  NOT_AUTHENTICATED: 'Требуется вход в аккаунт.',
  PROVIDER_NOT_CONFIGURED: 'Платёжный провайдер не подключён.',
  USER_NOT_FOUND: 'Пользователь не найден.',
  FILE_OPEN_FAILED: 'Не удалось открыть файл.',
  FILE_STAT_FAILED: 'Не удалось прочитать файл.',
  MALFORMED_RESPONSE: 'Некорректный ответ сервера.',
  BAD_REQUEST: 'Некорректный запрос.',
  NOT_FOUND: 'Ресурс не найден.',
  UNKNOWN: 'Произошла непредвиденная ошибка. Подробности в логах.',
  INTERNAL_ERROR: 'Произошла непредвиденная ошибка. Подробности в логах.',
};

export interface ParsedError {
  code: string;
  requestId: string | null;
  detail: string | null;
}

/** Splits `CODE[|req=id][|detail]` into parts. */
export function parseError(raw: unknown): ParsedError {
  const s = String(raw ?? '');
  const parts = s.split('|');
  let code = (parts[0] || '').trim();
  // Legacy "CODE: detail" strings from older commands — keep the code only.
  if (code.includes(':')) code = code.split(':')[0].trim();
  let requestId: string | null = null;
  let detail: string | null = null;
  for (const p of parts.slice(1)) {
    if (p.startsWith('req=')) requestId = p.slice(4);
    else detail = detail ? `${detail}|${p}` : p;
  }
  if (!/^[A-Z_]{3,}$/.test(code)) {
    // Not a machine code at all (e.g. a JS Error message) → generic.
    detail = detail ?? (code || s);
    code = 'INTERNAL_ERROR';
  }
  return { code, requestId, detail };
}

/** Human-readable error text for banners/toasts, with optional request id. */
export function humanError(raw: unknown, opts?: { withRequestId?: boolean }): string {
  const { code, requestId, detail } = parseError(raw);
  let msg = ERROR_MESSAGES[code] || ERROR_MESSAGES.INTERNAL_ERROR;
  if (detail && !msg.endsWith('.')) msg += '.';
  if (opts?.withRequestId && requestId) msg += ` Код обращения: ${requestId}`;
  return msg;
}
