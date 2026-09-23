/**
 * DashScope 各条接口共用的 HTTP 细节：超时、重试、以及把失败翻译成人话。
 *
 * 识别和翻译两条链路的失败模式是一样的（网络抖动、限流、偶发 5xx），
 * 所以重试策略抽在这里，两边只有「怎么描述错误」不同。
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 3;

/** 这些状态码值得重试：限流、上游抖动、网关错误。仅本模块内部使用。 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 带上 HTTP 状态码和「是否值得重试」标记的错误。 */
export class HttpError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * POST 一个 JSON 请求，返回解析后的响应体。
 *
 * @param {object} params
 * @param {string} params.url
 * @param {string} params.apiKey
 * @param {object} params.body
 * @param {(status: number, payload: any) => string} params.describe  把失败翻译成给用户看的话
 * @param {Record<string,string>} [params.headers]  额外请求头
 * @param {AbortSignal} [params.signal]
 * @param {number} [params.maxAttempts]
 * @param {number} [params.timeoutMs]
 */
export async function postJson({
  url,
  apiKey,
  body,
  describe,
  headers = {},
  signal,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const raw = await response.text();
      let payload = null;
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch {
        payload = raw;
      }

      if (!response.ok) {
        throw new HttpError(describe(response.status, payload), {
          status: response.status,
          retryable: RETRYABLE_STATUS.has(response.status),
        });
      }

      return payload;
    } catch (err) {
      // 用户主动取消：立刻结束，不重试
      if (signal?.aborted) throw new Error('请求已取消。');

      const timedOut = err?.name === 'AbortError';
      lastError = timedOut ? new HttpError(`请求超时（${Math.round(timeoutMs / 1000)} 秒）。`) : err;

      // 网络层错误（TypeError）和超时都值得重试
      const retryable = timedOut || err?.retryable === true || err?.name === 'TypeError';
      if (!retryable || attempt === maxAttempts) throw lastError;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onExternalAbort);
    }

    // 指数退避，加一点抖动避免多个分片同时重试
    await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.random() * 400);
  }

  throw lastError || new Error('请求失败。');
}

/** 错误信息在响应体里的位置各接口不一，统一挖一下。 */
export function extractErrorMessage(payload) {
  if (typeof payload === 'string') return payload.slice(0, 300);
  return (
    payload?.error?.message ||
    payload?.message ||
    payload?.output?.message ||
    payload?.error?.code ||
    ''
  );
}
