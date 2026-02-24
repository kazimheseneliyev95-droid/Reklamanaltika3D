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
    note?: string;            // Optional human-readable description
}

export interface CRMSettings {
    customFields: CustomField[];
    pipelineStages: PipelineStage[];
    autoRules: AutoRule[];
}

const STORAGE_KEY = 'crm_settings';

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
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as CRMSettings;
            if (!parsed.pipelineStages || parsed.pipelineStages.length === 0) {
                parsed.pipelineStages = DEFAULT_STAGES;
            }
            if (!parsed.autoRules) {
                parsed.autoRules = DEFAULT_RULES;
            }
            return parsed;
        }
    } catch { }
    return { customFields: DEFAULT_FIELDS, pipelineStages: DEFAULT_STAGES, autoRules: DEFAULT_RULES };
}

export function saveCRMSettings(settings: CRMSettings): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
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
            if (rule.extractValue) {
                // Extract first number (integer or decimal) found in the message
                const match = message.match(/[\d]+(?:[.,]\d+)?/);
                if (match) {
                    extractedValue = parseFloat(match[0].replace(',', '.'));
                }
            }
            return { targetStage: rule.targetStage, extractedValue };
        }
    }
    return null;
}
