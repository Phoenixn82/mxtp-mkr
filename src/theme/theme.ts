export type ColorTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "mxtp:color-theme:v1";

export function readTheme(): ColorTheme {
  const current = typeof document === "undefined" ? undefined : document.documentElement.dataset.theme;
  if (current === "light" || current === "dark") return current;
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Storage can be unavailable in hardened WebViews; system preference still works.
  }
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: ColorTheme): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The theme remains applied for this session even when persistence is blocked.
  }
}

export function initializeTheme(): ColorTheme {
  const theme = readTheme();
  applyTheme(theme);
  return theme;
}
