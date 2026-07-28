'use client';

import { useState, useRef, useEffect } from 'react';
import { Upload, ExternalLink, Globe } from 'lucide-react';
import { getUser } from '@/lib/dashboard/auth';
import { useSettings } from '@/lib/dashboard/settings-context';
import { useLanguage } from '@/context/LanguageContext';

type SettingsTab = 'profile' | 'appearance' | 'help' | 'about';

export default function SettingsPage() {
  const { settings, updateSettings } = useSettings();
  const { t } = useLanguage();
  const [activeTab, setActiveTab] = useState<SettingsTab>('profile');

  // LOCAL draft state — only saved to context on "Save Changes"
  const [firstName, setFirstName] = useState(settings.firstName);
  const [lastName, setLastName] = useState(settings.lastName);
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [draftProfileImage, setDraftProfileImage] = useState<string | null>(settings.profileImage);
  const [draftLogo, setDraftLogo] = useState<string | null>(settings.companyLogo);
  const [draftTheme, setDraftTheme] = useState<'light' | 'dark'>(settings.theme);
  const [draftTextSize, setDraftTextSize] = useState<'small' | 'medium' | 'large'>(settings.textSize);

  const profileInputRef = useRef<HTMLInputElement>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);

  function resetToSaved() {
    setFirstName(settings.firstName);
    setLastName(settings.lastName);
    setDraftProfileImage(settings.profileImage);
    setDraftLogo(settings.companyLogo);
    setDraftTheme(settings.theme);
    setDraftTextSize(settings.textSize);
  }

  // Keep local drafts aligned when persisted settings hydrate or change elsewhere.
  useEffect(() => {
    const frame = window.requestAnimationFrame(resetToSaved);
    return () => window.cancelAnimationFrame(frame);
    // The individual fields below are the complete persisted draft input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.firstName, settings.lastName, settings.profileImage, settings.companyLogo, settings.theme, settings.textSize]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const user = getUser();
      if (user) setEmail(user.email);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  function handleCancel() {
    resetToSaved();
  }

  function saveProfile() {
    updateSettings({
      firstName,
      lastName,
      profileImage: draftProfileImage,
    });
    alert(t.adminSettings.profileSaved);
  }

  function saveAppearance() {
    updateSettings({
      companyLogo: draftLogo,
      theme: draftTheme,
      textSize: draftTextSize,
    });
    alert(t.adminSettings.appearanceSaved);
  }

  function handleProfileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setDraftProfileImage(reader.result as string);
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setDraftLogo(reader.result as string);
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  function removeLogo() {
    setDraftLogo(null);
  }

  const tabs: { id: SettingsTab; label: string; external?: boolean }[] = [
    { id: 'profile', label: t.adminSettings.editProfile },
    { id: 'appearance', label: t.adminSettings.appearance },
    { id: 'help', label: t.adminSettings.help, external: true },
    { id: 'about', label: t.adminSettings.aboutUs, external: true },
  ];

  return (
    <div className="settings-page">
      <h1 className="settings-title">{t.adminSettings.title}</h1>
      <div className="settings-layout">
        <div className="settings-tabs">
          {tabs.map(tab => (
            <button key={tab.id} className={`settings-tab ${activeTab === tab.id ? 'active' : ''}`} onClick={() => setActiveTab(tab.id)}>
              <span>{tab.label}</span>
              {tab.external && <ExternalLink size={12} />}
            </button>
          ))}
        </div>

        <div className="settings-content">
          {activeTab === 'profile' && (
            <div className="settings-panel">
              <h2 className="panel-title">{t.adminSettings.basicInformation}</h2>
              <div className="panel-section">
                <label className="panel-label">{t.adminSettings.profile}</label>
                <div className="profile-upload-row">
                  <div className="profile-avatar-large">
                    {draftProfileImage ? <img src={draftProfileImage} alt="Profile" /> : <span>?</span>}
                  </div>
                  <button className="upload-link" onClick={() => profileInputRef.current?.click()}>
                    <Upload size={14} /> {t.adminSettings.upload}
                  </button>
                  <input ref={profileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleProfileUpload} />
                </div>
              </div>
              <div className="form-grid">
                <div className="form-field">
                  <label>{t.adminSettings.firstName} <span className="required">*</span></label>
                  <input type="text" value={firstName} onChange={e => setFirstName(e.target.value)} placeholder={t.adminSettings.firstNamePlaceholder} />
                </div>
                <div className="form-field">
                  <label>{t.adminSettings.lastName} <span className="required">*</span></label>
                  <input type="text" value={lastName} onChange={e => setLastName(e.target.value)} placeholder={t.adminSettings.lastNamePlaceholder} />
                </div>
                <div className="form-field">
                  <label>{t.adminSettings.email}</label>
                  <input type="email" value={email} disabled />
                </div>
                <div className="form-field">
                  <label>{t.adminSettings.mobileNumber}</label>
                  <input type="text" value={mobile} onChange={e => setMobile(e.target.value)} placeholder={t.adminSettings.phonePlaceholder} />
                </div>
              </div>
              <div className="panel-actions">
                <button className="btn-cancel" onClick={handleCancel}>{t.adminSettings.cancel}</button>
                <button className="btn-save" onClick={saveProfile}>{t.adminSettings.saveChanges}</button>
              </div>
            </div>
          )}

          {activeTab === 'appearance' && (
            <div className="settings-panel">
              <h2 className="panel-title">{t.adminSettings.appearance}</h2>
              <div className="appearance-section">
                <div className="appearance-row">
                  <div><h3 className="appearance-label">{t.adminSettings.companyLogo}</h3><p className="appearance-desc">{t.adminSettings.companyLogoDescription}</p></div>
                  <div className="logo-controls">
                    <div className="logo-preview">{draftLogo ? <img src={draftLogo} alt="Logo" /> : <img src="/gcc-logo.png" alt="GCC Logo" />}</div>
                    <button className="btn-replace-logo" onClick={() => logoInputRef.current?.click()}>{t.adminSettings.replaceLogo}</button>
                    {draftLogo && <button className="btn-remove-logo" onClick={removeLogo}>{t.adminSettings.remove}</button>}
                    <input ref={logoInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleLogoUpload} />
                  </div>
                </div>
                <div className="appearance-row">
                  <div><h3 className="appearance-label">{t.adminSettings.interfaceTheme}</h3><p className="appearance-desc">{t.adminSettings.interfaceThemeDescription}</p></div>
                  <div className="theme-options">
                    <label className={`theme-option ${draftTheme === 'light' ? 'active' : ''}`}>
                      <div className="theme-preview light-preview" /><input type="radio" name="theme" checked={draftTheme === 'light'} onChange={() => setDraftTheme('light')} /><span>{t.adminSettings.light}</span>
                    </label>
                    <label className={`theme-option ${draftTheme === 'dark' ? 'active' : ''}`}>
                      <div className="theme-preview dark-preview" /><input type="radio" name="theme" checked={draftTheme === 'dark'} onChange={() => setDraftTheme('dark')} /><span>{t.adminSettings.dark}</span>
                    </label>
                  </div>
                </div>
                <div className="appearance-row">
                  <div><h3 className="appearance-label">{t.adminSettings.language}</h3><p className="appearance-desc">{t.adminSettings.languageDescription}</p></div>
                  <div className="lang-options">
                    <button className={`lang-btn ${settings.language === 'english' ? 'active' : ''}`} onClick={() => updateSettings({ language: 'english' })} aria-pressed={settings.language === 'english'}><Globe size={13} /> {t.common.english}</button>
                    <button className={`lang-btn ${settings.language === 'espanol' ? 'active' : ''}`} onClick={() => updateSettings({ language: 'espanol' })} aria-pressed={settings.language === 'espanol'}><Globe size={13} /> {t.common.spanish}</button>
                  </div>
                </div>
              </div>
              <div className="panel-actions">
                <button className="btn-cancel" onClick={handleCancel}>{t.adminSettings.cancel}</button>
                <button className="btn-save" onClick={saveAppearance}>{t.adminSettings.saveChanges}</button>
              </div>
            </div>
          )}

          {activeTab === 'help' && (
            <div className="settings-panel"><h2 className="panel-title">{t.adminSettings.help}</h2><p className="panel-desc">{t.adminSettings.helpPlaceholder}</p></div>
          )}
          {activeTab === 'about' && (
            <div className="settings-panel"><h2 className="panel-title">{t.adminSettings.aboutUs}</h2><p className="panel-desc">{t.adminSettings.aboutPlaceholder}</p></div>
          )}
        </div>
      </div>
    </div>
  );
}
