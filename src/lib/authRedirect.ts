const AUTH_REDIRECT_KEY = "dm-auth-redirect";
const INVITATION_REDIRECT_PATTERN = /^\/invite#[A-Za-z0-9_-]{43}$/;

export function setAuthRedirect(path: string) {
  if (typeof window !== "undefined" && INVITATION_REDIRECT_PATTERN.test(path)) {
    window.sessionStorage.setItem(AUTH_REDIRECT_KEY, path);
  }
}

export function getAuthRedirect() {
  if (typeof window === "undefined") return null;
  const path = window.sessionStorage.getItem(AUTH_REDIRECT_KEY);
  return path && INVITATION_REDIRECT_PATTERN.test(path) ? path : null;
}

export function clearAuthRedirect(path: string) {
  if (typeof window !== "undefined" && getAuthRedirect() === path) {
    window.sessionStorage.removeItem(AUTH_REDIRECT_KEY);
  }
}
