// CRM Settings — persisted in localStorage as 'crm_settings'
// Custom fields can be: text, number, select (dropdown), datetime (appointment)

export type FieldType = 'text' | 'number' | 'select' | 'datetime';

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
    excludeKeywords?: string[]; // if any matches, rule is NOT applied
    matchMode?: 'any' | 'all';
    matchType?: 'contains' | 'startsWith' | 'exact' | 'regex';
    caseSensitive?: boolean;
    lockFieldAfterMatch?: boolean; // if field already has value, don't re-apply
    targetStage?: string; // optional: also move stage
}

export interface LeadCardUISettings {
    showAssignee?: boolean;
    showSource?: boolean;
    showNameBadge?: boolean;
    showProductBadge?: boolean;
    showValue?: boolean;
    showLastMessagePreview?: boolean;
    showCustomFieldBadges?: boolean;
    customFieldBadgeMode?: 'value' | 'label_value';
    customFieldIds?: string[]; // if empty/undefined and showCustomFieldBadges=true -> show all select/datetime fields
    maxCustomFieldBadges?: number;

    // Optional: colorize cards by a select custom field value
    colorByFieldId?: string; // select field id
    colorMap?: Record<string, string>; // option value -> css color (e.g. #22c55e)
    colorStyle?: 'tint' | 'border';
}

export interface CRMSettings {
    customFields: CustomField[];
    pipelineStages: PipelineStage[];
    autoRules: AutoRule[];
    routingRules?: RoutingRule[];
    ui?: {
        leadCard?: LeadCardUISettings;
    };
}

const DEFAULT_LEAD_CARD_UI: LeadCardUISettings = {
    showAssignee: true,
    showSource: true,
    showNameBadge: true,
    showProductBadge: true,
    showValue: true,
    showLastMessagePreview: true,
    showCustomFieldBadges: true,
    customFieldBadgeMode: 'value',
    customFieldIds: [],
    maxCustomFieldBadges: 2,

    colorByFieldId: '',
    colorMap: {},
    colorStyle: 'tint',
};

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

            // UI defaults (back-compat)
            if (!parsed.ui) parsed.ui = {};
            if (!parsed.ui.leadCard) parsed.ui.leadCard = { ...DEFAULT_LEAD_CARD_UI };
            else parsed.ui.leadCard = { ...DEFAULT_LEAD_CARD_UI, ...parsed.ui.leadCard };
            return parsed;
        }
    } catch { }
    return {
        customFields: DEFAULT_FIELDS,
        pipelineStages: DEFAULT_STAGES,
        autoRules: DEFAULT_RULES,
        routingRules: [],
        ui: { leadCard: { ...DEFAULT_LEAD_CARD_UI } }
    };
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
): { ruleId: string; extra: Record<string, string>; targetStage?: string } | null {
    if (!rules || rules.length === 0) return null;

    const rawMsg = String(message || '');
    const trimmed = rawMsg.trim();
    if (!trimmed) return null;

    // Ignore non-text placeholders emitted by the WhatsApp worker
    if (/^\[(?:Image|Video|Document|Audio|Sticker|Location|Contact|Reaction|Button|List|Template|Unsupported message)\]$/i.test(trimmed)) {
        return null;
    }

    // First match wins (rules are ordered)
    for (const rule of rules) {
        if (!rule.enabled) continue;
        if (!rule.fieldId || !rule.setValue) continue;
        const kws = (rule.keywords || []).map(k => String(k || '').trim()).filter(Boolean);
        if (kws.length === 0) continue;

        const mode = rule.matchMode || 'any';
        const type = rule.matchType || 'contains';
        const caseSensitive = Boolean(rule.caseSensitive);
        const msg = caseSensitive ? rawMsg : rawMsg.toLowerCase();

        const normalizeKw = (kw: string) => {
            const trimmed = String(kw || '').trim();
            return caseSensitive ? trimmed : trimmed.toLowerCase();
        };

        const matchOne = (kwRaw: string) => {
            const kw = normalizeKw(kwRaw);
            if (!kw) return false;
            if (type === 'contains') return msg.includes(kw);
            if (type === 'startsWith') return msg.startsWith(kw);
            if (type === 'exact') return msg === kw;
            if (type === 'regex') {
                try {
                    const re = new RegExp(kwRaw, caseSensitive ? '' : 'i');
                    return re.test(rawMsg);
                } catch {
                    return false;
                }
            }
            return msg.includes(kw);
        };

        const excludes = (rule.excludeKeywords || []).map(k => String(k || '').trim()).filter(Boolean);
        if (excludes.length > 0) {
            const hasExcluded = excludes.some(ex => {
                const exNorm = caseSensitive ? ex : ex.toLowerCase();
                return msg.includes(exNorm);
            });
            if (hasExcluded) continue;
        }

        const matched = mode === 'all'
            ? kws.every(matchOne)
            : kws.some(matchOne);

        if (!matched) continue;

        return {
            ruleId: rule.id,
            extra: { [rule.fieldId]: rule.setValue },
            ...(rule.targetStage ? { targetStage: rule.targetStage } : {})
        };
    }

    return null;
}
