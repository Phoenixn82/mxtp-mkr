import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DeleteProjectDialog } from "./DeleteProjectDialog";

function Harness({ onConfirm = vi.fn() }: { onConfirm?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Delete project</button>
      <DeleteProjectDialog projectName="Road Mix" open={open} busy={false} onCancel={() => setOpen(false)} onConfirm={onConfirm} />
    </>
  );
}

describe("DeleteProjectDialog", () => {
  it("focuses Keep project on open and returns focus to the opener when it closes", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Delete project" });

    await user.click(opener);
    expect(screen.getByRole("alertdialog", { name: "Delete Road Mix?" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Keep project" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Keep project" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(opener).toHaveFocus();

    await user.click(opener);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(opener).toHaveFocus();
  });
});
