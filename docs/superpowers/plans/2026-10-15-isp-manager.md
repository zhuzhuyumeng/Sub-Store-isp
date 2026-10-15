# ISP Manager Implementation Plan

> Execute inline with test-driven-development; requesting-code-review provides the final independent review.

**Goal:** Ship an additive ISP management service and UI with four selectable import formats and live Clash sharing.
**Architecture:** Standalone Node service under backend/isp-manager, independent durable JSON store and token auth, same-origin static UI.
**Tech Stack:** Node 24+, Express (existing dependency), yaml (existing dependency), native HTML/CSS/JS, node:test.
**Spec:** ../specs/2026-10-15-isp-manager-design.md

## Global Constraints
- Only add files, leave all existing tracked files unchanged.
- Four exact format labels from the screenshot; HTTP/HTTPS/SOCKS5 selected separately.
- No production credentials in tests, docs, logs or demo fixtures.
- Persist before publishing in-memory state; share cannot widen its stored scope.

## Tasks
- [x] Parser + store: test four formats, IPv6, password punctuation, invalid input, 10k imports, dedup, update, atomic failure and restart. Add parser.mjs, store.mjs and test/core.test.mjs. Verify with node --test isp-manager/test/core.test.mjs.
- [x] Service + exports: add clash.mjs, app.mjs, server.mjs and HTTP integration tests. Verify authorization, scoped full/provider YAML, live edits, revocation/expiry, public-base URL, invalid requests, isolated persistence.
- [x] UI + delivery: add public/index.html, app.js, style.css; import preview, CRUD/batch, filters/paging, share create/copy/revoke, login/logout. README includes startup, reverse proxy and credential handling. Verify in browser at desktop and mobile widths; run full targeted tests and upstream baseline; independent review; correct findings and preserve branch for user review.

## Implementation contracts
parseImport({content, format, protocol, group}) -> {rows:[{line, node}], errors:[{line,message}], total}; node fields match spec.
IspStore({file}) exposes state and synchronous transaction(mutator), import(input,{preview=false}), list(query), update(id,patch), batch({ids,action,group}), createShare(input), listShares(), revokeShare(id), resolveShare(token).
createApp({store,adminToken,publicBaseUrl}) -> Express app. JSON success envelope {data}, errors {error:{message}}. API prefix /api/isp.
GET /api/isp/nodes, POST /api/isp/import/preview, POST /api/isp/import, PATCH /api/isp/nodes/:id, POST /api/isp/nodes/batch; GET/POST /api/isp/shares, DELETE /api/isp/shares/:id; GET /s/:token/clash.yaml and /s/:token/provider.yaml.

## Progress
- Original two uncommitted files reverted with user approval; clean upstream master.
- Native worktree creation unavailable because chat cwd is parent of repo; Git worktree fallback ../Sub-Store-isp-manager branch codex/isp-manager.
- Existing dependency directory copied to worktree; Node 24.19.0 available in bundled runtime.

## Verification results
- 19 new tests pass, including long hostname restart regression.
- Existing upstream baseline: 824 passing.
- Browser: login, selectable format, invalid-row preview, import, selected share creation, clipboard copy, edit save, 390px viewport and import modal. Console warnings/errors empty.
- Independent code-review dispatch failed three times with tool transport/decryption errors; no independent verdict was obtained. Root reviewed parser, store, auth, export and UI, fixing long generated names and stale-session responses.
- User requested retaining original base: preserve codex/isp-manager worktree without merge or push.
