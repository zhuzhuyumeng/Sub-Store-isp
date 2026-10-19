# IPRoyal Expiry Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-side IPRoyal order expiry synchronization to the existing ISP Manager page, matching imported nodes by IP and port while keeping expired nodes in subscriptions.

**Architecture:** Add a focused `iproyal.mjs` API client and a small synchronizer owned by the ISP Manager server. Persist provider metadata on nodes through `IspStore`, expose authenticated-or-open management endpoints alongside existing `/api/isp` routes, and extend the current node table with status and a manual sync control. `ISP_ADMIN_TOKEN` becomes opt-in; `IPROYAL_API_TOKEN` remains server-only.

**Tech Stack:** Node.js 24+, Express, native `fetch`, YAML-independent JSON API client, Node test runner, existing vanilla HTML/CSS/JS frontend.

**Spec:** `docs/superpowers/specs/2026-10-16-iproyal-expiry-sync-design.md`

## Global Constraints

- Modify the existing ISP Manager page in `backend/isp-manager/public`; do not create a second frontend.
- Never expose or log `IPROYAL_API_TOKEN`.
- Expired IPRoyal orders are marked only; node `enabled` and Clash share scope remain unchanged.
- Preserve existing ISP connectivity probes and all current share behavior.
- Tests run with the repository-required Node 24 runtime.

### Task 1: Define the IPRoyal client contract with failing tests

**Files:**
- Create: `backend/isp-manager/test/iproyal.test.mjs`
- Create: `backend/isp-manager/iproyal.mjs`

**Interfaces:**
- Produce `createIprRoyalClient({ baseUrl, token, fetchImpl, timeoutMs })` with `configured`, `listOrders()`, and `syncNodes(nodes)` behavior.
- `syncNodes(nodes)` returns `{ updates, unmatched, fetchedOrders, syncedAt }` and never includes credentials in errors.

- [x] **Step 1: Write tests for paginated requests, token header, matching, expiry and safe failures.**
- [x] **Step 2: Run `node --test backend/isp-manager/test/iproyal.test.mjs` and verify it fails because the client is missing.**
- [x] **Step 3: Implement bounded fetch, response-size guard, pagination, order normalization, IP/port matching, status normalization, and error sanitization.**
- [x] **Step 4: Run the focused test and verify it passes.**

### Task 2: Persist provider metadata and expose synchronization state

**Files:**
- Modify: `backend/isp-manager/store.mjs`
- Modify: `backend/isp-manager/app.mjs`
- Modify: `backend/isp-manager/server.mjs`
- Modify: `backend/isp-manager/test/http.test.mjs`
- Modify: `backend/isp-manager/test/core.test.mjs`

**Interfaces:**
- Add `IspStore.saveIprRoyalSync(updates, summary)` for atomic metadata updates.
- Add `IspStore.iproyalSyncState()` returning non-secret state.
- Add `POST /api/isp/iproyal/sync` and `GET /api/isp/iproyal/status`.
- Server creates the synchronizer only when `IPROYAL_API_TOKEN` is configured and schedules optional interval sync.

- [x] **Step 1: Add failing store and HTTP tests for atomic metadata, expired status retention, open auth without `ISP_ADMIN_TOKEN`, and Bearer auth when configured.**
- [x] **Step 2: Run the focused tests and verify expected failures.**
- [x] **Step 3: Implement metadata validation, atomic save, optional authentication, sync endpoints, startup/manual sync, and interval cleanup.**
- [x] **Step 4: Run focused tests and verify they pass.**

### Task 3: Extend the existing frontend incrementally

**Files:**
- Modify: `backend/isp-manager/public/index.html`
- Modify: `backend/isp-manager/public/app.js`
- Modify: `backend/isp-manager/public/style.css`

**Interfaces:**
- Existing node table gains IPRoyal status and expiry detail in the current health cell.
- Existing top action area gains a manual “同步 IPRoyal” button and non-secret status text.
- No browser Token input and no new route.

- [x] **Step 1: Add markup and client tests or static assertions for the new control and labels.**
- [x] **Step 2: Verify the assertions fail before the markup and behavior exist.**
- [x] **Step 3: Implement loading, manual sync, polling refresh, status rendering and responsive styling without replacing existing interactions.**
- [x] **Step 4: Run the page checks and existing HTTP tests.**

### Task 4: Document configuration and run the complete verification suite

**Files:**
- Modify: `backend/isp-manager/README.md`
- Modify: `backend/isp-manager/server.mjs` help/startup text if needed

- [x] **Step 1: Document `IPROYAL_API_TOKEN`, `IPROYAL_API_URL`, `IPROYAL_SYNC_INTERVAL_MS`, optional `ISP_ADMIN_TOKEN`, matching rules, and expiry-only behavior.**
- [x] **Step 2: Run `node --test backend/isp-manager/test/*.test.mjs` with Node 24 and verify zero failures.**
- [x] **Step 3: Start the live manager without `ISP_ADMIN_TOKEN`, verify the page and status endpoint are reachable, and verify a fake IPRoyal server cannot leak the token.**
- [x] **Step 4: Inspect the final diff and report exact limitations, including that real IPRoyal synchronization requires a configured server token.**
