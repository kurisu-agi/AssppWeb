# RackNerd SAP sign-in hotfix — 2026-10-09

Authorized by Greg after discussing the unmerged authentication fix.

- Official base: `3bc9515ba5df2d02c06fc827dc85232473be9274`.
- Upstream PR #89: `835a54dd773caeaa6ad6b342d5cde1bf3e6ceb29`, merged onto the base without replacing the unrelated download-host fix.
- Local patch: permit only `s.mzstatic.com` and `fpinit.itunes.apple.com` for SAP certificate and exchange calls through Wisp; retain port 443 and existing IP restrictions.
- Regression test: the signature covers exact UTF-8 auth body bytes including non-ASCII password characters, a 2FA code and redirected retry.
- Apple credentials remain in the browser; no real Apple account is required for the diagnostic test.
- Live browser/VPS experiments: signed requests to the bag-advertised legacy endpoint returned 204/HTML errors; the signed native `/auth/v1/native/fast/` endpoint returned HTTP 200 with valid plist. Added one conditional fallback for signed legacy 204/403/404/503 or Location-less 301 responses that do not contain plist. Valid plist authentication errors retain their original handling. Each fallback signs the new attempt; existing GUID and cookie handling are preserved.

## Rebuild

The VPS has 1GB RAM. Build platform-independent JavaScript locally, extract and verify the public Apple SAP assets using the upstream extractor, then package with the target-platform runtime dependencies on the VPS.

1. Run `npm ci`, `npm test` and `npm run build` in `frontend/` and `backend/`.
2. From `backend/`, run `DATA_DIR=/tmp/asspp-sap-build-20261009 node --import tsx scripts/extract-sap-assets.mts ../build-artifacts/sap`.
3. Copy `frontend/dist/` into `build-artifacts/frontend/` and `backend/dist/` into `build-artifacts/backend/`.
4. Transfer the tracked source plus `build-artifacts/` into `/opt/assppweb/source-hotfix-20261009` on the VPS.
5. Build `Dockerfile.runtime` with `BUILD_COMMIT` set to the local source commit and `BUILD_DATE` to UTC build time. Deployed image tag: `assppweb-local:sap-20261009-v2` (runtime source commit `2140428152396c21b370cf3dcf12723c657bc203`). The initial `sap-20261009` tag was an isolated test build without the native endpoint fallback.
6. Back up Compose/environment/data, retain the prior official image, change only the existing assppweb service image, then run `docker compose up -d --no-deps assppweb` in `/opt/assppweb`.

## Verification and removal

Test HTTPS homepage, authenticated API, digest-verified SAP assets and signed synthetic Apple authentication via the actual browser/Wisp stack. Real-account sign-in must be confirmed by Greg.

Rollback: restore the pre-hotfix Compose file and use `docker compose up -d --no-deps assppweb`; no data-volume removal or image prune. When official upstream includes and verifies SAP signing, replace this temporary local image with the verified official image and remove the override. Do not run `docker compose pull` on this local-only tag.

## v3 authentication transport recovery

- Evidence: ipatool PR #562 (`https://github.com/majd/ipatool/pull/562`) isolates authentication connections and backs off on malformed Apple responses. The locally inspected ipatool revision is `e3932cec31765b025b8e3edd6797e9e69c3c3fa8`.
- An isolated browser spike retained the bag-advertised legacy URL, existing ASCII SAP device identity, body and headers. Using a fresh `libcurl.HTTPSession` per auth request, with `Connection: close` and a 10-second wait, returned a valid synthetic credential-check plist on attempt two through both Mac and VPS egress. This supports a transport/recovery patch, not a claim that all Apple failures are caused by pooling.
- Only authentication gets an isolated session. The response body is consumed before closing, including failure paths. SAP setup and downloads retain the normal shared session. Cookies remain managed explicitly in the browser and each retry is re-signed.
- Three total legacy/native-start attempts, with default 10/20-second delays; honor numeric or HTTP-date `Retry-After` values up to 30 seconds, stop for longer waits. Retry only malformed 204/403/404/429/5xx and Location-less 301. A valid plist credential error is terminal. Preserve the prior native fallback only after legacy recovery is exhausted, adding at most one call without resetting the transient retry budget; do not fall back when Apple supplied `Retry-After`.
- Error diagnostics include only HTTP statuses and the endpoint hostname; never Apple response bodies, credentials, cookies, tokens or URL queries.
- Do not change Content-Type or hardware-ID encoding: the controlled probes did not support those changes. Real-account login still requires Greg's browser verification; a nonexistent account's `codeRequired` response is only a protocol-response check.
- Candidate image: `assppweb-local:sap-20261009-v3`; preserve v2 and the original rollback image and deploy only after isolated VPS checks.
- Type-check compatibility: narrow the existing PBKDF2 salt parameter to `Uint8Array<ArrayBuffer>`; this is type-only, with no encryption-format change.

### Missing legacy trailing slash identified

The initial connection/backoff candidate returned a protocol plist in only 1/3 complete local browser flows; do not treat backoff alone as a completed repair. The official ipatool 2.6.0 binary (release SHA-256 verified) returned parseable synthetic credential-check responses in three native runs on the same Mac egress. Its implementation includes `f9aa6536cd2db16ab93f663d8731e4300921c132` (`https://github.com/majd/ipatool/commit/f9aa6536cd2db16ab93f663d8731e4300921c132`): normalize the initial legacy `.../wa/authenticate` path to `.../wa/authenticate/`, retaining host and query.

Controlled browser A/B: preserve the original ASCII signer identity, request body, Content-Type, HTTP/1.1 and GUID query; adding only the missing legacy path slash returned HTTP 200 with plist on the first request through both Mac and VPS egress. Removing GUID queries or changing encoding/HTTP version was not consistently successful. v3 now narrowly normalizes only the known legacy authentication path on buy/pod hosts, and reapplies normalization on redirects, including relative redirects. Non-authentication paths remain untouched. Connection isolation and bounded recovery remain as resilience measures, not the principal path fix. Real-account sign-in is still unverified until Greg tests it in his browser.

### v3 deployment verification

Deployed runtime source `5a7c2903f9f6638b6ac0d0e218befd2cf8e3c96c`, image `assppweb-local:sap-20261009-v3`, image ID `sha256:d3c65a915ced0234c3b7fe3a78fa4debcf64b3c08a3b3ac5e20ccd714299b423`, build date `2026-10-09T10:02:41Z`. Frontend 126 tests, TypeScript check and production build passed. Full unmodified built-browser synthetic flows returned valid credential-check plists in 3/3 local, 3/3 isolated VPS and 3/3 production HTTPS contexts, including newly generated device IDs. Formal origin checks: homepage 200, protected API 401 anonymously and 200 with retained access token, expected runtime source revision. Original data volume and access-password configuration retained; other production service start timestamps unchanged. Pre-v3 restricted backup is `/opt/assppweb/backups/20261009-auth-v3/`, including Compose, optional environment, image ID and 65MB data archive. Retain v2 and pre-SAP images. Source and source Git bundle are preserved separately from v2. Real-account authentication, actual 2FA and downloads still require Greg's verification.
