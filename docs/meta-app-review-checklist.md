# Meta App Review Checklist (FB/IG Messaging + Comments)

Use the latest Meta docs. This is a practical checklist for preparing App Review.

## Product + Use Case

- Describe CRM: inbound DM + comments are captured into lead/chat history.
- Operators reply manually from CRM UI.
- No automated spam; no unsolicited bulk messaging.

## Permissions Justification

- DM read: needed to show inbound customer messages inside CRM.
- DM send: needed to let operator reply from CRM.
- Comment read: needed to capture post comments as leads/interactions.
- Comment reply / manage: needed to reply directly under the comment from CRM.

## Required Screens / Screencast

- Connect flow:
  - show Page + IG connected in CRM settings
  - show webhook subscription working
- Inbound:
  - send test DM/comment
  - show it arriving in CRM instantly
  - show persisted history after page refresh
- Outbound:
  - reply from CRM
  - show message delivered in Facebook/Instagram UI

## Compliance / Policy

- Respect Instagram messaging rules (including response windows where applicable).
- Provide a clear end-user privacy policy and data retention policy.
- Ensure deletion requests can be handled (manual or automated pipeline).

## Security

- Webhook signature verification enabled.
- Secrets stored in environment variables.
- No tokens or message content leaked into logs.
