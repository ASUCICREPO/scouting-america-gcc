'use client';

import { useEffect, useState } from 'react';
import { Check, ChevronRight, Clock3, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { getPersonalityPrompt, savePersonalityPrompt } from '@/lib/dashboard/api';
import { useLanguage } from '@/context/LanguageContext';
import { formatText } from '@/lib/i18n';

// Matches the dashboard Lambda's limit.
const MAX_PERSONALITY_CHARS = 4000;

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
          <div className="personality-section personality-editor">
            <div className="personality-editor-heading">
              <label className="personality-label" htmlFor="personality-input">
                {t.personality.instructionsLabel}
                {unsaved && <span className="personality-status">{t.personality.unsaved}</span>}
              </label>
              <button
                type="button"
                className="personality-link"
                onClick={() => setPrompt(saved)}
                disabled={busy || !unsaved}
              >
                <RotateCcw size={13} aria-hidden="true" />
                {t.personality.reset}
              </button>
            </div>
            <p className="personality-hint">{t.personality.instructionsHint}</p>
            <textarea
              id="personality-input"
              className="personality-input"
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder={t.personality.placeholder}
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
