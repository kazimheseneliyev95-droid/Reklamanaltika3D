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

export interface CRMSettings {
    customFields: CustomField[];
}

const STORAGE_KEY = 'crm_settings';

const DEFAULT_FIELDS: CustomField[] = [
    {
        id: 'product_name',
        label: 'Maraqlandığı Məhsul',
        type: 'text',
    },
];

export function loadCRMSettings(): CRMSettings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw) as CRMSettings;
    } catch { }
    return { customFields: DEFAULT_FIELDS };
}

export function saveCRMSettings(settings: CRMSettings): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function generateFieldId(): string {
    return `field_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}
