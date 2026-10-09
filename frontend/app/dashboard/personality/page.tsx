'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { getPersonalityPrompt, savePersonalityPrompt } from '@/lib/dashboard/api';
import { useLanguage } from '@/context/LanguageContext';
import { formatText } from '@/lib/i18n';

// Matches the dashboard Lambda's limit (SSM standard parameters hold 4 KB).
const MAX_PERSONALITY_CHARS = 4000;

export default function PersonalityPage() {
  const { t } = useLanguage();
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
  return (
    <div className="personality-page">
      <div className="breadcrumb">
        <span className="breadcrumb-arrow">‹</span>
        <span className="breadcrumb-text">{t.personality.title}</span>
      </div>

      <section className="personality-card">
        <p className="personality-description">{t.personality.description}</p>
        <textarea
          className="personality-input"
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder={t.personality.placeholder}
          maxLength={MAX_PERSONALITY_CHARS}
          rows={7}
          disabled={busy}
          aria-label={t.personality.title}
        />
        <div className="personality-footer">
          <span className="personality-count">
            {formatText(t.personality.characters, { count: prompt.length, max: MAX_PERSONALITY_CHARS })}
          </span>
          <div className="personality-actions">
            <button className="bulk-btn" onClick={() => save('')} disabled={busy || !saved}>
              {t.personality.clear}
            </button>
            <button className="btn-attachment" onClick={() => save(prompt)} disabled={busy || prompt.trim() === saved}>
              {saving ? t.personality.saving : t.personality.save}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
