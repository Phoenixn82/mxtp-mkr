import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HelpCoach, type CoachStep } from "./HelpCoach";

const first: CoachStep = {
  id: "first",
  title: "First stop",
  text: "Choose the highlighted control.",
  target: '[data-help-target="first"]'
};

const second: CoachStep = {
  id: "second",
  title: "Second stop",
  text: "Now use the next control.",
  target: '[data-help-target="second"]'
};

describe("HelpCoach", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false })
    });
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0)
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      value: (frame: number) => window.clearTimeout(frame)
    });
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn()
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.removeAttribute("data-theme");
  });

  it("spotlights and scrolls a selector target into view", async () => {
    const target = document.createElement("button");
    target.dataset.helpTarget = "first";
    target.getBoundingClientRect = () => ({ x: 40, y: 80, top: 80, left: 40, right: 240, bottom: 120, width: 200, height: 40, toJSON: () => ({}) });
    document.body.append(target);

    render(<HelpCoach open steps={[first]} typingMs={0} onClose={vi.fn()} />);
    await act(async () => { vi.runOnlyPendingTimers(); });

    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "center", behavior: "smooth" });
    expect(document.querySelector(".mxtp-coach")).toHaveAttribute("data-target-found", "true");
    expect(document.querySelector(".mxtp-coach-spotlight")).toHaveStyle({ top: "72px", left: "32px", width: "216px", height: "56px" });
    target.remove();
  });

  it("reveals the typewriter text, advances, then completes with click and keyboard", () => {
    const onClose = vi.fn();
    render(<HelpCoach open steps={[first, second]} typingMs={100} onClose={onClose} />);

    const dialog = screen.getByRole("dialog");
    expect(document.querySelector(".mxtp-coach-copy")).not.toHaveTextContent(first.text);
    fireEvent.click(dialog);
    expect(document.querySelector(".mxtp-coach-copy")).toHaveTextContent(first.text);
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(screen.getByRole("heading", { name: "Second stop" })).toBeVisible();
    fireEvent.keyDown(dialog, { key: " " });
    expect(document.querySelector(".mxtp-coach-copy")).toHaveTextContent(second.text);
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(onClose).toHaveBeenCalledWith("complete");
  });

  it("closes on Escape and restores the previously focused element", async () => {
    vi.useRealTimers();
    const onClose = vi.fn();
    const before = document.createElement("button");
    document.body.append(before);
    before.focus();
    const { rerender } = render(<HelpCoach open steps={[first]} typingMs={0} onClose={onClose} />);

    expect(await screen.findByRole("dialog")).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith("dismiss");
    rerender(<HelpCoach open={false} steps={[first]} typingMs={0} onClose={onClose} />);
    expect(before).toHaveFocus();
    before.remove();
  });

  it("accepts a direct element and cleans up when the target changes", async () => {
    const firstTarget = document.createElement("button");
    const secondTarget = document.createElement("button");
    document.body.append(firstTarget, secondTarget);
    const firstScroll = vi.fn();
    const secondScroll = vi.fn();
    Object.defineProperty(firstTarget, "scrollIntoView", { configurable: true, value: firstScroll });
    Object.defineProperty(secondTarget, "scrollIntoView", { configurable: true, value: secondScroll });
    const { rerender } = render(<HelpCoach open steps={[{ ...first, target: firstTarget }]} typingMs={0} onClose={vi.fn()} />);
    await act(async () => { vi.runOnlyPendingTimers(); });

    rerender(<HelpCoach open steps={[{ ...first, id: "changed", target: secondTarget }]} typingMs={0} onClose={vi.fn()} />);
    await act(async () => { vi.runOnlyPendingTimers(); });

    expect(firstScroll).toHaveBeenCalledTimes(1);
    expect(secondScroll).toHaveBeenCalledTimes(1);
    firstTarget.remove();
    secondTarget.remove();
  });

  it("uses an instant scroll when the person prefers reduced motion", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true })
    });
    const target = document.createElement("button");
    target.dataset.helpTarget = "first";
    document.body.append(target);

    render(<HelpCoach open steps={[first]} typingMs={100} onClose={vi.fn()} />);
    await act(async () => { vi.runOnlyPendingTimers(); });

    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "center", behavior: "auto" });
    expect(document.querySelector(".mxtp-coach-copy")).toHaveTextContent(first.text);
    target.remove();
  });

  it("traps Tab and Shift+Tab inside the coach", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    render(<HelpCoach open steps={[first, second]} typingMs={0} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    const close = screen.getByRole("button", { name: "Close guide" });

    close.focus();
    expect(fireEvent.keyDown(close, { key: "Tab" })).toBe(false);
    expect(close).toHaveFocus();

    dialog.focus();
    expect(fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true })).toBe(false);
    expect(close).toHaveFocus();

    outside.focus();
    fireEvent.keyDown(outside, { key: "Tab" });
    expect(close).toHaveFocus();
    outside.remove();
  });

  it("closes on Escape even when focus is outside the coach", () => {
    const onClose = vi.fn();
    const outside = document.createElement("input");
    document.body.append(outside);
    render(<HelpCoach open steps={[first]} typingMs={0} onClose={onClose} />);
    outside.focus();
    fireEvent.keyDown(outside, { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith("dismiss");
    outside.remove();
  });

  it("advances only on clicks inside the dialog", () => {
    const onClose = vi.fn();
    render(<HelpCoach open steps={[first, second]} typingMs={0} onClose={onClose} />);
    fireEvent.click(document.querySelector(".mxtp-coach")!, { clientX: 5, clientY: 5 });
    expect(screen.getByRole("heading", { name: "First stop" })).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("heading", { name: "First stop" }));
    expect(screen.getByRole("heading", { name: "Second stop" })).toBeVisible();
  });

  it("lets a click on the spotlight close the coach and reach the control", async () => {
    const onClose = vi.fn();
    const onTargetClick = vi.fn();
    const target = document.createElement("button");
    target.dataset.helpTarget = "first";
    target.addEventListener("click", onTargetClick);
    target.getBoundingClientRect = () => ({ x: 40, y: 80, top: 80, left: 40, right: 240, bottom: 120, width: 200, height: 40, toJSON: () => ({}) });
    document.body.append(target);
    const elementFromPoint = vi.fn(() => target);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: elementFromPoint });

    render(<HelpCoach open steps={[first, second]} typingMs={0} onClose={onClose} />);
    await act(async () => { vi.runOnlyPendingTimers(); });
    fireEvent.click(document.querySelector(".mxtp-coach")!, { clientX: 100, clientY: 100 });

    expect(elementFromPoint).toHaveBeenCalledWith(100, 100);
    expect(onClose).toHaveBeenCalledWith("dismiss");
    expect(onTargetClick).toHaveBeenCalledTimes(1);
    expect(target).toHaveFocus();
    Reflect.deleteProperty(document, "elementFromPoint");
    target.remove();
  });

  it("supports an explicit close button without advancing", async () => {
    vi.useRealTimers();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<HelpCoach open steps={[first, second]} typingMs={0} onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Close guide" }));
    expect(onClose).toHaveBeenCalledWith("dismiss");
    expect(screen.getByRole("heading", { name: "First stop" })).toBeVisible();
  });
});
