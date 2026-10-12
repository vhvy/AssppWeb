# Browser SAP authentication

The signing engine and asset extractor are ported from
[AssppWeb PR #89](https://github.com/Lakr233/AssppWeb/pull/89)
(`835a54dd773caeaa6ad6b342d5cde1bf3e6ceb29`), based on ipatool's
SAP implementation. URL normalization follows PR #91; transient login
retries follow PR #93.

Apple's public CommerceKit/CoreFP assets are extracted and digest-verified
by the backend. Signing, including the exact UTF-8 authentication body,
stays entirely in a browser Web Worker. Certificate and key exchange
requests travel through the encrypted Wisp tunnel. The backend never
receives a plaintext authentication body or a signing request.

`client.ts` serializes setup and signing so concurrent accounts cannot close
each other's active worker. The singleton is bound to device identifier and
SAP endpoints, reused for two-factor authentication and rebuilt on account
switches. Worker failures and timeouts release pending calls. Browser cache
write failures fall back to the already verified in-memory assets.

The vendored Unicorn 2.1.4 WASM engine is reproduced with
`bash frontend/scripts/unicorn-wasm-patch/build.sh` (Docker required).
Upstream license texts are retained in `vendor/COPYING*`.
Apple assets are downloaded at image build time, not committed to Git.
Local Compose builds use `compose.local.yml` as an override.

Verification:

- `npm test` in frontend and backend covers authentication normalization,
  replay signatures/cookies, bounded retries, worker lifecycle and asset routes.
- `frontend/tests/sap/machine-live.mjs` checks the real emulator and assets
  without credentials. Run from backend with
  `SAP_ASSET_DIR=<flat asset directory> node --import tsx ../frontend/tests/sap/machine-live.mjs`.
- Browser smoke verification on 2026-10-11: development and production builds
  completed live SAP setup over Wisp and received HTTP 200 + a plist for
  deliberately fictional credentials. This verifies protocol acceptance,
  not successful real-account authentication.
