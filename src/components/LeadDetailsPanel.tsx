import React, { useState, useEffect } from 'react';
import { Lead, LeadStatus } from '../types/crm';
import {
    X, User, Phone, Package,
    MessageSquare, Clock, Hash, Save
} from 'lucide-react';
import { cn } from '../lib/utils';
import { Input } from './ui/Input';

interface LeadDetailsPanelProps {
    lead: Lead;
    onSave: (id: string, updates: Partial<Lead>) => void;
    onClose: () => void;
    onUpdateStatus: (id: string, status: LeadStatus) => void;
}

const STATUSES: { id: LeadStatus; label: string; color: string }[] = [
    { id: 'new', label: 'Yeni', color: 'bg-blue-500 text-white' },
    { id: 'potential', label: 'Kvalifikasiya', color: 'bg-purple-500 text-white' },
    { id: 'won', label: 'Satış', color: 'bg-green-500 text-white' },
    { id: 'lost', label: 'Uğursuz', color: 'bg-slate-700 text-white' },
];

export function LeadDetailsPanel({ lead, onSave, onClose, onUpdateStatus }: LeadDetailsPanelProps) {
    const [formData, setFormData] = useState({
        name: lead.name || '',
        value: lead.value?.toString() || '0',
        product_name: lead.product_name || '',
        last_message: lead.last_message || ''
    });

    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        // Esc düyməsi ilə bağlamaq üçün
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleEsc);
        return () => window.removeEventListener('keydown', handleEsc);
    }, [onClose]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    };

    const handleSave = async () => {
        setIsSaving(true);
        await onSave(lead.id, {
            name: formData.name,
            value: parseFloat(formData.value) || 0,
            product_name: formData.product_name,
            last_message: formData.last_message,
        });
        // Simulating a fast UX response
        setTimeout(() => setIsSaving(false), 500);
    };

    const dateStr = new Date(lead.created_at).toLocaleString();

    return (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm transition-opacity duration-300">
            {/* SIDE PANEL CONTAINER (AmoCRM is full sliding to the right or center. We'll do a large right-slide drawer) */}
            <div
                className="h-full w-full md:w-[85%] lg:w-[75%] max-w-7xl bg-slate-950 border-l border-slate-800 shadow-2xl flex flex-col md:flex-row animate-in slide-in-from-right duration-300"
                onClick={(e) => e.stopPropagation()}
            >

                {/* === LEFT SIDEBAR: FIELDS & DETAILS === */}
                <div className="w-full md:w-[320px] shrink-0 border-r border-slate-800 bg-slate-900/50 flex flex-col h-full overflow-y-auto custom-scrollbar">
                    {/* Header */}
                    <div className="p-4 border-b border-slate-800 flex items-center justify-between sticky top-0 bg-slate-900 z-10">
                        <div className="flex flex-col">
                            <span className="text-xs text-slate-500 font-mono flex items-center gap-1">
                                <Hash className="w-3 h-3" /> {lead.id.split('-')[0].toUpperCase()}
                            </span>
                            <h2 className="text-lg font-bold text-white flex items-center gap-2">
                                <User className="w-4 h-4 text-blue-400" /> Detallar
                            </h2>
                        </div>

                        {/* Mobile Close Button */}
                        <button onClick={onClose} className="md:hidden p-2 bg-slate-800 rounded-lg text-slate-400">
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    <div className="p-4 flex flex-col gap-5">
                        {/* Sales Value Highlight (AmoCRM inspired layout) */}
                        <div className="bg-slate-900 border border-slate-800 p-3 rounded-xl">
                            <label className="text-xs font-semibold uppercase text-slate-500 mb-1 block">Büdcə (Satış Həcmi)</label>
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                    <span className="text-slate-400">₼</span>
                                </div>
                                <input
                                    type="number"
                                    name="value"
                                    value={formData.value}
                                    onChange={handleChange}
                                    className="bg-transparent text-white text-xl font-bold w-full pl-8 py-1 border-none outline-none focus:ring-0"
                                    placeholder="0.00"
                                />
                            </div>
                        </div>

                        {/* Standard Fields */}
                        <div className="space-y-4">
                            <div>
                                <label className="text-[11px] font-semibold uppercase text-slate-500 mb-1.5 flex items-center gap-1.5">
                                    <User className="w-3.5 h-3.5" /> Ad Soyad
                                </label>
                                <Input
                                    name="name"
                                    value={formData.name}
                                    onChange={handleChange}
                                    className="bg-slate-950 border-slate-800 h-9"
                                    placeholder="Ad daxil edin"
                                />
                            </div>

                            <div>
                                <label className="text-[11px] font-semibold uppercase text-slate-500 mb-1.5 flex items-center gap-1.5">
                                    <Phone className="w-3.5 h-3.5" /> Telefon
                                </label>
                                <div className="bg-slate-900 border border-slate-800 h-9 px-3 rounded-lg flex items-center text-sm font-mono text-slate-300">
                                    {lead.phone}
                                </div>
                            </div>

                            <div>
                                <label className="text-[11px] font-semibold uppercase text-slate-500 mb-1.5 flex items-center gap-1.5">
                                    <Package className="w-3.5 h-3.5" /> Maraqlandığı Məhsul
                                </label>
                                <Input
                                    name="product_name"
                                    value={formData.product_name}
                                    onChange={handleChange}
                                    className="bg-slate-950 border-slate-800 h-9"
                                    placeholder="Məhsul və ya xidmət"
                                />
                            </div>

                            <div>
                                <label className="text-[11px] font-semibold uppercase text-slate-500 mb-1.5 flex items-center gap-1.5">
                                    <Clock className="w-3.5 h-3.5" /> Yaranma Tarixi
                                </label>
                                <div className="text-sm text-slate-400 flex items-center gap-2 pl-1">
                                    {dateStr}
                                </div>
                            </div>

                        </div>
                    </div>

                    <div className="mt-auto p-4 border-t border-slate-800 bg-slate-900/80 sticky bottom-0">
                        <button
                            onClick={handleSave}
                            disabled={isSaving}
                            className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg font-medium transition-colors flex justify-center items-center gap-2"
                        >
                            {isSaving ? <span className="animate-spin text-lg block">↻</span> : <><Save className="w-4 h-4" /> Yadda Saxla</>}
                        </button>
                    </div>
                </div>


                {/* === RIGHT / CENTER AREA: PIPELINE & CHAT FEED === */}
                <div className="flex-1 flex flex-col h-full overflow-hidden bg-slate-950 relative">

                    {/* Top Navbar / Pipeline Status Block */}
                    <div className="h-16 border-b border-slate-800 bg-slate-900 flex items-center justify-between px-4 sm:px-6 z-10 shrink-0">
                        <div className="flex-1 flex items-center pr-4 overflow-x-auto custom-scrollbar no-scrollbar">
                            {/* AmoCRM style pipeline visual */}
                            <div className="flex items-center space-x-0.5 w-full min-w-[300px] h-8 relative bg-slate-950 rounded border border-slate-800 overflow-hidden">
                                {STATUSES.map((status, index) => {
                                    const isActive = lead.status === status.id;
                                    const isPast = STATUSES.findIndex(s => s.id === lead.status) > index;

                                    return (
                                        <button
                                            key={status.id}
                                            onClick={() => onUpdateStatus(lead.id, status.id)}
                                            className={cn(
                                                "flex-1 h-full text-[10px] sm:text-xs font-bold uppercase transition-all flex items-center justify-center border-r border-slate-800 last:border-r-0 relative group",
                                                isActive ? status.color : isPast ? "bg-slate-800 text-slate-300 hover:bg-slate-700" : "bg-transparent text-slate-500 hover:bg-slate-900"
                                            )}
                                        >
                                            {status.label}
                                        </button>
                                    )
                                })}
                            </div>
                        </div>

                        <button onClick={onClose} className="hidden md:flex p-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded-lg transition-colors items-center gap-2 text-sm font-medium">
                            <X className="w-5 h-5" /> Bağla
                        </button>
                    </div>

                    {/* Sub Navbar (Tabs) */}
                    <div className="flex items-center gap-6 px-6 border-b border-slate-800/50 bg-slate-900/50">
                        <button className="py-3 text-sm font-semibold text-blue-400 border-b-2 border-blue-400">Ümumi Gedişat</button>
                        <button className="py-3 text-sm font-medium text-slate-500 hover:text-slate-300 transition-colors">Yazışmalar</button>
                        <button className="py-3 text-sm font-medium text-slate-500 hover:text-slate-300 transition-colors">Statistika</button>
                    </div>

                    {/* Center Feed Area (Scrollable) */}
                    <div className="flex-1 overflow-y-auto custom-scrollbar p-6 bg-slate-950 relative">
                        <div className="max-w-2xl mx-auto space-y-6">

                            {/* Event Block: Lead Created */}
                            <div className="flex flex-col items-center">
                                <span className="text-[10px] font-bold text-slate-500 bg-slate-900 border border-slate-800 px-3 py-1 rounded-full mb-3">
                                    {new Date(lead.created_at).toLocaleDateString()}
                                </span>

                                <div className="w-full bg-slate-900/40 border border-slate-800/60 rounded-xl p-4 flex gap-4 text-sm text-slate-400 relative overflow-hidden">
                                    <div className="w-1 bg-blue-500 absolute left-0 top-0 bottom-0"></div>
                                    <User className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
                                    <div>
                                        <span className="font-bold text-slate-200">Sistem</span> tərəfindən yeni əlaqə yaradıldı.
                                        <div className="text-xs text-slate-500 mt-1">Mənbə: {lead.source === 'whatsapp' ? 'WhatsApp İnteqrasiyası' : 'Manual Əlavə'}</div>
                                    </div>
                                    <div className="ml-auto text-xs text-slate-500 shrink-0">
                                        {new Date(lead.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                    </div>
                                </div>
                            </div>

                            {/* Chat Bubble: Source Message (If available) */}
                            {lead.source_message && lead.source_message !== lead.last_message && (
                                <div className="flex items-center gap-3">
                                    <div className="bg-slate-800 p-2 rounded-full hidden sm:block">
                                        <User className="w-4 h-4 text-slate-400" />
                                    </div>
                                    <div className="flex-1">
                                        <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl rounded-tl-sm shadow-sm inline-block max-w-[85%]">
                                            <div className="text-xs font-bold text-green-400 mb-1">{lead.name || lead.phone}</div>
                                            <p className="text-sm text-slate-200 whitespace-pre-wrap">{lead.source_message}</p>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Chat Bubble: Last Message */}
                            {lead.last_message && (
                                <div className="flex items-center gap-3">
                                    <div className="bg-green-900/30 p-2 rounded-full hidden sm:block border border-green-900/50">
                                        <MessageSquare className="w-4 h-4 text-green-400" />
                                    </div>
                                    <div className="flex-1">
                                        <div className="bg-[#1E293B] border border-slate-700 p-4 rounded-2xl rounded-tl-sm shadow-sm inline-block max-w-[90%]">
                                            <div className="text-xs font-bold text-green-400 mb-1 flex justify-between items-center w-full min-w-[200px]">
                                                <span>{lead.name || lead.phone} <span className="text-slate-500 font-normal ml-2">Müştəri</span></span>
                                            </div>

                                            {/* Note Block editable within feed just like AmoCRM */}
                                            <div className="mt-2">
                                                <textarea
                                                    name="last_message"
                                                    value={formData.last_message}
                                                    onChange={handleChange}
                                                    className="bg-transparent border-none text-slate-200 text-sm w-full min-h-[100px] outline-none resize-none focus:ring-0 p-0"
                                                    placeholder="Müştərinin mesajı və ya sizin qeydləriniz..."
                                                />
                                            </div>

                                            <div className="flex justify-end border-t border-slate-700 pt-2 mt-2">
                                                <button
                                                    onClick={handleSave}
                                                    disabled={isSaving}
                                                    className="text-[10px] bg-slate-700 hover:bg-slate-600 px-2 py-1 rounded text-white transition-colors"
                                                >
                                                    Dəyişikliyi Saxla
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Event: Next Action Placeholder */}
                            <div className="flex items-center justify-center py-6">
                                <button className="bg-slate-900 hover:bg-slate-800 border border-slate-700 border-dashed text-slate-400 px-4 py-2 rounded-lg text-sm flex items-center gap-2 transition-colors">
                                    <span className="text-xl leading-none">+</span> Yeni Qeyd Əlavə Et
                                </button>
                            </div>

                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
