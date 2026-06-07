-- Max-speed tenant-scoped indexes (zero-downtime: CONCURRENTLY, idempotent).
-- psql autocommit runs each CREATE INDEX CONCURRENTLY in its own txn.

-- getLeads per-row next-due follow-up LATERAL (status='open' MIN(due_at)); old idx lacked status filter
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_followups_open_lead ON follow_ups (tenant_id, lead_id, due_at) WHERE status = 'open';

-- global follow-up due-reminder background job; tenant-leading idx can't drive a global scan
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_followups_due_scan ON follow_ups (due_at) WHERE status = 'open' AND notified_at IS NULL;

-- global overdue background job
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_followups_overdue_scan ON follow_ups (due_at) WHERE status = 'open' AND overdue_notified_at IS NULL;

-- global SLA reply-warning scan (conversation_closed=false AND last_inbound_at NOT NULL)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_sla_unanswered ON leads (last_inbound_at) WHERE conversation_closed = false AND last_inbound_at IS NOT NULL;

-- chat-history phone branch of (lead_id=$ OR phone=$) + by-phone message fetch
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_tenant_phone_created ON messages (tenant_id, phone, created_at DESC);

-- analytics first-response CTE driving filter (messages WHERE tenant_id AND created_at<=X)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_tenant_created ON messages (tenant_id, created_at);

-- lead-story audit lookup; audit_logs had only its PK before this
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_logs_tenant_entity ON audit_logs (tenant_id, entity_type, entity_id, created_at DESC);

-- routing-rules stats GROUP BY + per-tenant audit feed
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_logs_tenant_action_created ON audit_logs (tenant_id, action, created_at DESC);
