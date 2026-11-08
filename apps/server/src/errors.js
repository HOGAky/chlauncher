/**
 * @file errors.js
 * Unified API error contract (Task 4). Every error response is:
 *
 *   { "error": "MACHINE_CODE", "message": "…", "retryable": false, "details": {} }
 *
 * `error` stays the machine code clients already dispatch on; `message` is a
 * safe human-readable fallback (Russian) for clients that don't localize;
 * `details` carries optional structured extras (e.g. retry_after_ms).
 * Stack traces, internal paths, SQL errors and secrets NEVER leave the
 * process — the global handler in app.js logs them server-side under the
 * request id.
 */

/** Canonical message map: code → safe human text (RU). */
export const ERROR_MESSAGES = {
  NETWORK_ERROR: 'Ошибка сети. Проверьте подключение к интернету.',
  SERVER_UNAVAILABLE: 'Сервер недоступен. Попробуйте позже.',
  UNAUTHORIZED: 'Требуется авторизация.',
  SESSION_EXPIRED: 'Сессия истекла. Войдите заново.',
  FORBIDDEN: 'Недостаточно прав.',
  INVALID_CREDENTIALS: 'Неверный email или пароль.',
  INVALID_EMAIL: 'Некорректный email.',
  EMAIL_TAKEN: 'Этот email уже зарегистрирован.',
  PASSWORD_TOO_SHORT: 'Пароль слишком короткий (минимум 6 символов).',
  HWID_REQUIRED: 'Не передан идентификатор устройства.',
  HWID_MISMATCH: 'Аккаунт привязан к другому устройству.',
  HWID_UNAVAILABLE: 'Не удалось определить идентификатор устройства.',
  HWID_RESET_COOLDOWN: 'Отвязка устройства доступна раз в 7 дней.',
  TOO_MANY_ATTEMPTS: 'Слишком много попыток. Попробуйте позже.',
  SUBSCRIPTION_REQUIRED: 'Требуется активная подписка.',
  GAME_NOT_FOUND: 'Игра не найдена.',
  BUILD_NOT_UPLOADED: 'Сборка не загружена.',
  VERSION_EXISTS: 'Такая версия уже существует.',
  INVALID_SLUG: 'Некорректный идентификатор игры.',
  INVALID_VERSION: 'Некорректная версия (ожидается X.Y.Z).',
  INVALID_BUILD: 'Архив сборки не прошёл проверку.',
  HASH_MISMATCH: 'Контрольная сумма не совпала — загрузка отклонена.',
  DOWNLOAD_FAILED: 'Не удалось скачать игру.',
  INSTALL_FAILED: 'Не удалось установить игру.',
  LAUNCH_FAILED: 'Не удалось запустить игру.',
  HANDSHAKE_TIMEOUT: 'Игра не подтвердила запуск за 15 секунд.',
  EXECUTABLE_MISSING: 'Исполняемый файл не найден.',
  EXECUTABLE_OUTSIDE_INSTALL_DIR: 'Исполняемый файл вне каталога установки.',
  EXECUTABLE_NAME_MISMATCH: 'Исполняемый файл не совпадает с каталогом.',
  GAME_ALREADY_RUNNING: 'Игра уже запущена.',
  GAME_RUNNING: 'Игра запущена — остановите её сначала.',
  GAME_NOT_RUNNING: 'Игра не запущена.',
  NOT_INSTALLED: 'Игра не установлена.',
  NOT_AUTHENTICATED: 'Требуется вход в аккаунт.',
  LICENSE_DENIED: 'Лицензия не подтверждена.',
  PROVIDER_NOT_CONFIGURED: 'Платёжный провайдер не подключён.',
  USER_NOT_FOUND: 'Пользователь не найден.',
  NOT_FOUND: 'Ресурс не найден.',
  BAD_REQUEST: 'Некорректный запрос.',
  INTERNAL_ERROR: 'Произошла непредвиденная ошибка. Подробности в логах.',
};

/**
 * Normalizes an outgoing payload: if it's `{error: CODE}` the response is
 * enriched with message/retryable/details. Called from a preSerialization
 * hook so every route gets the contract for free.
 */
export function enrichError(payload) {
  if (
    payload &&
    typeof payload === 'object' &&
    typeof payload.error === 'string' &&
    payload.message === undefined
  ) {
    return {
      retryable: false,
      details: {},
      ...payload,
      error: payload.error,
      message: ERROR_MESSAGES[payload.error] || ERROR_MESSAGES.INTERNAL_ERROR,
    };
  }
  return payload;
}

/**
 * Registers the contract on a Fastify app: request ids, error enrichment,
 * a safe global error handler (no stack/SQL leaks) and a 404 handler that
 * also honours the envelope.
 * @param {import('fastify').FastifyInstance} app
 */
export function registerErrorContract(app) {
  // Request ids: Fastify assigns request.id from genReqId; echo it back so
  // clients can quote "Код обращения" in bug reports.
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.addHook('preSerialization', async (_request, _reply, payload) =>
    enrichError(payload)
  );

  app.setErrorHandler((err, request, reply) => {
    // Full detail stays server-side, correlated by request id.
    request.log.error({ err }, 'unhandled route error');
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(status).send(
      enrichError({
        error: status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST',
        details: { request_id: request.id },
      })
    );
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(
      enrichError({ error: 'NOT_FOUND', details: { path: request.url } })
    );
  });
}
