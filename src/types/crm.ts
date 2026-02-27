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
}

export interface UserPermissions {
  view_all_leads?: boolean;
  create_lead?: boolean;
  delete_lead?: boolean;
  change_status?: boolean;
  view_budget?: boolean;
  edit_budget?: boolean;
  send_messages?: boolean;
  use_templates?: boolean;
  delete_message_history?: boolean;
  send_media?: boolean;
  view_stats?: boolean;
  view_roi?: boolean;
  view_other_operator_stats?: boolean;
  manage_users?: boolean;
  manage_kanban_columns?: boolean;
  create_custom_fields?: boolean;
  factory_reset?: boolean;
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
