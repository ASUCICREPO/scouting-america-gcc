'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

export interface AppSettings {
  theme: 'light' | 'dark';
  language: 'english' | 'espanol';
  textSize: 'small' | 'medium' | 'large';
  companyLogo: string | null;
  profileImage: string | null;
  firstName: string;
  lastName: string;
}

const defaultSettings: AppSettings = {
  theme: 'light',
  language: 'english',
  textSize: 'medium',
  companyLogo: null,
  profileImage: null,
  firstName: '',
  lastName: '',
};

interface SettingsContextType {
  settings: AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => void;
}

const SettingsContext = createContext<SettingsContextType>({
  settings: defaultSettings,
  updateSettings: () => {},
});

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    // Load from localStorage
    const saved = localStorage.getItem('gcc_admin_app_settings');
    if (saved) {
      try {
        setSettings({ ...defaultSettings, ...JSON.parse(saved) });
      } catch {}
    }
  }, []);

  useEffect(() => {
    if (!mounted) return;
    // Apply theme
    document.documentElement.setAttribute('data-theme', settings.theme);
    // Apply text size
    document.documentElement.setAttribute('data-text-size', settings.textSize);
  }, [settings.theme, settings.textSize, mounted]);

  function updateSettings(partial: Partial<AppSettings>) {
    setSettings(prev => {
      const updated = { ...prev, ...partial };
      localStorage.setItem('gcc_admin_app_settings', JSON.stringify(updated));
      return updated;
    });
  }

  if (!mounted) return <>{children}</>;

  return (
    <SettingsContext.Provider value={{ settings, updateSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
