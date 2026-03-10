import { useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';

export function KeywordChipsInput({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');

  const normalize = (s: string) => String(s || '').trim().replace(/\s+/g, ' ');

  const splitRaw = (raw: string) => {
    return String(raw || '')
      .split(/[,;\n\r\t]+/g)
      .map(normalize)
      .filter(Boolean);
  };

  const dedupe = (items: string[]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const it of items) {
      const key = it.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(it);
    }
    return out;
  };

  const commitDraft = () => {
    const parts = splitRaw(draft);
    if (parts.length === 0) return;
    onChange(dedupe([...(value || []), ...parts]));
    setDraft('');
  };

  const removeAt = (idx: number) => {
    const next = (value || []).filter((_, i) => i !== idx);
    onChange(next);
  };

  return (
    <div
      className={cn(
        'w-full bg-slate-900 border border-slate-800 rounded-lg px-2 py-2 text-xs text-slate-200',
        'focus-within:outline-none focus-within:ring-1 focus-within:ring-emerald-500',
        disabled && 'opacity-60 pointer-events-none'
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {(value || []).map((kw, idx) => (
          <span
            key={`${kw}-${idx}`}
            className="inline-flex items-center gap-1 rounded-full bg-emerald-950/30 border border-emerald-900/40 text-emerald-200 px-2 py-1"
            title={kw}
          >
            <span className="max-w-[220px] truncate">{kw}</span>
            <button
              type="button"
              onClick={() => removeAt(idx)}
              className="p-0.5 text-emerald-200/70 hover:text-white"
              aria-label="Remove keyword"
              title="Sil"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}

        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onPaste={(e) => {
            const text = e.clipboardData?.getData('text') || '';
            if (/[,;\n\r\t]/.test(text)) {
              e.preventDefault();
              const parts = splitRaw(text);
              if (parts.length > 0) onChange(dedupe([...(value || []), ...parts]));
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
              e.preventDefault();
              commitDraft();
              return;
            }
            if (e.key === 'Backspace' && draft.trim() === '' && (value || []).length > 0) {
              e.preventDefault();
              onChange((value || []).slice(0, -1));
            }
          }}
          placeholder={placeholder || 'Acar soz yazin ve Enter basin...'}
          className="flex-1 min-w-[160px] bg-transparent outline-none px-1 py-1 placeholder:text-slate-500"
          disabled={disabled}
          inputMode="text"
        />
      </div>

      <div className="mt-1 flex items-center justify-between gap-2">
        <p className="text-[10px] text-slate-500">Enter/Tab ile elave edin, Backspace ile sonuncunu silin. Paste: vergul/enter ile bolunecek.</p>
        <span className="text-[10px] text-slate-500 shrink-0">{(value || []).length} soz</span>
      </div>
    </div>
  );
}
