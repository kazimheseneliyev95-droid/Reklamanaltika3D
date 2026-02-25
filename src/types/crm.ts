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
  source: 'whatsapp' | 'manual';
  // WhatsApp Metadata
  whatsapp_id?: string;
  source_contact_name?: string;
  source_message?: string;
  is_fast_emit?: boolean; // For tracking initial vs enriched updates
  assignee_id?: string | null; // Worker assignment
}

export interface User {
  id: string;
  username: string;
  role: 'admin' | 'worker' | 'superadmin';
  tenant_id: string;
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
