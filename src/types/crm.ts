export type LeadStatus = string; // Was: 'new' | 'potential' | 'won' | 'lost';

export interface Lead {
  id: string;
  phone: string;
  name?: string;
  product_name?: string; // Added Product/Order Name
  status: LeadStatus;
  last_message?: string;
  value?: number;
  created_at: string; // ISO Date String
  updated_at: string;
  source: 'whatsapp' | 'facebook' | 'instagram' | 'manual';
  // WhatsApp Metadata
  whatsapp_id?: string;
  source_contact_name?: string;
  source_message?: string;
  is_fast_emit?: boolean; // For tracking initial vs enriched updates
  assignee_id?: string | null; // Worker assignment
  extra_data?: any; // JSON for custom fields
  unread_count?: number;
  last_read_at?: string | null;
  last_inbound_at?: string | null;
  last_outbound_at?: string | null;
  next_followup_due_at?: string | null;
  conversation_closed?: boolean;
  conversation_closed_at?: string | null;
  // Multi-WhatsApp metadata (joined from whatsapp_accounts on read)
  whatsapp_account_id?: string | null;
  whatsapp_account_label?: string | null;
  whatsapp_account_phone?: string | null;
  whatsapp_account_status?: string | null;
  duplicate_lead_count?: number; // # other leads with same (phone, tenant) but different account
}

export type WhatsAppAccountStatus =
  | 'pending'
  | 'qr'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'logged_out'
  | 'error';

export interface WhatsAppAccount {
  id: string;
  tenant_id: string;
  label: string;
  phone_number?: string | null;
  phone_number_normalized?: string | null;
  status: WhatsAppAccountStatus;
  is_default: boolean;
  last_qr_at?: string | null;
  last_connected_at?: string | null;
  last_disconnected_at?: string | null;
  last_error?: string | null;
  deleted_at?: string | null;
  created_at?: string;
  updated_at?: string;
  live?: {
    isReady: boolean;
    qr: boolean;
    number?: string | null;
    error?: string | null;
  } | null;
}

export interface DuplicateLead {
  id: string;
  phone: string;
  name?: string | null;
  status?: string | null;
  whatsapp_account_id?: string | null;
  whatsapp_account_label?: string | null;
  whatsapp_account_phone?: string | null;
  last_inbound_at?: string | null;
  created_at?: string | null;
  message_count?: number;
}

export interface UserPermissions {
  // ─── Lead İdarəetməsi ───────────────────────────
  view_all_leads?: boolean;
  view_unassigned_leads?: boolean;
  // Per-user stage override: a list of pipeline stage IDs where this user
  // sees EVERY lead regardless of assignee, even when view_all_leads is off.
  // Stages NOT in this list still follow the assignee filter for this user.
  // Empty / undefined means "no extra stages — use the global default".
  visible_stage_ids?: string[];
  create_lead?: boolean;
  delete_lead?: boolean;
  change_status?: boolean;
  edit_lead_fields?: boolean;
  assign_lead?: boolean;
  close_conversation?: boolean;
  export_leads?: boolean;

  // ─── Mesajlaşma ─────────────────────────────────
  send_messages?: boolean;
  send_media?: boolean;
  use_templates?: boolean;
  delete_message_history?: boolean;
  view_full_chat?: boolean;
  add_internal_notes?: boolean;

  // ─── Maliyyə ────────────────────────────────────
  view_budget?: boolean;
  edit_budget?: boolean;
  view_revenue?: boolean;
  view_roi?: boolean;

  // ─── Statistika & Hesabatlar ───────────────────
  view_stats?: boolean;
  view_dashboard?: boolean;
  view_analytics?: boolean;
  view_other_operator_stats?: boolean;
  view_audit_log?: boolean;

  // ─── WhatsApp Hesabları ────────────────────────
  view_whatsapp_accounts?: boolean;
  manage_whatsapp_accounts?: boolean;
  view_qr_code?: boolean;
  set_default_account?: boolean;
  view_account_phone?: boolean;

  // ─── Sistem Parametrləri ───────────────────────
  manage_kanban_columns?: boolean;
  create_custom_fields?: boolean;
  manage_routing_rules?: boolean;
  manage_automation_rules?: boolean;
  manage_response_templates?: boolean;
  manage_telegram_notifications?: boolean;
  manage_meta_integration?: boolean;

  // ─── İstifadəçilər ─────────────────────────────
  view_users_list?: boolean;
  manage_users?: boolean;
  manage_user_permissions?: boolean;

  // ─── Təhlükəli Əməliyyatlar ────────────────────
  factory_reset?: boolean;
  delete_all_data?: boolean;
  clear_chat_history?: boolean;
}

export interface User {
  id: string;
  username: string;
  role: 'admin' | 'worker' | 'superadmin' | 'manager' | 'viewer';
  permissions?: UserPermissions;
  tenant_id: string;
  display_name?: string | null;
  created_at?: string;
}

export interface DateRange {
  start: string | null;
  end: string | null;
}

// Supabase Table Definition (for future reference)
/*
  Table: leads
  - id: uuid (PK)
  - phone: text
  - name: text
  - product_name: text
  - status: text
  - last_message: text
  - value: numeric
  - created_at: timestamptz
  - updated_at: timestamptz
  - source: text
*/
