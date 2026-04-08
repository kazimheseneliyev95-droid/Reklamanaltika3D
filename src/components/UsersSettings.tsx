import React, { useEffect, useMemo, useState } from 'react';
import {
    Plus, Trash2, Shield, User as UserIcon, AlertCircle, CheckSquare, Square,
    ChevronDown, ChevronRight, Users, MessageSquare, DollarSign, BarChart2,
    Smartphone, Sliders, UserCog, AlertTriangle, Search, Pencil, X, Check, Save
} from 'lucide-react';
import { CrmService } from '../services/CrmService';
import { UserPermissions, User as StoreUser } from '../types/crm';
import { cn } from '../lib/utils';
import { loadCRMSettings, type PipelineStage } from '../lib/crmSettings';
import { LayoutGrid } from 'lucide-react';

interface User extends StoreUser { }

// ─── Permission groups ──────────────────────────────────────────────────────
type PermKey = keyof UserPermissions;
type PermDef = { key: PermKey; label: string; description?: string; danger?: boolean };
type PermGroup = {
    id: string;
    title: string;
    icon: React.ReactNode;
    description: string;
    items: PermDef[];
};

const PERMISSION_GROUPS: PermGroup[] = [
    {
        id: 'leads',
        title: 'Lead İdarəetməsi',
        icon: <Users className="w-4 h-4" />,
        description: 'Lead siyahısı, redaktə, təyinat və mərhələ idarəetməsi',
        items: [
            { key: 'view_all_leads', label: 'Bütün leadləri görə bilər', description: 'Söndürsən: yalnız özünə təyin olunmuş leadləri görəcək' },
            { key: 'view_unassigned_leads', label: 'Təyin edilməmiş leadləri görə bilər', description: 'Boş gələn leadləri öz üzərinə götürmək üçün' },
            { key: 'create_lead', label: 'Yeni lead yarada bilər' },
            { key: 'delete_lead', label: 'Lead silə bilər' },
            { key: 'change_status', label: 'Status / mərhələ dəyişə bilər' },
            { key: 'edit_lead_fields', label: 'Lead məlumatlarını redaktə edə bilər', description: 'Ad, telefon, məhsul, custom field' },
            { key: 'assign_lead', label: 'Leadi başqa istifadəçiyə təyin edə bilər' },
            { key: 'close_conversation', label: 'Söhbəti bağlaya / yenidən aça bilər' },
            { key: 'export_leads', label: 'Lead siyahısını export edə bilər' },
        ],
    },
    {
        id: 'messaging',
        title: 'Mesajlaşma',
        icon: <MessageSquare className="w-4 h-4" />,
        description: 'Mesaj göndərmə, media, şablonlar və mesaj tarixçəsi',
        items: [
            { key: 'send_messages', label: 'Mesaj göndərə bilər' },
            { key: 'send_media', label: 'Şəkil / video / sənəd göndərə bilər' },
            { key: 'use_templates', label: 'Hazır cavab şablonlarından istifadə edə bilər' },
            { key: 'view_full_chat', label: 'Tam mesaj tarixçəsini görə bilər' },
            { key: 'add_internal_notes', label: 'Daxili qeyd əlavə edə bilər' },
            { key: 'delete_message_history', label: 'Mesaj tarixçəsini silə bilər', danger: true },
        ],
    },
    {
        id: 'finance',
        title: 'Maliyyə',
        icon: <DollarSign className="w-4 h-4" />,
        description: 'Büdcə, gəlir və ROI metrlərinə giriş',
        items: [
            { key: 'view_budget', label: 'Lead büdcəsini görə bilər' },
            { key: 'edit_budget', label: 'Büdcəni redaktə edə bilər' },
            { key: 'view_revenue', label: 'Toplam gəliri / satış məbləğini görə bilər' },
            { key: 'view_roi', label: 'ROI / gəlirlilik metrlərini görə bilər' },
        ],
    },
    {
        id: 'reports',
        title: 'Statistika & Hesabatlar',
        icon: <BarChart2 className="w-4 h-4" />,
        description: 'Dashboard, analitika və audit log',
        items: [
            { key: 'view_dashboard', label: 'Dashboard görə bilər' },
            { key: 'view_stats', label: 'Statistika panelini görə bilər' },
            { key: 'view_analytics', label: 'Analitika səhifəsini görə bilər' },
            { key: 'view_other_operator_stats', label: 'Digər operatorların statistikasını görə bilər' },
            { key: 'view_audit_log', label: 'Audit log görə bilər' },
        ],
    },
    {
        id: 'whatsapp',
        title: 'WhatsApp Hesabları',
        icon: <Smartphone className="w-4 h-4" />,
        description: 'WhatsApp inteqrasiyası və hesab idarəetməsi',
        items: [
            { key: 'view_whatsapp_accounts', label: 'WhatsApp hesablarını görə bilər' },
            { key: 'manage_whatsapp_accounts', label: 'Hesab əlavə / sil / yenidən başlat edə bilər' },
            { key: 'view_qr_code', label: 'QR kodu görə bilər' },
            { key: 'set_default_account', label: 'Default hesabı dəyişə bilər' },
            { key: 'view_account_phone', label: 'Hesabın telefon nömrəsini görə bilər' },
        ],
    },
    {
        id: 'settings',
        title: 'Sistem Parametrləri',
        icon: <Sliders className="w-4 h-4" />,
        description: 'Kanban, custom fields, qaydalar və inteqrasiyalar',
        items: [
            { key: 'manage_kanban_columns', label: 'Kanban sütunlarını dəyişə bilər' },
            { key: 'create_custom_fields', label: 'Xüsusi sahə (custom field) yarada bilər' },
            { key: 'manage_routing_rules', label: 'Routing qaydaları idarə edə bilər' },
            { key: 'manage_automation_rules', label: 'Avtomatik qaydalar idarə edə bilər' },
            { key: 'manage_response_templates', label: 'Cavab şablonlarını idarə edə bilər' },
            { key: 'manage_telegram_notifications', label: 'Telegram bildirimləri konfiqurə edə bilər' },
            { key: 'manage_meta_integration', label: 'Facebook / Instagram bağlantısı' },
        ],
    },
    {
        id: 'users',
        title: 'İstifadəçilər',
        icon: <UserCog className="w-4 h-4" />,
        description: 'İstifadəçi siyahısı və icazə idarəetməsi',
        items: [
            { key: 'view_users_list', label: 'İstifadəçi siyahısını görə bilər' },
            { key: 'manage_users', label: 'İstifadəçi yarada / silə bilər' },
            { key: 'manage_user_permissions', label: 'İcazələri redaktə edə bilər' },
        ],
    },
    {
        id: 'danger',
        title: 'Təhlükəli Əməliyyatlar',
        icon: <AlertTriangle className="w-4 h-4" />,
        description: 'Geri alınmayan əməliyyatlar — diqqət!',
        items: [
            { key: 'factory_reset', label: 'Sistemi sıfırlaya bilər (Formatla)', danger: true },
            { key: 'delete_all_data', label: 'Bütün məlumatları silə bilər', danger: true },
            { key: 'clear_chat_history', label: 'Bütün mesaj tarixçəsini silə bilər', danger: true },
        ],
    },
];

