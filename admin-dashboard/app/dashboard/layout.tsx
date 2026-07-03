'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { isAuthenticated, logout } from '../../lib/auth';
import { LayoutDashboard, FileText, Settings, LogOut, Bell, User } from 'lucide-react';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (!isAuthenticated()) {
      router.push('/');
    }
  }, [router]);

  if (!mounted) return null;

  const navItems = [
    { label: 'Overview', href: '/dashboard', icon: LayoutDashboard },
    { label: 'Manage documents', href: '/dashboard/documents', icon: FileText },
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
          <div className="dash-logo-badge">GCC</div>
          <div className="dash-logo-text">
            <span className="dash-logo-title">GRAND CANYON COUNCIL</span>
            <span className="dash-logo-sub">BSA · EST. 1925</span>
          </div>
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

        <div className="dash-sidebar-footer">
          <button className="dash-nav-item">
            <Settings size={15} />
            <span>Settings</span>
          </button>
          <button className="dash-nav-item logout" onClick={logout}>
            <LogOut size={15} />
            <span>Logout</span>
          </button>
        </div>
      </aside>

      {/* Main Area */}
      <main className="dash-main">
        <header className="dash-header">
          <div className="dash-header-spacer" />
          <div className="dash-header-right">
            <button className="dash-header-icon-btn">
              <Bell size={16} />
              <span className="dash-notification-badge" />
            </button>
            <div className="dash-avatar">
              <User size={14} />
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
