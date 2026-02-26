// CRM Settings — persisted in localStorage as 'crm_settings'
// Custom fields can be: text, number, select (dropdown)

export type FieldType = 'text' | 'number' | 'select';

export interface CustomField {
    id: string;
    label: string;       // Display name (e.g. "Rayon")
    type: FieldType;
    options?: string[];  // Only for type='select'
    required?: boolean;
}

export interface PipelineStage {
    id: string;      // ID sent to database
    label: string;   // UI Display Name
    color: string;   // Color theme (e.g. 'blue', 'purple', 'green', 'slate')
}

/**
 * AutoRule – if a message contains `keyword`, the lead is automatically
 * moved to `targetStage`. Optionally, a number extracted from the message
 * is written to the lead's `value` (budget) field.
 */
export interface AutoRule {
    id: string;
    enabled: boolean;
    keyword: string;          // Substring to search for in message (case-insensitive)
    targetStage: string;      // Pipeline stage ID to move the lead to
    extractValue: boolean;    // Extract first number from message → lead.value
    currencyTag?: string;     // e.g. "azn" – if set, only extracts number if this tag is adjacent
    fixedValue?: number;      // Fixed value to apply if matched
    note?: string;            // Optional human-readable description
}

// Route / categorize leads based on message content
export interface RoutingRule {
    id: string;
    enabled: boolean;
    fieldId: string;      // custom field id (typically select)
    setValue: string;     // value to set when matched
    keywords: string[];   // keywords to match (case-insensitive substring)
    matchMode?: 'any' | 'all';
    targetStage?: string; // optional: also move stage
}

export interface CRMSettings {
    customFields: CustomField[];
    pipelineStages: PipelineStage[];
    autoRules: AutoRule[];
    routingRules?: RoutingRule[];
}

function getApiBase(): string {
    const fromStorage = localStorage.getItem('crm_server_url') || '';
    if (fromStorage) return fromStorage;
    // In production the API is served from the same origin
    if (import.meta.env.PROD) return window.location.origin;
    return 'http://localhost:4000';
}

const getStorageKey = () => `crm_settings_${localStorage.getItem('crm_tenant_id') || 'admin'}`;

const DEFAULT_FIELDS: CustomField[] = [
    {
        id: 'product_name',
        label: 'Maraqlandığı Məhsul',
        type: 'text',
    },
];

const DEFAULT_STAGES: PipelineStage[] = [
    { id: 'new', label: 'Yeni', color: 'blue' },
    { id: 'potential', label: 'Kvalifikasiya', color: 'purple' },
    { id: 'won', label: 'Satış', color: 'green' },
    { id: 'lost', label: 'Uğursuz', color: 'slate' },
];

const DEFAULT_RULES: AutoRule[] = [
    {
        id: 'rule_price',
        enabled: true,
        keyword: 'qiymət',
        targetStage: 'potential',
        extractValue: true,
        note: 'Qiymət haqqında danışıqlar',
    },
    {
        id: 'rule_buy',
        enabled: true,
        keyword: 'sifariş',
        targetStage: 'won',
        extractValue: false,
        note: 'Sifariş vermək istəyir',
    },
];

export function loadCRMSettings(): CRMSettings {
    try {
        const raw = localStorage.getItem(getStorageKey());
        if (raw) {
            const parsed = JSON.parse(raw) as CRMSettings;
            if (!parsed.pipelineStages || parsed.pipelineStages.length === 0) {
                parsed.pipelineStages = DEFAULT_STAGES;
            }
            if (!parsed.autoRules) {
                parsed.autoRules = DEFAULT_RULES;
            }
            if (!parsed.routingRules) {
                parsed.routingRules = [];
            }
            return parsed;
        }
    } catch { }
    return { customFields: DEFAULT_FIELDS, pipelineStages: DEFAULT_STAGES, autoRules: DEFAULT_RULES, routingRules: [] };
}

