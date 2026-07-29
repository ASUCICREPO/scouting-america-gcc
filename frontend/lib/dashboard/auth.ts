import { COGNITO_CONFIG } from '../config';

const COGNITO_ENDPOINT = `https://cognito-idp.${COGNITO_CONFIG.region}.amazonaws.com/`;
const ACCOUNT_SAFE_RESET_ERRORS = new Set([
  'InvalidParameterException',
  'NotAuthorizedException',
  'UserNotFoundException',
]);
const TOKEN_REFRESH_SKEW_SECONDS = 60;

/**
 * Admin Dashboard Authentication — uses Cognito User Pool (shared with chatbot).
 *
 * Flow:
 * 1. Admin enters email + password on login page
 * 2. Authenticates against Cognito using InitiateAuth (USER_PASSWORD_AUTH)
 * 3. Cognito returns JWT tokens (idToken contains group claims)
 * 4. Backend Lambda validates the 'admin' group claim on every request
 *
 * Admin users must be manually created in Cognito and added to the 'admin' group.
 * There is no signup — this is intentional for an admin-only dashboard.
 */
const TOKEN_KEY = 'gcc_admin_tokens';

interface AuthTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
}

interface JwtPayload {
  email?: unknown;
  exp?: unknown;
  'cognito:groups'?: unknown;
}

export interface AdminUser {
  email: string;
  groups: string[];
  isAdmin: boolean;
}

export type AuthError = 'credentials' | 'network' | 'request_failed' | 'confirm_failed';

export interface AuthResult {
  success: boolean;
  error?: AuthError;
}

interface CognitoResponse {
  __type?: string;
  AuthenticationResult?: {
    IdToken: string;
    AccessToken: string;
    RefreshToken?: string;
  };
}

let refreshPromise: Promise<AuthTokens | null> | null = null;
let sessionGeneration = 0;

async function cognitoRequest(target: string, body: Record<string, unknown>): Promise<CognitoResponse> {
  const response = await fetch(COGNITO_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  });
  return response.json();
}

/**
 * Authenticate with Cognito using email + password.
 * Returns true on success, false on failure.
 */
export async function login(email: string, password: string): Promise<AuthResult> {
  try {
    const data = await cognitoRequest('InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: COGNITO_CONFIG.clientId,
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
      },
    });

    if (data.AuthenticationResult) {
      const tokens: AuthTokens = {
        idToken: data.AuthenticationResult.IdToken,
        accessToken: data.AuthenticationResult.AccessToken,
        refreshToken: data.AuthenticationResult.RefreshToken || '',
      };
      // Invalidate any refresh request that started from an older session
      // before replacing it with this newly authenticated session.
      sessionGeneration += 1;
      sessionStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));

      // Verify admin group membership
      const user = getUser();
      if (!user?.isAdmin) {
        clearAdminSession();
        return { success: false, error: 'credentials' };
      }

      return { success: true };
    }

    // Do not reveal whether an email exists, is unconfirmed, or lacks the
    // administrator group. Cognito is configured to suppress user-existence
    // errors, and the browser maintains the same boundary.
    return { success: false, error: 'credentials' };
  } catch (err) {
    console.error('Login error:', err);
    return { success: false, error: 'network' };
  }
}

export async function requestPasswordReset(email: string): Promise<AuthResult> {
  try {
    const data = await cognitoRequest('ForgotPassword', {
      ClientId: COGNITO_CONFIG.clientId,
      Username: email,
    });
    const errorType = data.__type?.split('#').pop();
    if (!errorType || ACCOUNT_SAFE_RESET_ERRORS.has(errorType)) {
      return { success: true };
    }
    return { success: false, error: 'request_failed' };
  } catch (err) {
    console.error('Password reset request error:', err);
    return { success: false, error: 'network' };
  }
}

export async function confirmPasswordReset(
  email: string,
  confirmationCode: string,
  password: string,
): Promise<AuthResult> {
  try {
    const data = await cognitoRequest('ConfirmForgotPassword', {
      ClientId: COGNITO_CONFIG.clientId,
      Username: email,
      ConfirmationCode: confirmationCode,
      Password: password,
    });
    return data.__type
      ? { success: false, error: 'confirm_failed' }
      : { success: true };
  } catch (err) {
    console.error('Password reset confirmation error:', err);
    return { success: false, error: 'network' };
  }
}

export function getStoredTokens(): AuthTokens | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = sessionStorage.getItem(TOKEN_KEY);
    if (!stored) return null;
    const parsed: unknown = JSON.parse(stored);
    if (!isAuthTokens(parsed)) {
      clearAdminSession();
      return null;
    }
    return parsed;
  } catch {
    clearAdminSession();
    return null;
  }
}

function isAuthTokens(value: unknown): value is AuthTokens {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AuthTokens>;
  return (
    typeof candidate.idToken === 'string' && candidate.idToken.length > 0 &&
    typeof candidate.accessToken === 'string' && candidate.accessToken.length > 0 &&
    typeof candidate.refreshToken === 'string'
  );
}

