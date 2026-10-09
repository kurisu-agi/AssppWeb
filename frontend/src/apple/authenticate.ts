import { appleRequest } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import { fetchBag, defaultAuthURL, normalizeAuthURL } from "./bag";
import { prepareSigner } from "./sap/client";
import { authRetryDelay, isUnexpectedAuthResponse, MAX_AUTH_ATTEMPTS, waitForAuthRetry } from './authRecovery';
import i18n from "../i18n";
import type { Account, Cookie } from "../types";

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly codeRequired: boolean = false,
  ) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export async function authenticate(
  email: string,
  password: string,
  code?: string,
  existingCookies?: Cookie[],
  deviceId: string = "",
): Promise<Account> {
  let cookies: Cookie[] = existingCookies ? [...existingCookies] : [];
  let storeFront = "";
  const responseStatuses: number[] = [];

  const defaultAuthEndpoint = new URL(defaultAuthURL);
  defaultAuthEndpoint.searchParams.set("guid", deviceId);
  let requestHost = defaultAuthEndpoint.hostname;
  let requestPath = `${defaultAuthEndpoint.pathname}${defaultAuthEndpoint.search}`;

  const bag = await fetchBag(deviceId);
  const authEndpoint = new URL(normalizeAuthURL(bag.authURL));
  authEndpoint.searchParams.set("guid", deviceId);
  requestHost = authEndpoint.hostname;
  requestPath = `${authEndpoint.pathname}${authEndpoint.search}`;

  // When the bag advertises the SAP signing protocol, every request to the
  // auth endpoint must carry X-Apple-ActionSignature over its body bytes.
  // The signer sees only the hardware ID and public Apple assets — never the
  // password — because signing happens here in the browser. It is kept as a
  // singleton between attempts (2FA retries reuse the same session).
  let sapSigner = null as Awaited<ReturnType<typeof prepareSigner>> | null;
  if (bag.sapEndpoints) {
    sapSigner = await prepareSigner(deviceId, bag.sapEndpoints);
  }

  let currentAttempt = 0;
  let redirectAttempt = 0;
  let usedAuthFallback = false;

  while (currentAttempt < MAX_AUTH_ATTEMPTS && redirectAttempt <= 3) {
    currentAttempt++;

    try {
      const body: Record<string, string> = {
        appleId: email,
        attempt: code ? "2" : "4",
        guid: deviceId,
        password: code ? `${password}${code}` : password,
        rmp: "0",
        why: "signIn",
      };

      const plistBody = buildPlist(body);

      const headers: Record<string, string> = {
        "Content-Type": "application/x-apple-plist",
      };

      if (sapSigner) {
        // The signature must cover the exact bytes on the wire; libcurl sends
        // the body string as UTF-8, so sign its encoded form.
        headers["X-Apple-ActionSignature"] = await sapSigner.sign(
          new TextEncoder().encode(plistBody),
        );
      }

      const response = await appleRequest({
        method: "POST",
        host: requestHost,
        path: requestPath,
        headers,
        body: plistBody,
        cookies,
        freshConnection: true,
      });

      responseStatuses.push(response.status);

      cookies = extractAndMergeCookies(response.rawHeaders, cookies);

      // Read store front
      const storeHeader = response.headers["x-set-apple-store-front"];
      if (storeHeader) {
        const parts = storeHeader.split("-");
        if (parts[0]) {
          storeFront = parts[0];
        }
      }

      // Read pod
      const podHeader = response.headers["pod"];
      const pod = podHeader || undefined;

      // Prefer the bag endpoint with fresh connections and bounded backoff.
      // Keep the existing native fallback only after legacy recovery fails;
      // this adds at most one request, without resetting the retry budget.
      const isLegacyHost = /^(?:buy|p\d+-buy)\.itunes\.apple\.com$/.test(requestHost);
      const brokenLegacyResponse =
        [204, 403, 404, 503].includes(response.status) ||
        (response.status === 301 && !response.headers["location"]);

      if (isUnexpectedAuthResponse(response) && currentAttempt < MAX_AUTH_ATTEMPTS) {
        const delay = authRetryDelay(currentAttempt, response.headers['retry-after']);
        if (delay === null) {
          throw new Error(i18n.t('errors.auth.waitRequested'));
        }
        await waitForAuthRetry(delay);
        continue;
      }
      if (
        sapSigner &&
        !usedAuthFallback &&
        !response.headers["retry-after"] &&
        isLegacyHost &&
        brokenLegacyResponse &&
        !/<plist[\s>]/.test(response.body)
      ) {
        const fallback = new URL(defaultAuthURL);
        fallback.searchParams.set("guid", deviceId);
        requestHost = fallback.hostname;
        requestPath = `${fallback.pathname}${fallback.search}`;
        usedAuthFallback = true;
        currentAttempt--;
        continue;
      }

      // Handle redirect. The native /fast auth host can answer with 301 as
      // well as the usual 302, so follow the full set of redirect statuses.
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers["location"];
        if (!location) {
          throw new Error(i18n.t('errors.auth.unexpectedResponse', {
            status: response.status,
            host: requestHost,
            attempts: responseStatuses.join(' → '),
          }));
        }
        const url = new URL(normalizeAuthURL(new URL(location, `https://${requestHost}${requestPath}`).toString()));
        requestHost = url.hostname;
        requestPath = url.pathname + url.search;
        currentAttempt--;
        redirectAttempt++;
        continue;
      }

      // Handle non-plist responses (e.g. 403 with empty body)
      if (!response.body.trim()) {
        throw new Error(
          i18n.t('errors.auth.unexpectedResponse', {
            status: response.status,
            host: requestHost,
            attempts: responseStatuses.join(' → '),
          }),
        );
      }

      if (!/<plist[\s>]/.test(response.body)) {
        throw new Error(i18n.t('errors.auth.unexpectedResponse', {
          status: response.status,
          host: requestHost,
          attempts: responseStatuses.join(' → '),
        }));
      }

      const dict = parsePlist(response.body) as Record<string, any>;

      // Check for 2FA requirement
      if (
        dict.failureType === "" &&
        !code &&
        dict.customerMessage === "MZFinance.BadLogin.Configurator_message"
      ) {
        throw new AuthenticationError(
          i18n.t("errors.auth.requiresVerification"),
          true,
        );
      }

      const failureMessage =
        (dict.dialog as Record<string, any>)?.explanation ??
        dict.customerMessage;

      const accountInfo = dict.accountInfo as Record<string, any>;
      if (!accountInfo) {
        throw new Error(
          failureMessage ?? i18n.t("errors.auth.missingAccountInfo"),
        );
      }

      const address = accountInfo.address as Record<string, any>;
      if (!address) {
        throw new Error(failureMessage ?? i18n.t("errors.auth.missingAddress"));
      }

      const account: Account = {
        email,
        password,
        appleId: (accountInfo.appleId as string) ?? "",
        store: storeFront,
        firstName: (address.firstName as string) ?? "",
        lastName: (address.lastName as string) ?? "",
        passwordToken: (dict.passwordToken as string) ?? "",
        directoryServicesIdentifier: String(dict.dsPersonId ?? ""),
        cookies,
        deviceIdentifier: deviceId,
        pod,
      };

      return account;
    } catch (e) {
      if (e instanceof AuthenticationError) {
        throw e;
      }
      // Valid credential failures are terminal, not transient transport errors.
      throw e;
    }
  }

  throw new Error(i18n.t("errors.auth.unknownReason"));
}
