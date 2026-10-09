import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDownloadInfo } from '../../src/apple/download';
import { listVersions } from '../../src/apple/versionFinder';
import { getVersionMetadata } from '../../src/apple/versionLookup';
import { appleRequest } from '../../src/apple/request';
import { buildPlist, parsePlist } from '../../src/apple/plist';
import type { Account, Software } from '../../src/types';

vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));

const account: Account = {
  email: 'test@example.invalid', password: 'not-real', appleId: '', store: '143465-19,32',
  firstName: '', lastName: '', passwordToken: 'private-token', directoryServicesIdentifier: '123',
  cookies: [], deviceIdentifier: 'aabbccddeeff', pod: '10',
};
const app = { id: 736536022, bundleID: 'tv.danmaku.bilianime' } as Software;
const metadata = {
  itemId: app.id, softwareVersionExternalIdentifier: 891730218,
  softwareVersionBundleId: app.bundleID, bundleShortVersionString: '9.13.0', bundleVersion: '913000',
  softwareVersionExternalIdentifiers: [100, 891730218], releaseDate: '2026-10-01',
};
function plist(dict: Record<string, unknown>, status = 200) {
  return { status, statusText: '', headers: {}, rawHeaders: [] as [string, string][], body: buildPlist(dict) };
}
function success(overrides: Record<string, unknown> = {}) {
  return plist({ songList: [{ URL: 'https://example.invalid/app.ipa', metadata: { ...metadata, ...overrides }, sinfs: [{ id: 0, sinf: 'AA==' }] }] });
}
function catalog(version: unknown = 891730218, bundleId = app.bundleID) {
  return { status: 200, statusText: '', headers: {}, rawHeaders: [] as [string, string][],
    body: JSON.stringify({ results: { [app.id]: { bundleId, offers: [{ version: { externalId: version } }] } } }) };
}

describe('Apple download and version recovery', () => {
  beforeEach(() => vi.resetAllMocks());

  it('leaves an existing successful download unchanged', async () => {
    vi.mocked(appleRequest).mockResolvedValue(success());
    const result = await getDownloadInfo(account, app);
    expect(result.output.downloadURL).toBe('https://example.invalid/app.ipa');
    expect(appleRequest).toHaveBeenCalledOnce();
  });

  it.each([{}, { songList: [] }, { customerMessage: 'This item is no longer available' }, { failureType: '5002' }])(
    'recovers %j using a pinned storefront iOS version and retains cookies', async (empty) => {
      const first = plist(empty);
      first.rawHeaders = [['set-cookie', 'storeSession=value; Domain=.itunes.apple.com; Path=/; Secure']];
      vi.mocked(appleRequest).mockResolvedValueOnce(first).mockResolvedValueOnce(catalog()).mockResolvedValueOnce(success());
      const result = await getDownloadInfo(account, app);
      const lookup = vi.mocked(appleRequest).mock.calls[1][0];
      expect(lookup.host).toBe('uclient-api.itunes.apple.com');
      expect(lookup.path).toContain('cc=cn');
      expect(lookup.cookies).toBeUndefined();
      expect(lookup.headers).toBeUndefined();
      const retry = vi.mocked(appleRequest).mock.calls[2][0];
      expect(retry.host).toBe('downloaddispatch.itunes.apple.com');
      expect(parsePlist(retry.body!)).toMatchObject({ appExtVrsId: '891730218', guid: account.deviceIdentifier, salableAdamId: app.id });
      expect(retry.cookies).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'storeSession', value: 'value' })]));
      expect(result.updatedCookies).toHaveLength(1);
    },
  );

  it('keeps explicitly requested historical version without a catalog lookup', async () => {
    vi.mocked(appleRequest).mockResolvedValueOnce(plist({})).mockResolvedValueOnce(success({ softwareVersionExternalIdentifier: '100' }));
    await getDownloadInfo(account, app, '100');
    expect(appleRequest).toHaveBeenCalledTimes(2);
    expect(parsePlist(vi.mocked(appleRequest).mock.calls[1][0].body!)).toMatchObject({ appExtVrsId: '100' });
  });

  it.each([{ failureType: '9610' }, { failureType: '2034' }, { customerMessage: 'Account is disabled' }])(
    'does not retry actionable account errors %j', async (error) => {
      vi.mocked(appleRequest).mockResolvedValue(plist(error));
      await expect(getDownloadInfo(account, app)).rejects.toThrow();
      expect(appleRequest).toHaveBeenCalledOnce();
    },
  );

  it('preserves message-only Apple errors', async () => {
    vi.mocked(appleRequest).mockResolvedValue(plist({ customerMessage: 'Account is disabled' }));
    await expect(getDownloadInfo(account, app)).rejects.toThrow('Account is disabled');
  });

  it('does not loop when dispatch also returns an empty list', async () => {
    vi.mocked(appleRequest).mockResolvedValueOnce(plist({})).mockResolvedValueOnce(catalog()).mockResolvedValueOnce(plist({}));
    await expect(getDownloadInfo(account, app)).rejects.toThrow();
    expect(appleRequest).toHaveBeenCalledTimes(3);
  });

  it.each([{ itemId: 1 }, { softwareVersionExternalIdentifier: 1 }, { softwareVersionBundleId: 'wrong.app' }])(
    'rejects mismatched dispatch metadata %j', async (wrong) => {
      vi.mocked(appleRequest).mockResolvedValueOnce(plist({})).mockResolvedValueOnce(catalog()).mockResolvedValueOnce(success(wrong));
      await expect(getDownloadInfo(account, app)).rejects.toThrow();
    },
  );

  it('recovers historical version listing through the same pinned dispatch route', async () => {
    vi.mocked(appleRequest).mockResolvedValueOnce(plist({})).mockResolvedValueOnce(catalog()).mockResolvedValueOnce(success());
    expect((await listVersions(account, app)).versions).toEqual(['891730218', '100']);
  });

  it('recovers the display metadata for the exact historical version', async () => {
    vi.mocked(appleRequest).mockResolvedValueOnce(plist({})).mockResolvedValueOnce(success({ softwareVersionExternalIdentifier: 100 }));
    expect((await getVersionMetadata(account, app, '100')).metadata.displayVersion).toBe('9.13.0');
    expect(appleRequest).toHaveBeenCalledTimes(2);
  });

  it('falls back to the consumer catalog without changing account country', async () => {
    vi.mocked(appleRequest).mockResolvedValueOnce(plist({})).mockResolvedValueOnce({ ...catalog(), body: '{"results":{}}' })
      .mockResolvedValueOnce(catalog('891730218')).mockResolvedValueOnce(success());
    await getDownloadInfo(account, app);
    const lookup = vi.mocked(appleRequest).mock.calls[2][0];
    expect(lookup.path).toContain('platform=iphone');
    expect(lookup.path).toContain('cc=cn');
  });

  it('does not dispatch when catalog metadata belongs to another bundle', async () => {
    vi.mocked(appleRequest).mockResolvedValueOnce(plist({})).mockResolvedValueOnce(catalog(891730218, 'wrong.app'));
    await expect(getDownloadInfo(account, app)).rejects.toThrow();
    expect(appleRequest).toHaveBeenCalledTimes(2);
  });

  it('does not use silent-empty recovery for an HTTP error', async () => {
    vi.mocked(appleRequest).mockResolvedValue(plist({}, 403));
    await expect(getDownloadInfo(account, app)).rejects.toThrow();
    expect(appleRequest).toHaveBeenCalledOnce();
  });
});