const ROLE_TEMPLATES: Record<string, UserPermissions> = {
    admin: Object.fromEntries(
        PERMISSION_GROUPS.flatMap(g => g.items.map(i => [i.key, true]))
    ) as UserPermissions,
    manager: {
        view_all_leads: true, view_unassigned_leads: true, create_lead: true,
        change_status: true, edit_lead_fields: true, assign_lead: true,
        close_conversation: true, export_leads: true, send_messages: true,
        send_media: true, use_templates: true, view_full_chat: true,
        add_internal_notes: true, view_budget: true, view_revenue: true,
        view_roi: true, view_dashboard: true, view_stats: true,
        view_analytics: true, view_other_operator_stats: true, view_audit_log: true,
        view_whatsapp_accounts: true, view_account_phone: true,
        manage_response_templates: true, view_users_list: true,
    },
    worker: {
        view_unassigned_leads: true, create_lead: true, change_status: true,
        edit_lead_fields: true, close_conversation: true, send_messages: true,
        send_media: true, use_templates: true, view_full_chat: true,
        add_internal_notes: true,
    },
    viewer: {
        view_all_leads: true, view_unassigned_leads: true, view_full_chat: true,
        view_budget: true, view_revenue: true, view_roi: true,
        view_dashboard: true, view_stats: true, view_analytics: true,
        view_other_operator_stats: true, view_whatsapp_accounts: true,
    },
};

