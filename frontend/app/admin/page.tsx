'use client';

// Canonical administrator sign-in route. The public application intentionally
// exposes no second login alias.

import { useState, useEffect, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import {
  confirmPasswordReset,
  isAuthenticated,
  login,
  requestPasswordReset,
} from '@/lib/dashboard/auth';
import { Mail, Lock, Eye, EyeOff, ArrowLeft } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import LanguageSwitcher from '@/components/LanguageSwitcher';
import '../dashboard/dashboard.css';

export default function LoginPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const mounted = useSyncExternalStore(() => () => {}, () => true, () => false);
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotCode, setForgotCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [forgotStep, setForgotStep] = useState<'email' | 'code'>('email');
  const [forgotMsg, setForgotMsg] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotSuccess, setForgotSuccess] = useState(false);

  useEffect(() => {
    if (isAuthenticated()) {
      router.replace('/dashboard');
    }
  }, [router]);

  if (!mounted) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const result = await login(email, password);
    setLoading(false);
    if (result.success) {
      router.replace('/dashboard');
    } else {
      setError(result.error === 'network' ? t.login.networkError : t.login.loginFailed);
    }
  }

  async function handleForgotSendCode(e: React.FormEvent) {
    e.preventDefault();
    setForgotMsg('');
    setForgotSuccess(false);
    setForgotLoading(true);
    const result = await requestPasswordReset(forgotEmail);
    if (result.success) {
      setForgotStep('code');
      setForgotSuccess(true);
      setForgotMsg(t.login.codeSent);
    } else {
      setForgotMsg(result.error === 'network' ? t.login.networkError : t.login.sendCodeFailed);
    }
    setForgotLoading(false);
  }

  async function handleForgotConfirm(e: React.FormEvent) {
    e.preventDefault();
    setForgotMsg('');
    setForgotSuccess(false);
    setForgotLoading(true);
    const result = await confirmPasswordReset(forgotEmail, forgotCode, newPassword);
    if (result.success) {
      setForgotSuccess(true);
      setForgotMsg(t.login.resetSuccess);
      setTimeout(() => { setShowForgot(false); setForgotStep('email'); }, 2000);
    } else {
      setForgotMsg(result.error === 'network' ? t.login.networkError : t.login.resetFailed);
    }
    setForgotLoading(false);
  }

  // Forgot Password Screen
  if (showForgot) {
    return (
      <div className="login-container">
        <div className="login-card">
          <LanguageSwitcher compact className="login-language-switcher" />
          <div className="login-logo">
            <div className="login-gcc-logo">
              <img src="/gcc-logo.png" alt="Grand Canyon Council" className="gcc-logo-img" />
            </div>
            <h1 className="login-title">{t.login.forgotTitle}</h1>
            <p className="login-subtitle">{forgotStep === 'email' ? t.login.resetEmailSubtitle : t.login.resetCodeSubtitle}</p>
          </div>

          {forgotStep === 'email' ? (
            <form onSubmit={handleForgotSendCode} className="login-form">
              <div className="login-field">
                <label>{t.login.email} <span className="required">*</span></label>
                <div className="input-with-icon">
                  <Mail size={16} className="input-icon" />
                  <input type="email" value={forgotEmail} onChange={e => setForgotEmail(e.target.value)} placeholder={t.login.emailPlaceholder} required disabled={forgotLoading} />
                </div>
              </div>
              {forgotMsg && <p className={`login-msg ${forgotSuccess ? 'success' : 'error'}`}>{forgotMsg}</p>}
              <button type="submit" className="login-btn" disabled={forgotLoading}>{forgotLoading ? t.login.sending : t.login.sendCode}</button>
              <button type="button" className="login-link" onClick={() => setShowForgot(false)}><ArrowLeft size={14} /> {t.login.backToLogin}</button>
            </form>
          ) : (
            <form onSubmit={handleForgotConfirm} className="login-form">
              <div className="login-field">
                <label>{t.login.verificationCode} <span className="required">*</span></label>
                <div className="input-with-icon">
                  <Lock size={16} className="input-icon" />
                  <input type="text" value={forgotCode} onChange={e => setForgotCode(e.target.value)} placeholder={t.login.codePlaceholder} required disabled={forgotLoading} />
                </div>
              </div>
              <div className="login-field">
                <label>{t.login.newPassword} <span className="required">*</span></label>
                <div className="input-with-icon">
                  <Lock size={16} className="input-icon" />
                  <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder={t.login.passwordPlaceholder} required disabled={forgotLoading} />
                </div>
              </div>
              {forgotMsg && <p className={`login-msg ${forgotSuccess ? 'success' : 'error'}`}>{forgotMsg}</p>}
              <button type="submit" className="login-btn" disabled={forgotLoading}>{forgotLoading ? t.login.resetting : t.login.changePassword}</button>
              <button type="button" className="login-link" onClick={() => setShowForgot(false)}><ArrowLeft size={14} /> {t.login.backToLogin}</button>
            </form>
          )}
        </div>
      </div>
    );
  }

  // Login Screen
  return (
    <div className="login-container">
      <div className="login-card">
        <LanguageSwitcher compact className="login-language-switcher" />
        <div className="login-logo">
          <div className="login-gcc-logo">
            <img src="/gcc-logo.png" alt="Grand Canyon Council" className="gcc-logo-img" />
          </div>
          <h1 className="login-title">{t.login.title}</h1>
          <p className="login-subtitle">{t.login.subtitle}</p>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="login-field">
            <label>{t.login.email} <span className="required">*</span></label>
            <div className="input-with-icon">
              <Mail size={16} className="input-icon" />
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder={t.login.emailPlaceholder} required disabled={loading} />
            </div>
          </div>
          <div className="login-field">
            <label>{t.login.password} <span className="required">*</span></label>
            <div className="input-with-icon">
              <Lock size={16} className="input-icon" />
              <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder={t.login.passwordPlaceholder} required disabled={loading} />
              <button type="button" className="eye-btn" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? t.login.hidePassword : t.login.showPassword}>
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <button type="button" className="forgot-link" onClick={() => setShowForgot(true)}>{t.login.forgotPassword}</button>

          {error && <p className="login-error">{error}</p>}

          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? t.login.signingIn : t.login.login}
          </button>
        </form>
      </div>
    </div>
  );
}
