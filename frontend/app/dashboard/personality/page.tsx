'use client';

import { useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { BriefcaseBusiness, Check, ChevronRight, CircleCheck, Clock3, ListFilter, RotateCcw, Smile } from 'lucide-react';
import { toast } from 'sonner';
import { getPersonalityPrompt, savePersonalityPrompt } from '@/lib/dashboard/api';
import { useLanguage } from '@/context/LanguageContext';
import { formatText } from '@/lib/i18n';

// Matches the dashboard Lambda's limit.
const MAX_PERSONALITY_CHARS = 4000;

type PresetKey = 'friendly' | 'concise' | 'professional';
const PRESETS: { key: PresetKey; icon: LucideIcon }[] = [
  { key: 'friendly', icon: Smile },
  { key: 'concise', icon: ListFilter },
  { key: 'professional', icon: BriefcaseBusiness },
];

export default function PersonalityPage() {
  const { t, language } = useLanguage();
  const [prompt, setPrompt] = useState('');
  const [saved, setSaved] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getPersonalityPrompt()
      .then(({ prompt: value }) => { setPrompt(value); setSaved(value); })
      .catch(() => toast.error(t.personality.loadFailed))
      .finally(() => setLoading(false));
    // Load once; the language toggle should not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(value: string) {
    setSaving(true);
    try {
      const { prompt: stored } = await savePersonalityPrompt(value);
      setPrompt(stored);
      setSaved(stored);
      toast.success(stored ? t.personality.saved : t.personality.cleared);
    } catch {
      toast.error(t.personality.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  const busy = loading || saving;
  const unsaved = !loading && prompt.trim() !== saved;
  const presets = t.personality.presets;
  const locale = language === 'es' ? 'es-US' : 'en-US';
  return (
    <div className="personality-page">
      <header className="personality-header">
        <h1 className="personality-title">
          <ChevronRight size={18} aria-hidden="true" />
          {t.personality.title}
        </h1>
        <p className="personality-subtitle">{t.personality.subtitle}</p>
      </header>

      <section className="personality-card">
        <div className="personality-body">
          <div className="personality-card-heading">
            <div>
              <h2 className="personality-card-title">{t.personality.cardTitle}</h2>
              <p className="personality-card-subtitle">{t.personality.cardSubtitle}</p>
            </div>
            {unsaved && <span className="personality-status">{t.personality.unsaved}</span>}
          </div>

          <div className="personality-section">
            <h3 className="personality-label">{t.personality.styleLabel}</h3>
            <div className="personality-presets">
              {PRESETS.map(({ key, icon: Icon }) => {
                const selected = prompt === presets[key].prompt;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`personality-preset${selected ? ' selected' : ''}`}
                    onClick={() => setPrompt(presets[key].prompt)}
                    disabled={busy}
                    aria-pressed={selected}
                  >
                    <span className="personality-preset-icons">
                      <Icon size={17} aria-hidden="true" />
                      {selected && <CircleCheck size={15} aria-hidden="true" />}
                    </span>
                    <span className="personality-preset-name">{presets[key].name}</span>
                    <span className="personality-preset-hint">{presets[key].hint}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="personality-section personality-editor">
            <div className="personality-editor-heading">
              <label className="personality-label" htmlFor="personality-input">
                {t.personality.instructionsLabel}
              </label>
              <button
                type="button"
                className="personality-reset"
                onClick={() => setPrompt(presets.friendly.prompt)}
                disabled={busy}
              >
                <RotateCcw size={13} aria-hidden="true" />
                {t.personality.resetDefault}
              </button>
            </div>
            <p className="personality-hint">{t.personality.instructionsHint}</p>
            <textarea
              id="personality-input"
              className="personality-input"
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder={presets.friendly.prompt}
              maxLength={MAX_PERSONALITY_CHARS}
              disabled={busy}
            />
            <div className="personality-meta">
              <span>{t.personality.tip}</span>
              <span>
                {formatText(t.personality.characters, {
                  count: prompt.length.toLocaleString(locale),
                  max: MAX_PERSONALITY_CHARS.toLocaleString(locale),
                })}
              </span>
            </div>
          </div>
        </div>

        <div className="personality-footer">
          <p className="personality-note">
            <Clock3 size={15} aria-hidden="true" />
            {t.personality.publishNote}
          </p>
          <div className="personality-actions">
            <button
              type="button"
              className="personality-clear"
              onClick={() => save('')}
              disabled={busy || (!saved && !prompt)}
            >
              {t.personality.clear}
            </button>
            <button
              type="button"
              className="personality-save"
              onClick={() => save(prompt)}
              disabled={busy || !unsaved}
            >
              <Check size={16} aria-hidden="true" />
              {saving ? t.personality.saving : t.personality.save}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
