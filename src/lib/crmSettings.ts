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

export interface CRMSettings {
    customFields: CustomField[];
    pipelineStages: PipelineStage[];
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

export function loadCRMSettings(): CRMSettings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as CRMSettings;
            if (!parsed.pipelineStages || parsed.pipelineStages.length === 0) {
                parsed.pipelineStages = DEFAULT_STAGES;
            }
            return parsed;
        }
    } catch { }
    return { customFields: DEFAULT_FIELDS, pipelineStages: DEFAULT_STAGES };
}

export function saveCRMSettings(settings: CRMSettings): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function generateFieldId(): string {
    return `field_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}
