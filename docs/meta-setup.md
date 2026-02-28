# Meta (Facebook/Instagram) DM + Comments -> CRM Integration

This repo already supports WhatsApp. This document covers adding and operating Facebook/Instagram DM + comment ingestion via Meta Graph API webhooks, with CRM-side replies.

## 1) Meta Prerequisites

- Instagram account must be Business/Creator.
- Instagram account must be connected to a Facebook Page.
- Meta Developers App must exist (Business verified for production is usually required).
- CRM server must be publicly reachable over HTTPS.

## 2) Required Products / API Surfaces

- Webhooks (Meta)
- Messenger API (Facebook Page inbox)
- Instagram Messaging (Instagram DM)
- Comments read + reply APIs

## 3) Permissions (verify latest in Meta docs)

Meta permission names change over time. Use the current Meta docs as source of truth.

Typical needs for production:

- Facebook Page DM read/reply: permissions related to Page messaging.
- Instagram DM read/reply: permissions related to Instagram messaging.
- Comments: read + manage/reply permissions for Pages/Instagram.

App Review notes:

- You will need screencast + detailed justification explaining why you need DM read, DM send, comment read, comment reply.
- You must demonstrate that the messages are displayed in CRM UI and that the reply is triggered by a human operator.

## 4) CRM Environment Variables

Set these in the server runtime environment (do not commit secrets):

- `META_APP_SECRET` (required) - used for webhook signature verification.
- `META_VERIFY_TOKEN` (required) - used for webhook verification handshake.
- `META_APP_ID` (optional) - enables short-lived -> long-lived user token exchange.
- `META_EVENT_PROCESSOR_ENABLED` (optional, default: true)
- `META_EVENT_PROCESSOR_BATCH` (optional, default: 20)
- `META_EVENT_PROCESSOR_INTERVAL_MS` (optional, default: 1500)

- `META_OUTBOX_ENABLED` (optional, default: true)
- `META_OUTBOX_BATCH` (optional, default: 15)
- `META_OUTBOX_INTERVAL_MS` (optional, default: 1200)
- `META_OUTBOX_MAX_ATTEMPTS` (optional, default: 8)

## 5) Webhook Endpoints

The backend exposes these endpoints:

- `GET /api/webhooks/meta` (verify)
- `POST /api/webhooks/meta` (events)

Aliases also exist:

- `GET /webhooks/meta`
- `POST /webhooks/meta`

Webhook verification:

- Meta calls `GET` with `hub.mode`, `hub.verify_token`, `hub.challenge`.
- Server compares `hub.verify_token` with `META_VERIFY_TOKEN` and returns `hub.challenge`.

Webhook security:

- Server validates `X-Hub-Signature-256` against the raw request bytes using HMAC SHA-256 with `META_APP_SECRET`.

## 6) Multi-Tenant Mapping (Workspace/Tenant)

Multi-company is implemented as `tenant_id` across DB tables.

- Each tenant can connect multiple Meta Pages.
- Incoming webhook `entry.id` is matched against `meta_pages.page_id` (object=`page`) or `meta_pages.ig_business_id` (object=`instagram`).

## 7) Durable Delivery (No Event Loss On Restart)

Inbound Meta webhook payloads are written to `meta_webhook_events` immediately, then processed by an internal queue processor.

- If the API restarts, queued events remain in DB and will be processed after boot.
- Processing uses DB locking (`FOR UPDATE SKIP LOCKED`) patterns to avoid double processing.
- Idempotency is enforced at the message-id level so duplicate webhooks do not inflate unread counts.

Tables:

- `meta_pages` - connected Page + Page access token + optional IG business id.
- `meta_webhook_events` - durable raw webhook queue.
- `meta_user_tokens` - optional stored user token for later re-discover/reconnect.

## 8) Connecting Pages From CRM UI

In Settings -> Connections -> Facebook/Instagram:

1. Paste a user access token (EAAG...).
2. Click "Səhifələri gətir" to list Pages accessible by that user.
3. Select Pages and click connect.

The backend:

- Optionally exchanges the user token to a long-lived token (if `META_APP_ID` + `META_APP_SECRET` are set).
- Fetches `me/accounts` to get Page access tokens.
- Stores Page tokens in `meta_pages`.
- Attempts to call `/subscribed_apps` for both Page + IG to enable webhooks.

## 9) Reply Flows (CRM -> Meta)

CRM UI uses:

- `POST /api/meta/leads/:id/reply` with `{ body, mode }`
  - `mode=comment` -> reply under the last inbound comment
  - `mode=private` -> private reply (if supported)
  - `mode=dm` -> DM reply (requires an existing DM thread)

Outbound messages are recorded in DB with status transitions:

- `pending` -> `sending` when claimed by outbox worker
- `sending` -> `sent` on Graph success
- `sending` -> `pending` on retryable failure (with backoff)
- `sending` -> `failed` on permanent failure / max attempts

## 10) Notes / Operational Constraints

- Instagram messaging has policy constraints (including 24 hour window rules depending on product and permissions). Handle "cannot reply" errors and surface to operators.
- Rate limits: the system uses queue retries for inbound and marks outbound failures with details.
