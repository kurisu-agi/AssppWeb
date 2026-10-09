import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appleRequest } from '../../src/apple/request';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), close: vi.fn(), pooledFetch: vi.fn(),
}));

vi.mock('../../src/apple/libcurl-init', () => ({
  initLibcurl: vi.fn(),
  libcurl: {
    fetch: mocks.pooledFetch,
    HTTPSession: class {
      fetch = mocks.fetch;
      close = mocks.close;
    },
  },
}));

describe('Apple request connection isolation', () => {
  beforeEach(() => vi.resetAllMocks());

  it('consumes the full body before closing an isolated auth session and preserves cookies', async () => {
    const text = vi.fn(async () => {
      expect(mocks.close).not.toHaveBeenCalled();
      return '<plist/>';
    });
    mocks.fetch.mockResolvedValue({ status: 200, statusText: 'OK', raw_headers: [['set-cookie', 'new=value']], text });
    await appleRequest({ method: 'POST', host: 'buy.itunes.apple.com', path: '/auth',
      cookies: [{ name: 'session', value: 'saved', domain: 'buy.itunes.apple.com', path: '/', secure: true }],
      body: 'body', freshConnection: true });
    expect(mocks.fetch.mock.calls[0][1].headers).toMatchObject({ Connection: 'close', Cookie: 'session=saved' });
    expect(mocks.pooledFetch).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it.each(['fetch', 'body'])('closes the session after a %s error', async (stage) => {
    if (stage === 'fetch') mocks.fetch.mockRejectedValue(new Error('network error'));
    else mocks.fetch.mockResolvedValue({ raw_headers: [], text: () => Promise.reject(new Error('body error')) });
    await expect(appleRequest({ method: 'POST', host: 'buy.itunes.apple.com', path: '/auth', freshConnection: true })).rejects.toThrow('error');
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('leaves non-authentication requests on the shared pool', async () => {
    mocks.pooledFetch.mockResolvedValue({ status: 200, statusText: 'OK', raw_headers: [], text: async () => 'ok' });
    await appleRequest({ method: 'GET', host: 'buy.itunes.apple.com', path: '/download' });
    expect(mocks.pooledFetch).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });
});
