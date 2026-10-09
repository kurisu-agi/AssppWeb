import type { AppleResponse } from './request';

export const MAX_AUTH_ATTEMPTS = 3;
export const MAX_AUTH_RETRY_DELAY_MS = 30_000;

export function isUnexpectedAuthResponse(response: AppleResponse): boolean {
  if (/<plist[\s>]/.test(response.body)) return false;
  return [204, 403, 404, 429].includes(response.status) ||
    (response.status >= 500 && response.status <= 599) ||
    (response.status === 301 && !response.headers['location']);
}

/** null means Apple requested a longer pause: stop rather than retry early. */
export function authRetryDelay(
  attempt: number,
  retryAfter?: string,
  now: number = Date.now(),
): number | null {
  const value = retryAfter?.trim();
  if (value) {
    const seconds = /^\d+$/.test(value) ? Number(value) : NaN;
    const delay = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(value) - now;
    if (Number.isFinite(delay)) {
      if (delay > MAX_AUTH_RETRY_DELAY_MS) return null;
      return Math.max(1000, delay);
    }
  }
  return Math.min(10_000 * 2 ** (attempt - 1), MAX_AUTH_RETRY_DELAY_MS);
}

export function waitForAuthRetry(delay: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delay));
}
