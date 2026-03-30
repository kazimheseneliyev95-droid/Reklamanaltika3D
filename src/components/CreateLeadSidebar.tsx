import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Package, Phone, Save, StickyNote, TrendingUp, User, UserPlus } from 'lucide-react';
import { Lead, LeadStatus, User as CRMUser } from '../types/crm';
import { cn } from '../lib/utils';

type CreateLeadSidebarProps = {
  open: boolean;
  onClose: () => void;
  onCreate: (lead: Omit<Lead, 'id' | 'created_at' | 'updated_at'>) => Promise<void>;
  pipelineStages: Array<{ id: string; label: string; color: string }>;
  teamMembers: CRMUser[];
  currentUser: CRMUser | null;
};

const COUNTRY_CODE_OPTIONS = ['+994', '+90', '+7', '+1', '+49'];

function normalizeCountryCode(raw: string) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits ? `+${digits}` : '+994';
}

function normalizePhoneDigits(raw: string) {
  return String(raw || '').replace(/\D/g, '');
}

export function CreateLeadSidebar({ open, onClose, onCreate, pipelineStages, teamMembers, currentUser }: CreateLeadSidebarProps) {
  const defaultStatus = pipelineStages[0]?.id || 'new';
  const canViewBudget = currentUser?.permissions?.view_budget !== false;
  const canEditBudget = currentUser?.permissions?.edit_budget !== false;

  const [countryCode, setCountryCode] = useState('+994');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [status, setStatus] = useState<LeadStatus>(defaultStatus);
  const [note, setNote] = useState('');
  const [productName, setProductName] = useState('');
  const [value, setValue] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCountryCode('+994');
    setPhone('');
    setName('');
    setStatus(defaultStatus);
    setNote('');
    setProductName('');
    setValue('');
    setAssigneeId('');
    setError('');
    setIsSaving(false);
  }, [open, defaultStatus]);

  const title = useMemo(() => {
    const fullPhone = `${normalizeCountryCode(countryCode)}${normalizePhoneDigits(phone)}`;
    return name.trim() || fullPhone;
  }, [countryCode, name, phone]);

  if (!open || typeof document === 'undefined') return null;

  const handleSubmit = async () => {
    const normalizedCountryCode = normalizeCountryCode(countryCode);
    const phoneDigits = normalizePhoneDigits(phone);

    if (!phoneDigits) {
      setError('Telefon nomresi mecburidir');
      return;
    }

    if (phoneDigits.length < 7) {
      setError('Telefon nomresi cox qisa gorunur');
      return;
    }

    setError('');
    setIsSaving(true);
    try {
      const parsedValue = canViewBudget && value.trim() !== '' ? Number(value) : 0;
      await onCreate({
        phone: `${normalizedCountryCode}${phoneDigits}`,
        name: name.trim() || undefined,
        status,
        last_message: note.trim() || undefined,
        product_name: productName.trim() || undefined,
        value: Number.isFinite(parsedValue) ? parsedValue : 0,
        assignee_id: assigneeId || null,
        source: 'manual',
      });
    } finally {
      setIsSaving(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-[2px] flex justify-end overflow-hidden" onClick={onClose}>
      <div
        className="relative h-screen h-[100dvh] w-full sm:w-[96%] md:w-[88%] lg:w-[72%] xl:w-[64%] max-w-4xl bg-[#0d1117] border-l border-white/5 shadow-2xl flex flex-col overflow-hidden"
        style={{ paddingTop: 'env(safe-area-inset-top)', animation: 'slideInRight 0.22s cubic-bezier(0.22,1,0.36,1)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-2 sm:px-4 py-2 border-b border-white/5 bg-[#111827] shrink-0 gap-3">
          <div className="flex items-start gap-2 min-w-0 flex-1">
            <button onClick={onClose} className="md:hidden p-1.5 text-slate-400 hover:text-white transition-colors shrink-0" type="button">
              <span className="text-xl leading-none">&larr;</span>
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1 sm:gap-2 min-w-0">
                <div className="flex items-center gap-1.5 bg-slate-800/80 px-2 sm:px-2.5 py-1 rounded-md border border-slate-700/50 shrink-0">
                  <span className="hidden sm:inline text-slate-500 text-[10px] uppercase font-bold tracking-wider">Yeni</span>
                  <span className="text-[10px] sm:text-sm font-mono text-slate-300 font-semibold">Lead</span>
                </div>
                <span className="text-slate-300 text-[11px] sm:text-sm font-semibold truncate">{title}</span>
              </div>
            </div>
          </div>

          <button onClick={onClose} className="md:hidden shrink-0 p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors" aria-label="Close" type="button">
            <span className="text-xl leading-none">&times;</span>
          </button>

          <button onClick={onClose} className="hidden md:flex shrink-0 p-2 rounded-lg text-slate-500 hover:text-white hover:bg-slate-800 transition-colors" type="button">
            <span className="text-xl leading-none">&times;</span>
          </button>
        </div>

        <div className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden relative">
          <aside className="w-full md:w-80 lg:w-96 shrink-0 min-h-0 border-r border-white/5 bg-[#111827]/60 flex flex-col overflow-hidden overscroll-contain relative">
            <div className="p-4 border-b border-white/5 flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-bold text-sm shrink-0">
                {(name.trim() || phone.trim() || '+')[0].toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-white font-semibold text-sm truncate">{name.trim() || 'Yeni lead'}</p>
                <p className="text-slate-500 text-xs flex items-center gap-1 truncate">
                  <Phone className="w-2.5 h-2.5" /> {`${normalizeCountryCode(countryCode)}${normalizePhoneDigits(phone)}`}
                </p>
              </div>
              <div className="w-2 h-2 rounded-full shrink-0 bg-blue-500" title="Yeni lead" />
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain touch-pan-y" style={{ WebkitOverflowScrolling: 'touch' }}>
              <div className="p-4 space-y-4">
                <FieldGroup label="Ad Soyad" icon={<UserPlus className="w-3 h-3" />}>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="Musterinin adi"
                  />
                </FieldGroup>

                <FieldGroup label="Telefon" icon={<Phone className="w-3 h-3" />}>
                  <div className="flex gap-2">
                    <input
                      list="country-code-options"
                      value={countryCode}
                      onChange={(e) => setCountryCode(e.target.value)}
                      className="w-24 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm font-semibold focus:outline-none focus:ring-1 focus:ring-blue-500"
                      placeholder="+994"
                    />
                    <datalist id="country-code-options">
                      {COUNTRY_CODE_OPTIONS.map((code) => <option key={code} value={code} />)}
                    </datalist>
                    <input
                      value={phone}
                      onChange={(e) => setPhone(normalizePhoneDigits(e.target.value))}
                      className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                      inputMode="tel"
                      placeholder="505438688"
                    />
                  </div>
                  <p className="mt-1 text-[10px] text-slate-500">Ulke kodu secin veya yazin. Telefon nomresi mecburidir.</p>
                  {error ? <p className="mt-1 text-[10px] text-rose-400">{error}</p> : null}
                </FieldGroup>

                <FieldGroup label="Mesul Sexs" icon={<User className="w-3 h-3" />}>
                  <div className="flex gap-2">
                    <select
                      value={assigneeId}
                      onChange={(e) => setAssigneeId(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 appearance-none"
                    >
                      <option value="">-- Teyin Edilmeyib --</option>
                      {teamMembers.map((tm) => (
                        <option key={tm.id} value={tm.id}>{tm.display_name || tm.username}</option>
                      ))}
                    </select>
                    {currentUser && assigneeId !== currentUser.id ? (
                      <button
                        onClick={() => setAssigneeId(currentUser.id)}
                        className="whitespace-nowrap px-3 py-2 bg-blue-600/20 hover:bg-blue-600/40 text-blue-400 border border-blue-500/30 rounded-lg text-[10px] font-bold uppercase shrink-0 transition-colors"
                        title="Ozume Teyin Et"
                        type="button"
                      >
                        Men
                      </button>
                    ) : null}
                  </div>
                </FieldGroup>

                {canViewBudget ? (
                  <FieldGroup label="Budce (AZN)" icon={<TrendingUp className="w-3 h-3" />}>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">₼</span>
                      <input
                        type="number"
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg pl-8 pr-3 py-2 text-white text-sm font-semibold focus:outline-none focus:ring-1 focus:ring-blue-500"
                        disabled={!canEditBudget}
                        placeholder="0"
                      />
                    </div>
                  </FieldGroup>
                ) : null}

                <FieldGroup label="Status / Merhele" icon={<span className="w-3 h-3 inline-block">◔</span>}>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 appearance-none"
                  >
                    {pipelineStages.map((stage) => (
                      <option key={stage.id} value={stage.id}>{stage.label}</option>
                    ))}
                  </select>
                </FieldGroup>

                <FieldGroup label="Maraqlandigi Mehsul" icon={<Package className="w-3 h-3" />}>
                  <input
                    value={productName}
                    onChange={(e) => setProductName(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="Mehsul ve ya sifaris adi"
                  />
                </FieldGroup>

                <FieldGroup label="Not" icon={<StickyNote className="w-3 h-3" />}>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    className="w-full min-h-[110px] resize-y bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="Ilk qeyd ve ya qisa qeyd yazin"
                  />
                </FieldGroup>
              </div>
            </div>

            <div className="p-4 border-t border-white/5 bg-[#0d1117] shrink-0">
              <button
                onClick={handleSubmit}
                disabled={isSaving}
                className={cn(
                  'w-full inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-4 text-base font-bold transition-colors',
                  isSaving ? 'bg-blue-700/60 text-white/70 cursor-wait' : 'bg-blue-600 hover:bg-blue-500 text-white'
                )}
                type="button"
              >
                <Save className="w-5 h-5" />
                {isSaving ? 'Yadda saxlanir...' : 'Yadda Saxla'}
              </button>
            </div>
          </aside>

          <div className="hidden md:flex flex-1 min-h-0 items-center justify-center bg-[#0b0f14] text-slate-500 px-8">
            <div className="max-w-md text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-800 bg-slate-900 text-slate-400">
                <UserPlus className="w-7 h-7" />
              </div>
              <h3 className="text-lg font-semibold text-slate-200">Yeni lead yaradilir</h3>
              <p className="mt-2 text-sm text-slate-500">Nomreni standart formatda daxil edin. Eyni nomreden sonradan WhatsApp mesaji gelerse bu lead ile birlesecek.</p>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

function FieldGroup({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <label className="flex items-center gap-1.5 text-[10px] font-semibold uppercase text-slate-500 mb-1.5">
        {icon} {label}
      </label>
      {children}
    </div>
  );
}
