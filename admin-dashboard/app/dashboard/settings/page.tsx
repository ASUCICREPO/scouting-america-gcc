'use client';

import { useState, useRef, useEffect } from 'react';
import { Upload, ExternalLink } from 'lucide-react';
import { getUser } from '../../../lib/auth';
import { useSettings } from '../../../lib/settings-context';

type SettingsTab = 'profile' | 'appearance' | 'help' | 'about';

export default function SettingsPage() {
  const { settings, updateSettings } = useSettings();
  const [activeTab, setActiveTab] = useState<SettingsTab>('profile');

  // LOCAL draft state — only saved to context on "Save Changes"
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [draftProfileImage, setDraftProfileImage] = useState<string | null>(null);
  const [draftLogo, setDraftLogo] = useState<string | null>(null);
  const [draftTheme, setDraftTheme] = useState<'light' | 'dark'>('light');
  const [draftLanguage, setDraftLanguage] = useState<'english' | 'espanol'>('english');
  const [draftTextSize, setDraftTextSize] = useState<'small' | 'medium' | 'large'>('medium');

  const profileInputRef = useRef<HTMLInputElement>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);

  // Initialize draft from saved settings
  useEffect(() => {
    resetToSaved();
  }, [settings]);

  useEffect(() => {
    const user = getUser();
    if (user) setEmail(user.email);
  }, []);

  function resetToSaved() {
    setFirstName(settings.firstName);
    setLastName(settings.lastName);
    setDraftProfileImage(settings.profileImage);
    setDraftLogo(settings.companyLogo);
    setDraftTheme(settings.theme);
    setDraftLanguage(settings.language);
    setDraftTextSize(settings.textSize);
  }

  function handleCancel() {
    resetToSaved();
  }

  function saveProfile() {
    updateSettings({
      firstName,
      lastName,
      profileImage: draftProfileImage,
    });
    alert('Profile saved!');
  }

  function saveAppearance() {
    updateSettings({
      companyLogo: draftLogo,
      theme: draftTheme,
      language: draftLanguage,
      textSize: draftTextSize,
    });
    alert('Appearance saved! Changes applied.');
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
    { id: 'profile', label: 'Edit Profile' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'help', label: 'Help', external: true },
    { id: 'about', label: 'About us', external: true },
  ];

  return (
    <div className="settings-page">
      <h1 className="settings-title">› Settings</h1>
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
              <h2 className="panel-title">Basic Information</h2>
              <div className="panel-section">
                <label className="panel-label">Profile</label>
                <div className="profile-upload-row">
                  <div className="profile-avatar-large">
                    {draftProfileImage ? <img src={draftProfileImage} alt="Profile" /> : <span>?</span>}
                  </div>
                  <button className="upload-link" onClick={() => profileInputRef.current?.click()}>
                    <Upload size={14} /> Upload
                  </button>
                  <input ref={profileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleProfileUpload} />
                </div>
              </div>
              <div className="form-grid">
                <div className="form-field">
                  <label>First Name <span className="required">*</span></label>
                  <input type="text" value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="First name" />
                </div>
                <div className="form-field">
                  <label>Last Name <span className="required">*</span></label>
                  <input type="text" value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Last name" />
                </div>
                <div className="form-field">
                  <label>Email</label>
                  <input type="email" value={email} disabled />
                </div>
                <div className="form-field">
                  <label>Mobile Number</label>
                  <input type="text" value={mobile} onChange={e => setMobile(e.target.value)} placeholder="Phone number" />
                </div>
              </div>
              <div className="panel-actions">
                <button className="btn-cancel" onClick={handleCancel}>Cancel</button>
                <button className="btn-save" onClick={saveProfile}>Save Changes</button>
              </div>
            </div>
          )}

          {activeTab === 'appearance' && (
            <div className="settings-panel">
              <h2 className="panel-title">Appearance</h2>
              <div className="appearance-section">
                <div className="appearance-row">
                  <div><h3 className="appearance-label">Company logo</h3><p className="appearance-desc">Update your company logo.</p></div>
                  <div className="logo-controls">
                    <div className="logo-preview">{draftLogo ? <img src={draftLogo} alt="Logo" /> : <img src="/gcc-logo.png" alt="GCC Logo" />}</div>
                    <button className="btn-replace-logo" onClick={() => logoInputRef.current?.click()}>Replace logo</button>
                    {draftLogo && <button className="btn-remove-logo" onClick={removeLogo}>Remove</button>}
                    <input ref={logoInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleLogoUpload} />
                  </div>
                </div>
                <div className="appearance-row">
                  <div><h3 className="appearance-label">Interface theme</h3><p className="appearance-desc">Select or customize your UI theme.</p></div>
                  <div className="theme-options">
                    <label className={`theme-option ${draftTheme === 'light' ? 'active' : ''}`}>
                      <div className="theme-preview light-preview" /><input type="radio" name="theme" checked={draftTheme === 'light'} onChange={() => setDraftTheme('light')} /><span>Light</span>
                    </label>
                    <label className={`theme-option ${draftTheme === 'dark' ? 'active' : ''}`}>
                      <div className="theme-preview dark-preview" /><input type="radio" name="theme" checked={draftTheme === 'dark'} onChange={() => setDraftTheme('dark')} /><span>Dark</span>
                    </label>
                  </div>
                </div>
                <div className="appearance-row">
                  <div><h3 className="appearance-label">Language</h3><p className="appearance-desc">Select your preferred display language.</p></div>
                  <div className="lang-options">
                    <button className={`lang-btn ${draftLanguage === 'english' ? 'active' : ''}`} onClick={() => setDraftLanguage('english')}>🌐 English</button>
                    <button className={`lang-btn ${draftLanguage === 'espanol' ? 'active' : ''}`} onClick={() => setDraftLanguage('espanol')}>🌐 Español</button>
                  </div>
                </div>
                <div className="appearance-row">
                  <div><h3 className="appearance-label">Text size</h3><p className="appearance-desc">Adjust the size of text across the interface.</p></div>
                  <div className="text-size-options">
                    <button className={`size-btn ${draftTextSize === 'small' ? 'active' : ''}`} onClick={() => setDraftTextSize('small')}><span className="size-label">Aa</span><span>Small</span></button>
                    <button className={`size-btn ${draftTextSize === 'medium' ? 'active' : ''}`} onClick={() => setDraftTextSize('medium')}><span className="size-label">Aa</span><span>Medium</span></button>
                    <button className={`size-btn ${draftTextSize === 'large' ? 'active' : ''}`} onClick={() => setDraftTextSize('large')}><span className="size-label">Aa</span><span>Large</span></button>
                  </div>
                </div>
              </div>
              <div className="panel-actions">
                <button className="btn-cancel" onClick={handleCancel}>Cancel</button>
                <button className="btn-save" onClick={saveAppearance}>Save Changes</button>
              </div>
            </div>
          )}

          {activeTab === 'help' && (
            <div className="settings-panel"><h2 className="panel-title">Help</h2><p className="panel-desc">Help documentation link will be added here.</p></div>
          )}
          {activeTab === 'about' && (
            <div className="settings-panel"><h2 className="panel-title">About Us</h2><p className="panel-desc">About us page link will be added here.</p></div>
          )}
        </div>
      </div>
    </div>
  );
}