function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return payload && typeof payload === 'object' ? payload as JwtPayload : null;
  } catch {
    return null;
  }
}

function adminTokenIsCurrent(token: string, refreshSkewSeconds = 0): boolean {
  const payload = decodeJwtPayload(token);
  const expiry = typeof payload?.exp === 'number' ? payload.exp : Number.NaN;
  const groups = Array.isArray(payload?.['cognito:groups'])
    ? payload['cognito:groups']
    : [];
  return (
    Number.isFinite(expiry) &&
    expiry > (Date.now() / 1000) + refreshSkewSeconds &&
    groups.includes('admin')
  );
}

async function refreshAdminTokens(tokens: AuthTokens): Promise<AuthTokens | null> {
  const expectedGeneration = sessionGeneration;
  try {
    const data = await cognitoRequest('InitiateAuth', {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: COGNITO_CONFIG.clientId,
      AuthParameters: {
        REFRESH_TOKEN: tokens.refreshToken,
      },
    });
    const authentication = data.AuthenticationResult;
    if (
      !authentication ||
      typeof authentication.IdToken !== 'string' ||
      typeof authentication.AccessToken !== 'string'
    ) {
      clearAdminSession();
      return null;
    }

    const refreshed: AuthTokens = {
      idToken: authentication.IdToken,
      accessToken: authentication.AccessToken,
      refreshToken: authentication.RefreshToken || tokens.refreshToken,
    };
    if (!adminTokenIsCurrent(refreshed.idToken)) {
      clearAdminSession();
      return null;
    }
    // Logout or an authorization failure may have cleared the session while
    // this network request was in flight. Never recreate that cleared session.
    if (sessionGeneration !== expectedGeneration) return null;
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify(refreshed));
    return refreshed;
  } catch (err) {
    // A transient network failure must not destroy the refresh token. The
    // caller can retry session restoration when connectivity returns.
    console.error('Token refresh error:', err);
    return null;
  }
}

export async function getValidIdToken(): Promise<string | null> {
  const tokens = getStoredTokens();
  if (!tokens) return null;

  const payload = decodeJwtPayload(tokens.idToken);
  const groups = Array.isArray(payload?.['cognito:groups'])
    ? payload['cognito:groups']
    : [];
  if (!groups.includes('admin')) {
    clearAdminSession();
    return null;
  }
  if (adminTokenIsCurrent(tokens.idToken, TOKEN_REFRESH_SKEW_SECONDS)) {
    return tokens.idToken;
  }
  if (!tokens.refreshToken) {
    clearAdminSession();
    return null;
  }

  if (!refreshPromise) {
    refreshPromise = refreshAdminTokens(tokens).finally(() => {
      refreshPromise = null;
    });
  }
  return (await refreshPromise)?.idToken || null;
}

export function getUser(): AdminUser | null {
  const tokens = getStoredTokens();
  if (!tokens) return null;
  const payload = decodeJwtPayload(tokens.idToken);
  if (!payload) {
    clearAdminSession();
    return null;
  }
  const groups = Array.isArray(payload['cognito:groups'])
    ? payload['cognito:groups'].filter((group): group is string => typeof group === 'string')
    : [];
  return {
    email: typeof payload.email === 'string' ? payload.email : '',
    groups,
    isAdmin: groups.includes('admin'),
  };
}

export function isAuthenticated(): boolean {
  const tokens = getStoredTokens();
  if (!tokens) return false;
  const payload = decodeJwtPayload(tokens.idToken);
  const groups = Array.isArray(payload?.['cognito:groups'])
    ? payload['cognito:groups']
    : [];
  if (!groups.includes('admin')) {
    clearAdminSession();
    return false;
  }
  return adminTokenIsCurrent(tokens.idToken);
}

export function clearAdminSession(): void {
  if (typeof window === 'undefined') return;
  sessionGeneration += 1;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // The browser can deny storage access in restricted privacy contexts.
  }
  try {
    // Remove tokens written by pre-hardening builds.
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // The browser can deny storage access in restricted privacy contexts.
  }
}

export async function logout(): Promise<void> {
  const tokens = getStoredTokens();
  try {
    if (tokens) {
      const result = await cognitoRequest('GlobalSignOut', {
        AccessToken: tokens.accessToken,
      });
      // If the access token has already expired, revoke its refresh-token
      // family as a fallback so it cannot mint a new administrator session.
      if (result.__type && tokens.refreshToken) {
        await cognitoRequest('RevokeToken', {
          ClientId: COGNITO_CONFIG.clientId,
          Token: tokens.refreshToken,
        });
      }
    }
  } catch (err) {
    // Local logout must still complete if Cognito or the network is unavailable.
    console.error('Cognito logout error:', err);
  } finally {
    clearAdminSession();
    if (typeof window !== 'undefined') window.location.href = '/admin';
  }
}
