import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  confirmPasswordReset,
  login,
  requestPasswordReset,
} from './auth';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const jwt = (payload: Record<string, unknown>): string => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  return `header.${encoded}.signature`;
};

const response = (body: Record<string, unknown>): Response => ({
  json: vi.fn().mockResolvedValue(body),
}) as unknown as Response;

describe('admin authentication privacy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('window', { location: { href: '' } });
    vi.stubGlobal('sessionStorage', new MemoryStorage());
    vi.stubGlobal('localStorage', new MemoryStorage());
  });

  it.each([
    'NotAuthorizedException',
    'UserNotFoundException',
    'UserNotConfirmedException',
  ])('returns the same login error for %s', async (errorType) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ __type: errorType })));

    await expect(login('admin@example.org', 'wrong-password')).resolves.toEqual({
      success: false,
      error: 'credentials',
    });
  });

  it('does not reveal a valid account that lacks the admin group', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      AuthenticationResult: {
        IdToken: jwt({ email: 'volunteer@example.org', 'cognito:groups': ['volunteers'] }),
        AccessToken: jwt({ token_use: 'access' }),
        RefreshToken: 'refresh-token',
      },
    })));

    await expect(login('volunteer@example.org', 'Password1!')).resolves.toEqual({
      success: false,
      error: 'credentials',
    });
    expect(sessionStorage.getItem('gcc_admin_tokens')).toBeNull();
  });

  it('stores tokens only after an administrator signs in', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      AuthenticationResult: {
        IdToken: jwt({ email: 'admin@example.org', 'cognito:groups': ['admin'] }),
        AccessToken: jwt({ token_use: 'access' }),
        RefreshToken: 'refresh-token',
      },
    })));

    await expect(login('admin@example.org', 'Password1!')).resolves.toEqual({ success: true });
    expect(sessionStorage.getItem('gcc_admin_tokens')).not.toBeNull();
  });

  it.each([
    {},
    { __type: 'UserNotFoundException' },
    { __type: 'InvalidParameterException' },
  ])('uses the same password-reset response regardless of account state', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));

    await expect(requestPasswordReset('admin@example.org')).resolves.toEqual({ success: true });
  });

  it('does not pass Cognito password-reset messages to the UI', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      __type: 'CodeMismatchException',
      message: 'Secret provider detail',
    })));

    await expect(confirmPasswordReset('admin@example.org', '000000', 'Password1!'))
      .resolves.toEqual({ success: false, error: 'confirm_failed' });
  });
});
