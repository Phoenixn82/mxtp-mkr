import { useEffect, useRef } from "react";

interface DeleteProjectDialogProps {
  projectName: string;
  open: boolean;
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteProjectDialog({
  projectName,
  open,
  busy,
  error,
  onCancel,
  onConfirm
}: DeleteProjectDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus moves into the dialog on open and back to whatever opened it on close.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onCancel, open]);

  if (!open) return null;

  return (
    <div className="project-delete-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <section
        className="project-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="project-delete-title"
        aria-describedby="project-delete-description"
      >
        <header>
          <span>Permanent action</span>
          <h2 id="project-delete-title">Delete {projectName || "this project"}?</h2>
        </header>
        <p id="project-delete-description">
          This removes the saved project, burn order, cover, and booklet setup. Downloaded audio stays in your library.
        </p>
        <strong>This cannot be undone.</strong>
        {error ? <p className="project-delete-error" role="alert">{error}</p> : null}
        <div className="project-delete-actions">
          <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel}>Keep project</button>
          <button className="danger" type="button" disabled={busy} onClick={onConfirm}>
            {busy ? "Deleting…" : "Delete forever"}
          </button>
        </div>
      </section>
    </div>
  );
}