export async function saveCRMSettings(settings: CRMSettings): Promise<void> {
    localStorage.setItem(getStorageKey(), JSON.stringify(settings));
    try {
        const token = localStorage.getItem('crm_auth_token');
        if (!token) return;
        const serverUrl = getApiBase();
        const res = await fetch(`${serverUrl}/api/settings`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ settings })
        });
        if (!res.ok) {
            let msg = 'Failed to sync settings to server';
            try {
                const data = await res.json();
                msg = data?.error || msg;
            } catch { }
            throw new Error(msg);
        }
    } catch (err) {
        console.error('Failed to sync settings to server', err);
        throw err;
    }
}

export async function syncCRMSettingsFromServer(): Promise<CRMSettings | null> {
    try {
        const token = localStorage.getItem('crm_auth_token');
        if (!token) return null;
        const serverUrl = getApiBase();
        const res = await fetch(`${serverUrl}/api/settings`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            const data = await res.json();
            if (data.settings) {
                localStorage.setItem(getStorageKey(), JSON.stringify(data.settings));
                return data.settings;
            }
        }
    } catch (err) {
        console.error('Failed to fetch settings from server', err);
    }
    return null;
}

export function generateFieldId(): string {
    return `field_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Apply auto-rules to a message.
 * Returns `{ targetStage, extractedValue }` if any enabled rule matches.
 */
export function applyAutoRules(
    message: string,
    rules: AutoRule[]
): { targetStage: string; extractedValue: number | null } | null {
    const lowerMsg = message.toLowerCase();

    for (const rule of rules) {
        if (!rule.enabled) continue;
        if (!rule.keyword.trim()) continue;
        if (lowerMsg.includes(rule.keyword.toLowerCase())) {
            let extractedValue: number | null = null;
            if (rule.fixedValue !== undefined && rule.fixedValue !== null) {
                extractedValue = rule.fixedValue;
            } else if (rule.extractValue) {
                if (rule.currencyTag && rule.currencyTag.trim() !== '') {
                    const tag = rule.currencyTag.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    // Match: tag followed by optional space then number OR number followed by optional space then tag
                    // e.g. azn\s*(\d+(?:[.,]\d+)?) | (\d+(?:[.,]\d+)?)\s*azn
                    const regex = new RegExp(`(?:${tag}\\s*(\\d+(?:[.,]\\d+)?))|(?:(\\d+(?:[.,]\\d+)?)\\s*${tag})`, 'i');
                    const match = message.match(regex);
                    if (match) {
                        const valStr = match[1] || match[2];
                        if (valStr) extractedValue = parseFloat(valStr.replace(',', '.'));
                    }
                } else {
                    // Extract first number (integer or decimal) found in the message
                    const match = message.match(/[\d]+(?:[.,]\d+)?/);
                    if (match) {
                        extractedValue = parseFloat(match[0].replace(',', '.'));
                    }
                }
            }
            return { targetStage: rule.targetStage, extractedValue };
        }
    }
    return null;
}

export function applyRoutingRules(
    message: string,
    rules: RoutingRule[] | undefined
): { extra: Record<string, string>; targetStage?: string } | null {
    if (!rules || rules.length === 0) return null;
    const msg = (message || '').toLowerCase();
    if (!msg.trim()) return null;

    // First match wins (rules are ordered)
    for (const rule of rules) {
        if (!rule.enabled) continue;
        if (!rule.fieldId || !rule.setValue) continue;
        const kws = (rule.keywords || []).map(k => String(k || '').trim()).filter(Boolean);
        if (kws.length === 0) continue;

        const mode = rule.matchMode || 'any';
        const matched = mode === 'all'
            ? kws.every(k => msg.includes(k.toLowerCase()))
            : kws.some(k => msg.includes(k.toLowerCase()));

        if (!matched) continue;

        return {
            extra: { [rule.fieldId]: rule.setValue },
            ...(rule.targetStage ? { targetStage: rule.targetStage } : {})
        };
    }

    return null;
}
