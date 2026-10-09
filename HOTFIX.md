# RackNerd SAP sign-in hotfix — 2026-10-09

Authorized by Greg after discussing the unmerged authentication fix.

- Official base: `3bc9515ba5df2d02c06fc827dc85232473be9274`.
- Upstream PR #89: `835a54dd773caeaa6ad6b342d5cde1bf3e6ceb29`, merged onto the base without replacing the unrelated download-host fix.
- Local patch: permit only `s.mzstatic.com` and `fpinit.itunes.apple.com` for SAP certificate and exchange calls through Wisp; retain port 443 and existing IP restrictions.
- Regression test: the signature covers exact UTF-8 auth body bytes including non-ASCII password characters, a 2FA code and redirected retry.
- Apple credentials remain in the browser; no real Apple account is required for the diagnostic test.

## Rebuild

The VPS has 1GB RAM. Build platform-independent JavaScript locally, extract and verify the public Apple SAP assets using the upstream extractor, then package with the target-platform runtime dependencies on the VPS.

1. Run `npm ci`, `npm test` and `npm run build` in `frontend/` and `backend/`.
2. From `backend/`, run `DATA_DIR=/tmp/asspp-sap-build-20261009 node --import tsx scripts/extract-sap-assets.mts ../build-artifacts/sap`.
3. Copy `frontend/dist/` into `build-artifacts/frontend/` and `backend/dist/` into `build-artifacts/backend/`.
4. Transfer the tracked source plus `build-artifacts/` into `/opt/assppweb/source-hotfix-20261009` on the VPS.
5. Build `Dockerfile.runtime` with `BUILD_COMMIT` set to the local source commit and `BUILD_DATE` to UTC build time. Image tag: `assppweb-local:sap-20261009`.
6. Back up Compose/environment/data, retain the prior official image, change only the existing assppweb service image, then run `docker compose up -d --no-deps assppweb` in `/opt/assppweb`.

## Verification and removal

Test HTTPS homepage, authenticated API, digest-verified SAP assets and signed synthetic Apple authentication via the actual browser/Wisp stack. Real-account sign-in must be confirmed by Greg.

Rollback: restore the pre-hotfix Compose file and use `docker compose up -d --no-deps assppweb`; no data-volume removal or image prune. When official upstream includes and verifies SAP signing, replace this temporary local image with the verified official image and remove the override. Do not run `docker compose pull` on this local-only tag.
