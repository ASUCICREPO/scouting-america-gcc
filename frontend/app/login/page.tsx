'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { login, isAuthenticated } from '@/lib/dashboard/auth';
import { Mail, Lock, Eye, EyeOff } from 'lucide-react';
import '../dashboard/dashboard.css';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotCode, setForgotCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [forgotStep, setForgotStep] = useState<'email' | 'code'>('email');
  const [forgotMsg, setForgotMsg] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (isAuthenticated()) {
      router.push('/dashboard');
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
      router.push('/dashboard');
    } else {
      setError(result.error || 'Login failed');
    }
  }

  async function handleForgotSendCode(e: React.FormEvent) {
    e.preventDefault();
    setForgotMsg('');
    setForgotLoading(true);
    try {
      const res = await fetch(`https://cognito-idp.us-east-1.amazonaws.com/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': 'AWSCognitoIdentityProviderService.ForgotPassword',
        },
        body: JSON.stringify({
          ClientId: process.env.NEXT_PUBLIC_CLIENT_ID || 'REPLACE_AFTER_CDK_DEPLOY',
          Username: forgotEmail,
        }),
      });
      const data = await res.json();
      if (data.CodeDeliveryDetails) {
        setForgotStep('code');
        setForgotMsg(`Code sent to ${data.CodeDeliveryDetails.Destination}`);
      } else {
        setForgotMsg(data.message || 'Failed to send code');
      }
    } catch {
      setForgotMsg('Network error');
    }
    setForgotLoading(false);
  }

  async function handleForgotConfirm(e: React.FormEvent) {
    e.preventDefault();
    setForgotMsg('');
    setForgotLoading(true);
    try {
      const res = await fetch(`https://cognito-idp.us-east-1.amazonaws.com/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': 'AWSCognitoIdentityProviderService.ConfirmForgotPassword',
        },
        body: JSON.stringify({
          ClientId: process.env.NEXT_PUBLIC_CLIENT_ID || 'REPLACE_AFTER_CDK_DEPLOY',
          Username: forgotEmail,
          ConfirmationCode: forgotCode,
          Password: newPassword,
        }),
      });
      const data = await res.json();
      if (!data.__type) {
        setForgotMsg('Password changed successfully! You can now login.');
        setTimeout(() => { setShowForgot(false); setForgotStep('email'); }, 2000);
      } else {
        setForgotMsg(data.message || 'Failed to reset password');
      }
    } catch {
      setForgotMsg('Network error');
    }
    setForgotLoading(false);
  }

  // Forgot Password Screen
  if (showForgot) {
    return (
      <div className="login-container">
        <div className="login-card">
          <div className="login-logo">
            <div className="login-gcc-logo">
              <img src="/gcc-logo.png" alt="Grand Canyon Council" className="gcc-logo-img" />
            </div>
            <h1 className="login-title">Forgot Password</h1>
            <p className="login-subtitle">{forgotStep === 'email' ? 'Enter your email to receive a reset code' : 'Enter the code and your new password'}</p>
          </div>

          {forgotStep === 'email' ? (
            <form onSubmit={handleForgotSendCode} className="login-form">
              <div className="login-field">
                <label>Email <span className="required">*</span></label>
                <div className="input-with-icon">
                  <Mail size={16} className="input-icon" />
                  <input type="email" value={forgotEmail} onChange={e => setForgotEmail(e.target.value)} placeholder="Enter your email" required disabled={forgotLoading} />
                </div>
              </div>
              {forgotMsg && <p className={`login-msg ${forgotMsg.includes('sent') ? 'success' : 'error'}`}>{forgotMsg}</p>}
              <button type="submit" className="login-btn" disabled={forgotLoading}>{forgotLoading ? 'Sending...' : 'Send Code'}</button>
              <button type="button" className="login-link" onClick={() => setShowForgot(false)}>← Back to Login</button>
            </form>
          ) : (
            <form onSubmit={handleForgotConfirm} className="login-form">
              <div className="login-field">
                <label>Verification Code <span className="required">*</span></label>
                <div className="input-with-icon">
                  <Lock size={16} className="input-icon" />
                  <input type="text" value={forgotCode} onChange={e => setForgotCode(e.target.value)} placeholder="Enter code from email" required disabled={forgotLoading} />
                </div>
              </div>
              <div className="login-field">
                <label>New Password <span className="required">*</span></label>
                <div className="input-with-icon">
                  <Lock size={16} className="input-icon" />
                  <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="Enter new password" required disabled={forgotLoading} />
                </div>
              </div>
              {forgotMsg && <p className={`login-msg ${forgotMsg.includes('success') ? 'success' : 'error'}`}>{forgotMsg}</p>}
              <button type="submit" className="login-btn" disabled={forgotLoading}>{forgotLoading ? 'Resetting...' : 'Change Password'}</button>
              <button type="button" className="login-link" onClick={() => setShowForgot(false)}>← Back to Login</button>
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
        <div className="login-logo">
          <div className="login-gcc-logo">
            <img src="/gcc-logo.png" alt="Grand Canyon Council" className="gcc-logo-img" />
          </div>
          <h1 className="login-title">login</h1>
          <p className="login-subtitle">Enter your details to get started.</p>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="login-field">
            <label>Email <span className="required">*</span></label>
            <div className="input-with-icon">
              <Mail size={16} className="input-icon" />
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Username@gmail.com" required disabled={loading} />
            </div>
          </div>
          <div className="login-field">
            <label>Password <span className="required">*</span></label>
            <div className="input-with-icon">
              <Lock size={16} className="input-icon" />
              <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter your password" required disabled={loading} />
              <button type="button" className="eye-btn" onClick={() => setShowPassword(!showPassword)}>
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <button type="button" className="forgot-link" onClick={() => setShowForgot(true)}>Forgot password?</button>

          {error && <p className="login-error">{error}</p>}

          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? 'Signing in...' : 'Login'}
          </button>
        </form>
      </div>
    </div>
  );
}
