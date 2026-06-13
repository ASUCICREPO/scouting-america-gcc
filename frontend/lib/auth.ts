import { COGNITO_CONFIG } from "./config";

interface AuthTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
}

interface AuthUser {
  email: string;
  sub: string;
}

const TOKEN_KEY = "scout_auth_tokens";

export function getStoredTokens(): AuthTokens | null {
  if (typeof window === "undefined") return null;
  const stored = localStorage.getItem(TOKEN_KEY);
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

export function storeTokens(tokens: AuthTokens): void {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
}

export function clearTokens(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function isAuthenticated(): boolean {
  const tokens = getStoredTokens();
  if (!tokens) return false;
  // Basic JWT expiry check
  try {
    const payload = JSON.parse(atob(tokens.idToken.split(".")[1]));
    return payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

export function getUser(): AuthUser | null {
  const tokens = getStoredTokens();
  if (!tokens) return null;
  try {
    const payload = JSON.parse(atob(tokens.idToken.split(".")[1]));
    return {
      email: payload.email,
      sub: payload.sub,
    };
  } catch {
    return null;
  }
}

export function getLoginUrl(): string {
  // Cognito Hosted UI URL — uses custom domain prefix
  const domain = `https://gcc-volunteer-app.auth.${COGNITO_CONFIG.region}.amazoncognito.com`;
  const redirectUri = typeof window !== "undefined" ? window.location.origin + "/auth/callback" : "";
  return `${domain}/login?client_id=${COGNITO_CONFIG.clientId}&response_type=code&scope=openid+email+profile&redirect_uri=${encodeURIComponent(redirectUri)}`;
}

export async function exchangeCode(code: string): Promise<AuthTokens> {
  const domain = `https://gcc-volunteer-app.auth.${COGNITO_CONFIG.region}.amazoncognito.com`;
  const redirectUri = window.location.origin + "/auth/callback";

  const response = await fetch(`${domain}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: COGNITO_CONFIG.clientId,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    throw new Error("Token exchange failed");
  }

  const data = await response.json();
  const tokens: AuthTokens = {
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
  };
  storeTokens(tokens);
  return tokens;
}

export function logout(): void {
  clearTokens();
  window.location.href = "/";
}
