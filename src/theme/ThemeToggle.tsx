import { useEffect, useState } from "react";
import { applyTheme, readTheme, type ColorTheme } from "./theme";

const THEMES: ColorTheme[] = ["light", "dark"];
const THEME_NAMES: Record<ColorTheme, string> = { light: "MXTP Light", dark: "Y2K Dark" };

export function ThemeToggle({ className = "", helpTarget }: { className?: string; helpTarget?: string }) {
  const [theme, setTheme] = useState<ColorTheme>(readTheme);

  // Several toggles can be mounted at once (the library stays mounted behind
  // the studio), so each one follows <html data-theme> instead of its own click.
  useEffect(() => {
    applyTheme(readTheme());
    const root = document.documentElement;
    const sync = () => setTheme(readTheme());
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    sync();
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className={`theme-toggle ${className}`.trim()}
      role="group"
      aria-label="Color theme"
      data-theme-value={theme}
      data-help-target={helpTarget}
    >
      <span>Mode</span>
      {THEMES.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={theme === option}
          title={`Use ${option} mode`}
          onClick={() => {
            applyTheme(option);
            setTheme(option);
          }}
        >
          {THEME_NAMES[option]}
        </button>
      ))}
    </div>
  );
}