const ROLE_LABELS: Record<string, string> = {
    admin: 'İdarəçi (Tam yetkili)',
    manager: 'Menecer (Komanda rəhbəri)',
    worker: 'Operator (Yalnız öz leadləri)',
    viewer: 'Müşahidəçi (Yalnız oxuma)',
};

const ROLE_COLORS: Record<string, string> = {
    admin: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
    manager: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
    worker: 'bg-blue-500/10 text-blue-300 border-blue-500/30',
    viewer: 'bg-slate-500/10 text-slate-300 border-slate-500/30',
    superadmin: 'bg-purple-500/10 text-purple-300 border-purple-500/30',
};

// ─── Permission Editor Sub-component ───────────────────────────────────────
function PermissionEditor({
    permissions,
    onChange,
}: {
    permissions: UserPermissions;
    onChange: (next: UserPermissions) => void;
}) {
    const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(['leads', 'stages']));

    // Load pipeline stages once so we can render the per-user stage picker.
    // Falls back to localStorage CRM settings, then refreshes from server.
    const [stages, setStages] = useState<PipelineStage[]>(() => loadCRMSettings().pipelineStages || []);
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const url = CrmService.getServerUrl();
                if (!url) return;
                const res = await fetch(`${url}/api/settings`, { headers: CrmService['getAuthHeaders']() });
                if (!res.ok) return;
                const data = await res.json();
                const list: PipelineStage[] = data?.settings?.pipelineStages || [];
                if (!cancelled && Array.isArray(list) && list.length > 0) setStages(list);
            } catch { /* fallback to local */ }
        })();
        return () => { cancelled = true; };
    }, []);

    const visibleStageIds = Array.isArray(permissions.visible_stage_ids) ? permissions.visible_stage_ids : [];
    const hasViewAll = permissions.view_all_leads === true;

    const toggleStage = (stageId: string) => {
        const set = new Set(visibleStageIds);
        if (set.has(stageId)) set.delete(stageId);
        else set.add(stageId);
        onChange({ ...permissions, visible_stage_ids: Array.from(set) });
    };

    const setAllStages = (ids: string[]) => {
        onChange({ ...permissions, visible_stage_ids: ids });
    };

    const toggleGroup = (id: string) => {
        setOpenGroups(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const togglePerm = (key: PermKey) => {
        // PermKey here is always a boolean flag (PERMISSION_GROUPS only contains
        // boolean items). Cast through unknown to satisfy TS now that
        // UserPermissions also has the visible_stage_ids string[] member.
        onChange({ ...permissions, [key]: !(permissions as any)[key] });
    };

    const setGroupAll = (group: PermGroup, value: boolean) => {
        const next: any = { ...permissions };
        group.items.forEach(item => { next[item.key] = value; });
        onChange(next as UserPermissions);
    };

    const stagesGroupOpen = openGroups.has('stages');
    const allStageIds = stages.map(s => s.id);
    const allSelected = visibleStageIds.length > 0 && allStageIds.every(id => visibleStageIds.includes(id));
    const noneSelected = visibleStageIds.length === 0;

    return (
        <div className="space-y-2">
            {/* ─── Per-user stage visibility picker ─────────────────────
                Lets the admin grant this user "see-all" access to ONLY
                certain kanban stages while still scoping every other
                stage to their own assigned leads. Hidden when the user
                has the global view_all_leads permission turned on
                (in that case they already see everything). */}
            {!hasViewAll && stages.length > 0 ? (
                <div className="rounded-xl border border-blue-900/30 bg-blue-950/10 transition-colors">
                    <button
                        type="button"
                        onClick={() => toggleGroup('stages')}
                        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-blue-950/20 rounded-xl"
                    >
                        <div className="flex items-center gap-2 min-w-0">
                            <span className="shrink-0 text-blue-400">
                                <LayoutGrid className="w-4 h-4" />
                            </span>
                            <div className="min-w-0">
                                <div className="text-[12px] font-bold text-blue-100 truncate">
                                    Görünən kanban sütunları
                                </div>
                                <div className="text-[10px] text-blue-300/60 truncate">
                                    Seçilmiş sütunlarda bütün leadləri, qalanlarda yalnız özünü görəcək
                                </div>
                            </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                            <span className={cn(
                                'text-[10px] font-extrabold px-2 py-0.5 rounded-full border',
                                allSelected
                                    ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-200'
                                    : noneSelected
                                        ? 'border-slate-700 bg-slate-900/40 text-slate-500'
                                        : 'border-blue-500/40 bg-blue-950/30 text-blue-200'
                            )}>
                                {visibleStageIds.length} / {stages.length}
                            </span>
                            {stagesGroupOpen ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
                        </div>
                    </button>

                    {stagesGroupOpen ? (
                        <div className="px-3 pb-3 border-t border-blue-900/30">
                            <div className="flex items-center gap-2 py-2">
                                <button
                                    type="button"
                                    onClick={() => setAllStages(allStageIds)}
                                    className="text-[10px] font-bold px-2 py-1 rounded-md border border-emerald-900/30 bg-emerald-950/15 text-emerald-200 hover:bg-emerald-950/25"
                                >
                                    Hamısını seç
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setAllStages([])}
                                    className="text-[10px] font-bold px-2 py-1 rounded-md border border-slate-700 bg-slate-900/40 text-slate-300 hover:bg-slate-800"
                                >
                                    Hamısını sil
                                </button>
                                <span className="text-[10px] text-slate-500 ml-auto">
                                    Heç bir sütun seçməsən, yalnız öz leadlərini görəcək
                                </span>
                            </div>
                            <div className="space-y-1">
                                {stages.map(stage => {
                                    const checked = visibleStageIds.includes(stage.id);
                                    return (
                                        <button
                                            key={stage.id}
                                            type="button"
                                            onClick={() => toggleStage(stage.id)}
                                            className={cn(
                                                'w-full flex items-center gap-2 p-2 rounded-lg border text-left transition-colors',
                                                checked
                                                    ? 'border-blue-500/40 bg-blue-950/25'
                                                    : 'border-slate-800 bg-slate-950/30 hover:border-slate-700'
                                            )}
                                        >
                                            <div className={cn('shrink-0', checked ? 'text-blue-400' : 'text-slate-600')}>
                                                {checked ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <div className={cn('text-[11px] font-bold', checked ? 'text-blue-100' : 'text-slate-300')}>
                                                    {stage.label}
                                                </div>
                                                <div className="text-[10px] text-slate-500 font-mono">
                                                    id: {stage.id}
                                                </div>
                                            </div>
                                            {checked ? (
                                                <span className="text-[9px] font-extrabold uppercase text-blue-300 px-1.5 py-0.5 rounded border border-blue-500/30 bg-blue-950/30 shrink-0">
                                                    Hamısını görür
                                                </span>
                                            ) : (
                                                <span className="text-[9px] font-extrabold uppercase text-slate-500 px-1.5 py-0.5 rounded border border-slate-800 bg-slate-950/40 shrink-0">
                                                    Yalnız özü
                                                </span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    ) : null}
                </div>
            ) : null}

            {PERMISSION_GROUPS.map(group => {
                const isOpen = openGroups.has(group.id);
                const enabledCount = group.items.filter(i => permissions[i.key]).length;
                const total = group.items.length;
                const allOn = enabledCount === total;
                const noneOn = enabledCount === 0;

                return (
                    <div
                        key={group.id}
                        className={cn(
                            'rounded-xl border transition-colors',
                            group.id === 'danger' ? 'border-rose-900/40 bg-rose-950/10' : 'border-slate-800 bg-slate-950/40'
                        )}
                    >
                        <button
                            type="button"
                            onClick={() => toggleGroup(group.id)}
                            className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-slate-900/30 rounded-xl"
                        >
                            <div className="flex items-center gap-2 min-w-0">
                                <span className={cn('shrink-0', group.id === 'danger' ? 'text-rose-400' : 'text-blue-400')}>
                                    {group.icon}
                                </span>
                                <div className="min-w-0">
                                    <div className={cn('text-[12px] font-bold truncate', group.id === 'danger' ? 'text-rose-200' : 'text-slate-100')}>
                                        {group.title}
                                    </div>
                                    <div className="text-[10px] text-slate-500 truncate">{group.description}</div>
                                </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                <span className={cn(
                                    'text-[10px] font-extrabold px-2 py-0.5 rounded-full border',
                                    allOn
                                        ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-200'
                                        : noneOn
                                            ? 'border-slate-700 bg-slate-900/40 text-slate-500'
                                            : 'border-blue-500/40 bg-blue-950/30 text-blue-200'
                                )}>
                                    {enabledCount} / {total}
                                </span>
                                {isOpen ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
                            </div>
                        </button>

                        {isOpen ? (
                            <div className="px-3 pb-3 border-t border-slate-800/70">
                                <div className="flex items-center gap-2 py-2">
                                    <button
                                        type="button"
                                        onClick={() => setGroupAll(group, true)}
                                        className="text-[10px] font-bold px-2 py-1 rounded-md border border-emerald-900/30 bg-emerald-950/15 text-emerald-200 hover:bg-emerald-950/25"
                                    >
                                        Hamısını aç
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setGroupAll(group, false)}
                                        className="text-[10px] font-bold px-2 py-1 rounded-md border border-slate-700 bg-slate-900/40 text-slate-300 hover:bg-slate-800"
                                    >
                                        Hamısını söndür
                                    </button>
                                </div>
                                <div className="space-y-1.5">
                                    {group.items.map(item => {
                                        const checked = !!permissions[item.key];
                                        return (
                                            <button
                                                key={item.key}
                                                type="button"
                                                onClick={() => togglePerm(item.key)}
                                                className={cn(
                                                    'w-full flex items-start gap-2 p-2 rounded-lg border text-left transition-colors',
                                                    checked
                                                        ? (item.danger
                                                            ? 'border-rose-500/40 bg-rose-950/20'
                                                            : 'border-blue-500/40 bg-blue-950/20')
                                                        : 'border-slate-800 bg-slate-950/30 hover:border-slate-700'
                                                )}
                                            >
                                                <div className={cn('mt-0.5 shrink-0', checked ? (item.danger ? 'text-rose-400' : 'text-blue-400') : 'text-slate-600')}>
                                                    {checked ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <div className={cn('text-[11px] font-bold', checked ? (item.danger ? 'text-rose-100' : 'text-blue-100') : 'text-slate-300')}>
                                                        {item.label}
                                                    </div>
                                                    {item.description ? (
                                                        <div className="text-[10px] text-slate-500 mt-0.5">{item.description}</div>
                                                    ) : null}
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
}

// ─── Main UsersSettings ────────────────────────────────────────────────────
export function UsersSettings() {
    const [users, setUsers] = useState<User[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [search, setSearch] = useState('');

    // Create form state
    const [isCreating, setIsCreating] = useState(false);
    const [newUsername, setNewUsername] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [newRole, setNewRole] = useState<'admin' | 'worker' | 'manager' | 'viewer'>('worker');
    const [newPermissions, setNewPermissions] = useState<UserPermissions>(ROLE_TEMPLATES.worker);

    // Edit user state
    const [editingUserId, setEditingUserId] = useState<string | null>(null);
    const [editPermissions, setEditPermissions] = useState<UserPermissions>({});
    const [editSaving, setEditSaving] = useState(false);
    const [editSavedOk, setEditSavedOk] = useState(false);

    useEffect(() => { loadUsers(); }, []);

    const loadUsers = async () => {
        setLoading(true);
        setError('');
        try {
            const res = await fetch(`${CrmService.getServerUrl()}/api/users`, {
                headers: CrmService['getAuthHeaders']()
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'İstifadəçiləri yükləmək mümkün olmadı');
            setUsers(Array.isArray(data) ? data : []);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const handleRoleChange = (role: 'admin' | 'worker' | 'manager' | 'viewer') => {
        setNewRole(role);
        setNewPermissions(ROLE_TEMPLATES[role] || {});
    };

    const handleCreateUser = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        try {
            const res = await fetch(`${CrmService.getServerUrl()}/api/users`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...CrmService['getAuthHeaders']() },
                body: JSON.stringify({ username: newUsername, password: newPassword, role: newRole, permissions: newPermissions })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'İstifadəçi yaradıla bilmədi');
            setUsers([data, ...users]);
            setIsCreating(false);
            setNewUsername('');
            setNewPassword('');
            setNewRole('worker');
            setNewPermissions(ROLE_TEMPLATES.worker);
        } catch (err: any) {
            setError(err.message);
        }
    };

    const handleDeleteUser = async (id: string, username: string) => {
        if (!window.confirm(`"${username}" istifadəçisini silmək istədiyinizə əminsiniz?`)) return;
        try {
            const res = await fetch(`${CrmService.getServerUrl()}/api/users/${id}`, {
                method: 'DELETE',
                headers: CrmService['getAuthHeaders']()
            });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Silinmə zamanı xəta baş verdi');
            }
            setUsers(users.filter(u => u.id !== id));
        } catch (err: any) {
            alert(err.message);
        }
    };

    const startEdit = (user: User) => {
        setEditingUserId(user.id);
        setEditPermissions(user.permissions || {});
        setEditSavedOk(false);
        setError('');
    };

    const cancelEdit = () => {
        setEditingUserId(null);
        setEditPermissions({});
        setEditSavedOk(false);
    };

    const saveEdit = async () => {
        if (!editingUserId) return;
        setEditSaving(true);
        setError('');
        try {
            const res = await fetch(`${CrmService.getServerUrl()}/api/users/${editingUserId}/permissions`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', ...CrmService['getAuthHeaders']() },
                body: JSON.stringify({ permissions: editPermissions })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'İcazələr saxlanmadı');
            setUsers(prev => prev.map(u => u.id === editingUserId ? { ...u, permissions: editPermissions } : u));
            setEditSavedOk(true);
            setTimeout(() => {
                setEditSavedOk(false);
                setEditingUserId(null);
            }, 1200);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setEditSaving(false);
        }
    };

    const filteredUsers = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return users;
        return users.filter(u =>
            (u.username || '').toLowerCase().includes(q) ||
            (u.display_name || '').toLowerCase().includes(q) ||
            (u.role || '').toLowerCase().includes(q)
        );
    }, [users, search]);

    if (loading) return <div className="p-4 text-center text-slate-400 text-sm">Yüklənir...</div>;

    const editingUser = editingUserId ? users.find(u => u.id === editingUserId) : null;
    const editEnabledCount = Object.values(editPermissions).filter(v => v === true).length;
    const totalPermsCount = PERMISSION_GROUPS.reduce((s, g) => s + g.items.length, 0);

    return (
        <section className="space-y-4">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h2 className="text-sm font-bold text-white">İstifadəçilər & İcazələr</h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                        Hər bir istifadəçi üçün {totalPermsCount} fərqli icazəni ayrı-ayrı tənzimləyə bilərsiniz
                    </p>
                </div>
                <div className="text-right shrink-0">
                    <div className="text-[11px] text-slate-500">Cəmi</div>
                    <div className="text-sm font-extrabold text-slate-200">{users.length} istifadəçi</div>
                </div>
            </div>

            {error && (
                <div className="bg-rose-950/40 border border-rose-900/50 rounded-lg p-3 flex items-start gap-2.5">
                    <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                    <p className="text-xs text-rose-300 font-medium">{error}</p>
                </div>
            )}

            {/* Search */}
            {users.length > 4 ? (
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
                    <input
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="İstifadəçi axtar..."
                        className="w-full h-9 rounded-lg bg-slate-950 border border-slate-800 pl-9 pr-3 text-[12px] text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-600/50"
                    />
                </div>
            ) : null}

            {/* Create new */}
            {isCreating ? (
                <form onSubmit={handleCreateUser} className="bg-slate-900 border border-slate-700 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                        <h3 className="text-xs font-extrabold text-white">Yeni İstifadəçi</h3>
                        <button
                            type="button"
                            onClick={() => setIsCreating(false)}
                            className="p-1 rounded-md text-slate-500 hover:text-slate-200"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                                İstifadəçi Adı
                            </label>
                            <input
                                required
                                value={newUsername}
                                onChange={e => setNewUsername(e.target.value)}
                                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white text-[12px] focus:outline-none focus:border-blue-500"
                            />
                        </div>
                        <div>
                            <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                                Şifrə
                            </label>
                            <input
                                required
                                type="password"
                                value={newPassword}
                                onChange={e => setNewPassword(e.target.value)}
                                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white text-[12px] focus:outline-none focus:border-blue-500"
                            />
                        </div>
                    </div>

                    <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                            Rol Şablonu
                        </label>
                        <select
                            value={newRole}
                            onChange={e => handleRoleChange(e.target.value as any)}
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white text-[12px] focus:outline-none focus:border-blue-500 appearance-none"
                        >
                            {Object.entries(ROLE_LABELS).map(([id, label]) => (
                                <option key={id} value={id}>{label}</option>
                            ))}
                        </select>
                        <p className="mt-1 text-[10px] text-slate-500">
                            Şablon icazələri əvvəlcədən qururur. Aşağıdan istənilən icazəni manuel açıb-söndürə bilərsiniz.
                        </p>
                    </div>

                    <div>
                        <PermissionEditor
                            permissions={newPermissions}
                            onChange={setNewPermissions}
                        />
                    </div>

                    <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
                        <button
                            type="button"
                            onClick={() => setIsCreating(false)}
                            className="px-4 py-2 text-[12px] font-semibold text-slate-400 hover:text-white"
                        >
                            Ləğv et
                        </button>
                        <button
                            type="submit"
                            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-[12px] font-bold inline-flex items-center gap-2"
                        >
                            <Plus className="w-3.5 h-3.5" />
                            Yarat
                        </button>
                    </div>
                </form>
            ) : (
                <button
                    onClick={() => setIsCreating(true)}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-slate-900 hover:bg-slate-800 border border-slate-700 border-dashed text-slate-400 hover:text-white rounded-lg text-[12px] font-semibold transition-colors"
                >
                    <Plus className="w-4 h-4" />
                    Yeni İstifadəçi Əlavə Et
                </button>
            )}

            {/* Users list */}
            <div className="space-y-2">
                {filteredUsers.length === 0 ? (
                    <div className="text-center py-8 text-slate-500 text-xs">
                        {search ? 'Filterə uyğun istifadəçi tapılmadı.' : 'Heç bir istifadəçi yoxdur.'}
                    </div>
                ) : null}

                {filteredUsers.map(user => {
                    const permsCount = user.permissions ? Object.values(user.permissions).filter(v => v === true).length : 0;
                    const isEditingThis = editingUserId === user.id;

                    return (
                        <div key={user.id} className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                            <div className="p-3 flex items-center justify-between gap-3">
                                <div className="flex items-center gap-3 min-w-0 flex-1">
                                    <div className={cn(
                                        'w-10 h-10 rounded-full flex items-center justify-center border shrink-0',
                                        ROLE_COLORS[user.role] || ROLE_COLORS['worker']
                                    )}>
                                        {user.role === 'admin' || user.role === 'superadmin'
                                            ? <Shield className="w-4 h-4" />
                                            : <UserIcon className="w-4 h-4" />}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="text-sm font-bold text-white truncate">{user.username}</span>
                                            <span className={cn(
                                                'text-[9px] px-1.5 py-0.5 rounded-full uppercase tracking-wider border font-extrabold',
                                                ROLE_COLORS[user.role] || ROLE_COLORS['worker']
                                            )}>
                                                {user.role}
                                            </span>
                                        </div>
                                        <div className="text-[10px] text-slate-500 mt-0.5 flex items-center gap-1.5">
                                            <Sliders className="w-3 h-3" />
                                            {permsCount} / {totalPermsCount} aktiv icazə
                                        </div>
                                    </div>
                                </div>

                                <div className="shrink-0 flex items-center gap-1">
                                    <button
                                        onClick={() => isEditingThis ? cancelEdit() : startEdit(user)}
                                        className={cn(
                                            'p-2 rounded-lg transition-colors',
                                            isEditingThis
                                                ? 'text-slate-400 bg-slate-800'
                                                : 'text-slate-500 hover:text-blue-300 hover:bg-slate-800'
                                        )}
                                        title={isEditingThis ? 'Bağla' : 'İcazələri redaktə et'}
                                    >
                                        {isEditingThis ? <X className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
                                    </button>
                                    <button
                                        onClick={() => handleDeleteUser(user.id, user.username)}
                                        className="p-2 text-slate-600 hover:text-rose-400 transition-colors rounded-lg hover:bg-slate-800"
                                        title="Sil"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>

                            {isEditingThis && editingUser ? (
                                <div className="border-t border-slate-800 bg-slate-950/50 p-3 space-y-3">
                                    <div className="flex items-center justify-between gap-2 text-[11px]">
                                        <div className="text-slate-400">
                                            <span className="font-bold text-slate-200">{editEnabledCount}</span>
                                            <span className="text-slate-600 mx-1">/</span>
                                            <span>{totalPermsCount}</span>
                                            <span className="ml-1">aktiv icazə</span>
                                        </div>
                                        <div className="flex items-center gap-1.5">
                                            <button
                                                type="button"
                                                onClick={() => setEditPermissions(ROLE_TEMPLATES[user.role] || {})}
                                                className="text-[10px] font-bold px-2 py-1 rounded-md border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
                                                title="Bu rol üçün şablon icazələrini bərpa et"
                                            >
                                                Şablona qaytar
                                            </button>
                                        </div>
                                    </div>

                                    <PermissionEditor
                                        permissions={editPermissions}
                                        onChange={setEditPermissions}
                                    />

                                    <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
                                        <button
                                            type="button"
                                            onClick={cancelEdit}
                                            disabled={editSaving}
                                            className="px-3 py-2 text-[11px] font-semibold text-slate-400 hover:text-white disabled:opacity-50"
                                        >
                                            Ləğv et
                                        </button>
                                        <button
                                            type="button"
                                            onClick={saveEdit}
                                            disabled={editSaving}
                                            className={cn(
                                                'px-4 py-2 rounded-lg text-[11px] font-extrabold inline-flex items-center gap-2 transition-colors',
                                                editSavedOk
                                                    ? 'bg-emerald-600 text-white'
                                                    : 'bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50'
                                            )}
                                        >
                                            {editSaving
                                                ? <><span className="animate-spin">↻</span> Saxlanır...</>
                                                : editSavedOk
                                                    ? <><Check className="w-3.5 h-3.5" /> Saxlandı!</>
                                                    : <><Save className="w-3.5 h-3.5" /> İcazələri Saxla</>
                                            }
                                        </button>
                                    </div>
                                </div>
                            ) : null}
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
