import { COGNITO_CONFIG } from '../config';

const COGNITO_ENDPOINT = `https://cognito-idp.${COGNITO_CONFIG.region}.amazonaws.com/`;
const ACCOUNT_SAFE_RESET_ERRORS = new Set([
  'InvalidParameterException',
  'NotAuthorizedException',
  'UserNotFoundException',
]);

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
      sessionStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));

      // Verify admin group membership
      const user = getUser();
      if (!user?.isAdmin) {
        clearTokens();
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
  const stored = sessionStorage.getItem(TOKEN_KEY);
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

export function getIdToken(): string | null {
  const tokens = getStoredTokens();
  return tokens?.idToken || null;
}

export function getUser(): AdminUser | null {
  const tokens = getStoredTokens();
  if (!tokens) return null;
  try {
    const payload = JSON.parse(atob(tokens.idToken.split('.')[1]));
    const groups: string[] = payload['cognito:groups'] || [];
    return {
      email: payload.email || '',
      groups,
      isAdmin: groups.includes('admin'),
    };
  } catch {
    return null;
  }
}

export function isAuthenticated(): boolean {
  const tokens = getStoredTokens();
  if (!tokens) return false;
  try {
    const payload = JSON.parse(atob(tokens.idToken.split('.')[1]));
    // Check expiry
    if (payload.exp * 1000 < Date.now()) {
      clearTokens();
      return false;
    }
    // Check admin group
    const groups: string[] = payload['cognito:groups'] || [];
    return groups.includes('admin');
  } catch {
    return false;
  }
}

function clearTokens(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  // Remove tokens written by pre-hardening builds.
  localStorage.removeItem(TOKEN_KEY);
}

export function logout(): void {
  clearTokens();
  window.location.href = '/admin';
}
