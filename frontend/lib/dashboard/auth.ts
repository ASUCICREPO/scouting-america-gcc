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

const COGNITO_CONFIG = {
  userPoolId: process.env.NEXT_PUBLIC_USER_POOL_ID || 'REPLACE_AFTER_CDK_DEPLOY',
  clientId: process.env.NEXT_PUBLIC_CLIENT_ID || 'REPLACE_AFTER_CDK_DEPLOY',
  region: 'us-east-1',
};

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

/**
 * Authenticate with Cognito using email + password.
 * Returns true on success, false on failure.
 */
export async function login(email: string, password: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`https://cognito-idp.${COGNITO_CONFIG.region}.amazonaws.com/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      },
      body: JSON.stringify({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: COGNITO_CONFIG.clientId,
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
        },
      }),
    });

    const data = await response.json();

    if (data.AuthenticationResult) {
      const tokens: AuthTokens = {
        idToken: data.AuthenticationResult.IdToken,
        accessToken: data.AuthenticationResult.AccessToken,
        refreshToken: data.AuthenticationResult.RefreshToken || '',
      };
      localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));

      // Verify admin group membership
      const user = getUser();
      if (!user?.isAdmin) {
        clearTokens();
        return { success: false, error: 'Access denied: Admin group membership required' };
      }

      return { success: true };
    }

    // Handle Cognito errors
    if (data.__type?.includes('NotAuthorizedException')) {
      return { success: false, error: 'Invalid email or password' };
    }
    if (data.__type?.includes('UserNotFoundException')) {
      return { success: false, error: 'User not found' };
    }
    if (data.__type?.includes('UserNotConfirmedException')) {
      return { success: false, error: 'Account not confirmed' };
    }

    return { success: false, error: data.message || 'Authentication failed' };
  } catch (err) {
    console.error('Login error:', err);
    return { success: false, error: 'Network error — check your connection' };
  }
}

export function getStoredTokens(): AuthTokens | null {
  if (typeof window === 'undefined') return null;
  const stored = localStorage.getItem(TOKEN_KEY);
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
  localStorage.removeItem(TOKEN_KEY);
}

export function logout(): void {
  clearTokens();
  window.location.href = '/login';
}
