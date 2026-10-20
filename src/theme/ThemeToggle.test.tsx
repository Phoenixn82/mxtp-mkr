import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeToggle } from "./ThemeToggle";
import { THEME_STORAGE_KEY } from "./theme";

describe("ThemeToggle", () => {
  afterEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    delete document.documentElement.dataset.theme;
    document.documentElement.style.colorScheme = "";
  });

  it("applies and persists both color themes under their product names", async () => {
    document.documentElement.dataset.theme = "light";
    const user = userEvent.setup();
    render(<ThemeToggle />);

    const dark = screen.getByRole("button", { name: "Y2K Dark" });
    expect(dark).toHaveAttribute("title", "Use dark mode");
    expect(screen.getByRole("button", { name: "MXTP Light" })).toHaveAttribute("title", "Use light mode");
    expect(dark).toHaveAttribute("aria-pressed", "false");
    await user.click(dark);
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(dark).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "MXTP Light" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("keeps every mounted toggle in sync with the page theme", async () => {
    document.documentElement.dataset.theme = "light";
    const user = userEvent.setup();
    const { unmount } = render(<><ThemeToggle className="one" /><ThemeToggle className="two" /></>);
    const [first, second] = screen.getAllByRole("group", { name: "Color theme" });

    await user.click(within(first).getByRole("button", { name: "Y2K Dark" }));
    await waitFor(() => expect(within(second).getByRole("button", { name: "Y2K Dark" })).toHaveAttribute("aria-pressed", "true"));
    expect(within(second).getByRole("button", { name: "MXTP Light" })).toHaveAttribute("aria-pressed", "false");
    expect(second).toHaveAttribute("data-theme-value", "dark");

    document.documentElement.dataset.theme = "light";
    await waitFor(() => expect(within(first).getByRole("button", { name: "MXTP Light" })).toHaveAttribute("aria-pressed", "true"));
    unmount();
  });
});
