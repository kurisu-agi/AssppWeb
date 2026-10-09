import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import { authenticate } from "../../src/apple/authenticate";
import { appleRequest } from "../../src/apple/request";
import { fetchBag } from "../../src/apple/bag";
import { prepareSigner } from "../../src/apple/sap/client";

vi.mock("../../src/apple/sap/client", () => ({
  prepareSigner: vi.fn(),
}));

vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

vi.mock("../../src/apple/bag", () => ({
  fetchBag: vi.fn(),
  defaultAuthURL:
    "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
}));

describe("apple/authenticate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('signs the exact UTF-8 body again after a redirect, including a 2FA code', async () => {
    const endpoints = {
      certificateURL: 'https://s.mzstatic.com/sap/setupCert.plist',
      setupURL: 'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy',
      version: 200,
    };
    vi.mocked(fetchBag).mockResolvedValue({
      authURL: 'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate',
      sapEndpoints: endpoints,
    });
    const sign = vi.fn().mockResolvedValueOnce('signature-one').mockResolvedValueOnce('signature-two');
    vi.mocked(prepareSigner).mockResolvedValue({ sign } as Awaited<ReturnType<typeof prepareSigner>>);
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({
        status: 302, statusText: 'Found', rawHeaders: [], body: '',
        headers: { location: 'https://p25-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate' },
      })
      .mockResolvedValueOnce({
        status: 200, statusText: 'OK', headers: {}, rawHeaders: [],
        body: buildPlist({ accountInfo: { appleId: 'test@example.invalid', address: { firstName: 'Test', lastName: 'User' } } }),
      });

    await authenticate('test@example.invalid', '密碼<&', '123456', undefined, 'aabbccddeeff');

    expect(prepareSigner).toHaveBeenCalledWith('aabbccddeeff', endpoints);
    expect(sign).toHaveBeenCalledTimes(2);
    for (const [index, args] of vi.mocked(appleRequest).mock.calls.entries()) {
      const sent = args[0];
      expect(Array.from(sign.mock.calls[index][0])).toEqual(Array.from(new TextEncoder().encode(sent.body)));
      expect(sent.headers?.['X-Apple-ActionSignature']).toBe(index === 0 ? 'signature-one' : 'signature-two');
      expect(sent.body).toContain('密碼&lt;&amp;123456');
    }
  });

  it("sets guid query exactly once from bag endpoint", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?foo=1&guid=old-value",
    });
    vi.mocked(appleRequest).mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      rawHeaders: [],
      body: buildPlist({
        accountInfo: {
          appleId: "test@example.com",
          address: {
            firstName: "Test",
            lastName: "User",
          },
        },
        passwordToken: "token",
        dsPersonId: "123",
      }),
    });

    await authenticate(
      "test@example.com",
      "password",
      undefined,
      undefined,
      "aabbccddeeff",
    );

    const requestCall = vi.mocked(appleRequest).mock.calls[0][0];
    const endpoint = new URL(`https://${requestCall.host}${requestCall.path}`);

    expect(endpoint.searchParams.get("guid")).toBe("aabbccddeeff");
    expect(endpoint.searchParams.getAll("guid")).toHaveLength(1);
    expect(endpoint.searchParams.get("foo")).toBe("1");
  });
});
