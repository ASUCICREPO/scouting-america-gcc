'use client';

import { useEffect, useState, useRef, useSyncExternalStore } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { isAuthenticated, logout, getUser } from '@/lib/dashboard/auth';
import { useSettings } from '@/lib/dashboard/settings-context';
import { LayoutDashboard, FileText, Bell, User, LogOut, Settings } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import LanguageSwitcher from '@/components/LanguageSwitcher';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const mounted = useSyncExternalStore(() => () => {}, () => true, () => false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { settings } = useSettings();
  const { t } = useLanguage();

  useEffect(() => {
    if (!isAuthenticated()) {
      router.push('/login');
    }

    // Close profile menu on outside click
    function handleClickOutside(e: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setShowProfileMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [router]);

  if (!mounted) return null;

  const navItems = [
    { label: t.dashboard.navOverview, href: '/dashboard', icon: LayoutDashboard },
    { label: t.dashboard.navDocuments, href: '/dashboard/documents', icon: FileText },
  ];

  const isActive = (href: string) => {
    if (href === '/dashboard') return pathname === '/dashboard';
    return pathname.startsWith(href);
  };

  return (
    <div className="dash-layout">
      {/* Sidebar */}
      <aside className="dash-sidebar">
        <div className="dash-sidebar-logo">
          {settings.companyLogo ? (
            <img src={settings.companyLogo} alt="Company Logo" className="dash-company-logo" />
          ) : (
            <img src="/gcc-logo.png" alt="GCC" className="dash-sidebar-logo-img" />
          )}
        </div>

        <nav className="dash-nav">
          {navItems.map((item) => (
            <button
              key={item.href}
              onClick={() => router.push(item.href)}
              className={`dash-nav-item ${isActive(item.href) ? 'active' : ''}`}
            >
              <item.icon size={16} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="dash-sidebar-footer" />
      </aside>

      {/* Main Area */}
      <main className="dash-main">
        <header className="dash-header">
          <div className="dash-header-spacer" />
          <div className="dash-header-right">
            <LanguageSwitcher compact className="dashboard-language-switcher" />
            <button className="dash-header-icon-btn" aria-label={t.dashboard.notifications} title={t.dashboard.notifications}>
              <Bell size={16} />
              <span className="dash-notification-badge" />
            </button>
            <div className="dash-profile-wrapper" ref={profileRef}>
              <button className="dash-avatar-btn" onClick={() => setShowProfileMenu(!showProfileMenu)}>
                {settings.profileImage ? (
                  <img src={settings.profileImage} alt="Profile" className="dash-avatar-img" />
                ) : (
                  <User size={14} />
                )}
              </button>
              {showProfileMenu && (
                <div className="dash-profile-menu">
                  <div className="dash-profile-menu-header">
                    <div className="dash-profile-preview">
                      {settings.profileImage ? (
                        <img src={settings.profileImage} alt="Profile" className="dash-profile-preview-img" />
                      ) : (
                        <div className="dash-profile-preview-placeholder"><User size={20} /></div>
                      )}
                    </div>
                    <div className="dash-profile-info">
                      <span className="dash-profile-email">{getUser()?.email || t.dashboard.admin}</span>
                      <span className="dash-profile-role">
                        {settings.firstName || settings.lastName
                          ? `${settings.firstName} ${settings.lastName}`.trim()
                          : t.dashboard.admin}
                      </span>
                    </div>
                  </div>
                  <div className="dash-profile-menu-divider" />
                  <button className="dash-profile-menu-item" onClick={() => { setShowProfileMenu(false); router.push('/dashboard/settings'); }}>
                    <Settings size={14} />
                    <span>{t.dashboard.settings}</span>
                  </button>
                  <button className="dash-profile-menu-item logout" onClick={logout}>
                    <LogOut size={14} />
                    <span>{t.dashboard.logout}</span>
                  </button>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={() => {}}
              />
            </div>
          </div>
        </header>
        <div className="dash-content">
          {children}
        </div>
      </main>

    </div>
  );
}
