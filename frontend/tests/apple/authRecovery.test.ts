import { describe, expect, it } from 'vitest';
import { authRetryDelay, isUnexpectedAuthResponse } from '../../src/apple/authRecovery';
import type { AppleResponse } from '../../src/apple/request';

describe('authentication recovery policy', () => {
  const response = (status: number, body = '', headers = {}): AppleResponse => ({
    status, statusText: '', body, headers, rawHeaders: [],
  });

  it.each([204, 403, 404, 429, 500, 502, 503, 599])('retries malformed HTTP %s but preserves plist credential failures', (status) => {
    expect(isUnexpectedAuthResponse(response(status))).toBe(true);
    expect(isUnexpectedAuthResponse(response(status, '<plist><dict><key>customerMessage</key><string>Bad password</string></dict></plist>'))).toBe(false);
  });

  it('does not treat a usable redirect or unrelated error as retryable', () => {
    expect(isUnexpectedAuthResponse(response(301))).toBe(true);
    expect(isUnexpectedAuthResponse(response(301, '', { location: '/auth' }))).toBe(false);
    expect(isUnexpectedAuthResponse(response(400))).toBe(false);
    expect(isUnexpectedAuthResponse(response(200, '<html>Error</html>'))).toBe(false);
  });

  it('backs off, respects Retry-After dates and stops for waits over 30 seconds', () => {
    const now = Date.parse('2026-10-09T10:00:00Z');
    expect(authRetryDelay(1)).toBe(10000);
    expect(authRetryDelay(2, 'invalid')).toBe(20000);
    expect(authRetryDelay(1, '5')).toBe(5000);
    expect(authRetryDelay(2, '0')).toBe(1000);
    expect(authRetryDelay(1, 'Fri, 09 Oct 2026 10:00:20 GMT', now)).toBe(20000);
    expect(authRetryDelay(1, '31')).toBeNull();
    expect(authRetryDelay(1, 'Fri, 09 Oct 2026 10:00:31 GMT', now)).toBeNull();
  });
});
