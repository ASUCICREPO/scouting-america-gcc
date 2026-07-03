// Test admin credentials — replace with Cognito auth when backend is ready
const TEST_ADMIN = {
  email: 'admin@gcc.org',
  password: 'admin123',
  name: 'GCC Admin',
};

const AUTH_KEY = 'gcc_admin_auth';

export interface AdminUser {
  email: string;
  name: string;
  isAuthenticated: boolean;
}

export function login(email: string, password: string): boolean {
  if (email === TEST_ADMIN.email && password === TEST_ADMIN.password) {
    const user: AdminUser = {
      email: TEST_ADMIN.email,
      name: TEST_ADMIN.name,
      isAuthenticated: true,
    };
    localStorage.setItem(AUTH_KEY, JSON.stringify(user));
    return true;
  }
  return false;
}

export function getUser(): AdminUser | null {
  if (typeof window === 'undefined') return null;
  const stored = localStorage.getItem(AUTH_KEY);
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

export function isAuthenticated(): boolean {
  const user = getUser();
  return user?.isAuthenticated === true;
}

export function logout(): void {
  localStorage.removeItem(AUTH_KEY);
  window.location.href = '/';
}
