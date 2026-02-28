# Meta (FB/IG) Integration Test Plan

## Preconditions

- `DATABASE_URL` configured and DB initialized.
- `META_APP_SECRET` + `META_VERIFY_TOKEN` configured.
- At least 1 Page connected in CRM Settings -> Connections.
- Webhooks subscribed on Meta side for the Page and its connected IG business account.

## 1) Webhook Verify Test

- Meta "Verify and save" calls:
  - `GET /api/webhooks/meta?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`
- Expect:
  - 200 with exact `hub.challenge` when verify token matches
  - 403 otherwise

## 2) Inbound DM Test (Facebook)

- Send a DM to the connected Facebook Page.
- Expect:
  - `meta_webhook_events` row inserted
  - a lead created/updated with key `fb:<psid>`
  - a message row created with `metadata.kind='dm'`
  - UI receives `new_message` socket event and lead list updates

## 3) Inbound DM Test (Instagram)

- Send a DM to the connected Instagram account.
- Expect:
  - lead key `ig:<igid>`
  - message `metadata.kind='dm'`
  - realtime UI update

## 4) Inbound Comment Test

- Create a comment on a Page post or IG media.
- Expect:
  - message `metadata.kind='comment'`
  - `metadata.comment_id` and `metadata.post_id` stored
  - lead matching by author id (preferred) to avoid duplicates

## 5) Outbound Reply Test (Comment Reply)

- Open lead, set reply mode to `comment`, send message.
- Expect:
  - DB message inserted with `direction='out'`, `status='sent'`
  - Graph API returns id
  - UI sees outgoing message and lead last_message updates

## 6) Outbound Reply Test (DM)

- Ensure DM thread exists first (user has messaged the page/IG).
- Set reply mode `dm`, send.
- Expect:
  - Graph API send success
  - DB outbound status `sent`

## 7) Token Expired / Invalid Token Test

- Replace `meta_pages.page_access_token` with invalid token.
- Trigger an outbound reply.
- Expect:
  - API returns 502 with error text
  - outbound message row updated to `status='failed'`
  - `meta_pages.status` becomes `disconnected` and `last_error` is set

## 8) Duplicate Webhook Event Test

- Re-send the same webhook payload (same `mid` / `comment_id`).
- Expect:
  - no duplicate message rows created
  - unread_count does not increase for duplicates
