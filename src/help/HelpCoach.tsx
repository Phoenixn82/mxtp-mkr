import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import "./HelpCoach.css";

export type CoachTarget = string | Element | null | (() => Element | null);

export interface CoachStep {
  id: string;
  title: string;
  text: string;
  target: CoachTarget;
}

export type CoachCloseReason = "complete" | "dismiss";

export interface HelpCoachProps {
  open: boolean;
  steps: readonly CoachStep[];
  onClose: (reason: CoachCloseReason) => void;
  initialStep?: number;
  typingMs?: number;
  onStepChange?: (index: number, step: CoachStep) => void;
}

interface SpotlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const TARGET_PADDING = 8;
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function HelpCoach({
  open,
  steps,
  onClose,
  initialStep = 0,
  typingMs = 24,
  onStepChange
}: HelpCoachProps) {
  const [stepIndex, setStepIndex] = useState(initialStep);
  const [visibleCharacters, setVisibleCharacters] = useState(0);
  const [spotlight, setSpotlight] = useState<SpotlightRect>();
  const dialogRef = useRef<HTMLElement>(null);
  const priorFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const stepSignature = useMemo(() => steps.map((step) => step.id).join("\u0000"), [steps]);
  const step = steps[stepIndex];

  useEffect(() => {
    if (!open) return;
    setStepIndex(clamp(initialStep, 0, Math.max(0, steps.length - 1)));
  }, [initialStep, open, stepSignature, steps.length]);

  useEffect(() => {
    if (!open || !step) return;
    onStepChange?.(stepIndex, step);
  }, [onStepChange, open, step, stepIndex]);

  useEffect(() => {
    if (!open) return;
    priorFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestFrame(() => dialogRef.current?.focus());
    return () => {
      cancelFrame(frame);
      priorFocusRef.current?.focus();
      priorFocusRef.current = null;
    };
  }, [open]);

  // Escape and Tab are caught on window, so they work even when focus has
  // wandered outside the coach; Tab cycles through the coach's own controls.
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current("dismiss");
        return;
      }
      if (event.key !== "Tab") return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = controls[0] ?? dialog;
      const last = controls[controls.length - 1] ?? dialog;
      const active = document.activeElement;
      const inside = active instanceof Node && dialog.contains(active);
      const wrap = event.shiftKey
        ? !inside || active === first || active === dialog
        : !inside || active === last;
      if (!wrap) return;
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [open]);

  useEffect(() => {
    if (!open || !step) return;
    if (typingMs <= 0 || prefersReducedMotion()) {
      setVisibleCharacters(step.text.length);
      return;
    }

    setVisibleCharacters(0);
    let nextLength = 0;
    const timer = window.setInterval(() => {
      nextLength += 1;
      setVisibleCharacters(Math.min(nextLength, step.text.length));
      if (nextLength >= step.text.length) window.clearInterval(timer);
    }, typingMs);
    return () => window.clearInterval(timer);
  }, [open, step, typingMs]);

  useEffect(() => {
    if (!open || !step) {
      setSpotlight(undefined);
      return;
    }

    let currentTarget: Element | null = null;
    let observer: MutationObserver | undefined;
    let frame = 0;

    const measure = () => {
      if (!currentTarget?.isConnected) {
        setSpotlight(undefined);
        return;
      }
      const rect = currentTarget.getBoundingClientRect();
      setSpotlight({
        top: Math.max(4, rect.top - TARGET_PADDING),
        left: Math.max(4, rect.left - TARGET_PADDING),
        width: Math.max(0, Math.min(window.innerWidth - 8, rect.width + TARGET_PADDING * 2)),
        height: Math.max(0, Math.min(window.innerHeight - 8, rect.height + TARGET_PADDING * 2))
      });
    };

    const connectTarget = () => {
      const found = resolveTarget(step.target);
      if (!found || found === currentTarget) return Boolean(found);
      currentTarget = found;
      currentTarget.scrollIntoView?.({ block: "center", inline: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      measure();
      cancelFrame(frame);
      frame = requestFrame(measure);
      return true;
    };

    if (!connectTarget()) {
      observer = new MutationObserver(() => {
        if (connectTarget()) observer?.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      observer?.disconnect();
      cancelFrame(frame);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, step]);

  const advanceOrReveal = useCallback(() => {
    if (!step) return;
    if (visibleCharacters < step.text.length) {
      setVisibleCharacters(step.text.length);
      return;
    }
    if (stepIndex < steps.length - 1) {
      setStepIndex((index) => index + 1);
    } else {
      onClose("complete");
    }
  }, [onClose, step, stepIndex, steps.length, visibleCharacters]);

  // A click on the spotlit control closes the coach and reaches the control,
  // so the guide never stands between the person and what it points at.
  const passThroughSpotlight = (event: MouseEvent<HTMLDivElement>) => {
    if (dialogRef.current?.contains(event.target as Node)) return;
    if (!spotlight || !insideRect(spotlight, event.clientX, event.clientY)) return;
    const overlay = event.currentTarget;
    overlay.style.pointerEvents = "none";
    const underneath = typeof document.elementFromPoint === "function" ? document.elementFromPoint(event.clientX, event.clientY) : null;
    overlay.style.pointerEvents = "";
    const hit = underneath ?? (step ? resolveTarget(step.target) : null);
    priorFocusRef.current = null;
    onClose("dismiss");
    if (!(hit instanceof HTMLElement)) return;
    const control = hit.closest<HTMLElement>(FOCUSABLE) ?? hit;
    control.focus();
    hit.click();
  };

  if (!open || !step || typeof document === "undefined") return null;

  const fullyRevealed = visibleCharacters >= step.text.length;
  const dialogStyle = positionDialog(spotlight);
  const spotlightStyle = spotlight ? {
    top: spotlight.top,
    left: spotlight.left,
    width: spotlight.width,
    height: spotlight.height
  } : undefined;

  return createPortal(
    <div
      className="mxtp-coach"
      data-target-found={spotlight ? "true" : "false"}
      onClick={passThroughSpotlight}
    >
      <div className="mxtp-coach-spotlight" style={spotlightStyle} aria-hidden="true" />
      <section
        ref={dialogRef}
        className="mxtp-coach-dialog"
        style={dialogStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mxtp-coach-title"
        aria-describedby="mxtp-coach-live"
        tabIndex={-1}
        onClick={advanceOrReveal}
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === " ") && !(event.target as HTMLElement).closest("button")) {
            event.preventDefault();
            advanceOrReveal();
          }
        }}
      >
        <header>
          <span>MXTP GUIDE · {stepIndex + 1}/{steps.length}</span>
          <button
            type="button"
            aria-label="Close guide"
            onClick={(event: MouseEvent<HTMLButtonElement>) => {
              event.stopPropagation();
              onClose("dismiss");
            }}
          >
            ×
          </button>
        </header>
        <h2 id="mxtp-coach-title">{step.title}</h2>
        <p className="mxtp-coach-copy" aria-hidden="true">
          {step.text.slice(0, visibleCharacters)}
          {!fullyRevealed ? <span className="mxtp-coach-cursor">▮</span> : null}
        </p>
        <p id="mxtp-coach-live" className="mxtp-coach-sr" role="status" aria-live="polite">{step.text}</p>
        <footer>
          {fullyRevealed
            ? stepIndex < steps.length - 1 ? "Click or press Enter / Space for next" : "Click or press Enter / Space to close"
            : "Click or press Enter / Space to show all"}
          <span aria-hidden="true">▼</span>
        </footer>
      </section>
    </div>,
    document.body
  );
}

function resolveTarget(target: CoachTarget): Element | null {
  if (typeof target === "function") return target();
  if (typeof target === "string") {
    try {
      return document.querySelector(target);
    } catch {
      return null;
    }
  }
  return typeof Element !== "undefined" && target instanceof Element ? target : null;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function insideRect(rect: SpotlightRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height;
}

function positionDialog(spotlight?: SpotlightRect): CSSProperties {
  const width = Math.min(430, Math.max(260, window.innerWidth - 24));
  if (!spotlight) {
    return { left: "50%", bottom: 20, width, transform: "translateX(-50%)" };
  }

  const left = clamp(spotlight.left + spotlight.width / 2 - width / 2, 12, Math.max(12, window.innerWidth - width - 12));
  const spaceBelow = window.innerHeight - spotlight.top - spotlight.height;
  if (spaceBelow >= 230 || spotlight.top < 230) {
    return { left, top: Math.min(window.innerHeight - 200, spotlight.top + spotlight.height + 16), width };
  }
  return { left, bottom: Math.min(window.innerHeight - 200, window.innerHeight - spotlight.top + 16), width };
}

function requestFrame(callback: FrameRequestCallback): number {
  if (typeof window.requestAnimationFrame === "function") return window.requestAnimationFrame(callback);
  return window.setTimeout(() => callback(performance.now()), 0);
}

function cancelFrame(frame: number): void {
  if (!frame) return;
  if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(frame);
  else window.clearTimeout(frame);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
