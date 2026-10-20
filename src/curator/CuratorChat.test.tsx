import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CuratorMemory, CuratorMessage } from "../project/catalog";
import { CuratorChat, MEMORY_SAVE_DELAY_MS } from "./CuratorChat";

const memory: CuratorMemory = {
  dislikedArtists: [],
  preferredGenres: [],
  notes: ""
};

const at = "2026-10-19T10:00:00.000Z";
const conversation: CuratorMessage[] = [
  { id: "u1", role: "user", content: "Give me the ultimate heavy metal mixtape", createdAt: at },
  { id: "a1", role: "assistant", content: "Here's a mix with 2 tracks.", createdAt: at, proposal: { id: "proposal-1", trackCount: 2 } },
  { id: "a2", role: "assistant", content: "No problem.", createdAt: at }
];

function renderChat(props: Partial<Parameters<typeof CuratorChat>[0]> = {}) {
  const handlers = { onSend: vi.fn(), onMemoryChange: vi.fn(), onAcceptProposal: vi.fn(), onDeclineProposal: vi.fn() };
  const view = render(<CuratorChat messages={[]} memory={memory} busy={false} {...handlers} {...props} />);
  return { ...handlers, ...view };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CuratorChat context", () => {
  it("makes project-scoped edits explicit", () => {
    renderChat({ projectName: "Psykotic" });

    expect(screen.getByRole("heading", { level: 1, name: "Psykotic" })).toBeVisible();
    expect(screen.getByText("Curator · editing this project")).toBeVisible();
    expect(screen.getByRole("note")).toHaveTextContent("Runs on this PC. Nothing you type and none of your listening history leaves MXTP.");
  });

  it("explains global mode and routes help questions through the same composer API", async () => {
    const user = userEvent.setup();
    const { onSend } = renderChat();

    expect(screen.getByRole("heading", { level: 1, name: "New custom CD" })).toBeVisible();
    expect(screen.getByText("Curator · new custom CD")).toBeVisible();
    expect(screen.queryByText(/Personal mix/i)).toBeNull();

    const composer = screen.getByRole("textbox", { name: "Ask the MXTP curator" });
    expect(composer).toHaveAttribute("data-help-target", "curator-prompt");
    expect(composer).toHaveAttribute("placeholder", "Ask how to use MXTP or request a mix…");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "How do I download a full album?" }));
    expect(onSend).toHaveBeenCalledWith("How do I download a full album?");

    await user.type(composer, "Where is the Projects tab?");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenLastCalledWith("Where is the Projects tab?");
  });
});

describe("CuratorChat proposals", () => {
  it("offers Add to burn list only on the message that carries the pending proposal", async () => {
    const user = userEvent.setup();
    const { onAcceptProposal, onDeclineProposal } = renderChat({ messages: conversation, pendingProposalId: "proposal-1" });

    const decisions = document.querySelectorAll('[aria-label="Recommendation decision"]');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toHaveTextContent("Add these 2 tracks to the burn list? Nothing downloads yet.");
    expect(screen.queryByRole("button", { name: "Download + add" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Add to burn list" }));
    expect(onAcceptProposal).toHaveBeenCalledWith("proposal-1");
    await user.click(screen.getByRole("button", { name: "No thanks" }));
    expect(onDeclineProposal).toHaveBeenCalledWith("proposal-1");
    expect(screen.getByRole("button", { name: "Add to burn list" })).toHaveClass("primary");
  });

  it("renders no decision buttons when nothing is pending", () => {
    renderChat({ messages: conversation });
    expect(document.querySelectorAll('[aria-label="Recommendation decision"]')).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Add to burn list" })).toBeNull();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });
});

describe("CuratorChat memory editor", () => {
  it("keeps a multi-word artist and a second line while typing, then saves both on blur", async () => {
    const user = userEvent.setup();
    const { onMemoryChange } = renderChat();
    await user.click(screen.getByRole("button", { name: "Edit memory" }));

    const avoid = screen.getByRole("textbox", { name: "Artists to avoid" });
    await user.type(avoid, "Pink Floyd{Enter}Yes");
    expect(avoid).toHaveValue("Pink Floyd\nYes");
    expect(onMemoryChange).not.toHaveBeenCalled();

    await user.tab();
    expect(onMemoryChange).toHaveBeenCalledTimes(1);
    expect(onMemoryChange).toHaveBeenCalledWith({ ...memory, dislikedArtists: ["Pink Floyd", "Yes"] });
  });

  it("a second commit before the first save echoes back keeps both edits", async () => {
    const user = userEvent.setup();
    const { onMemoryChange, rerender } = renderChat();
    await user.click(screen.getByRole("button", { name: "Edit memory" }));
    await user.type(screen.getByRole("textbox", { name: "Notes" }), "Road trip");
    await user.click(screen.getByRole("textbox", { name: "Artists to avoid" }));
    await user.type(screen.getByRole("textbox", { name: "Artists to avoid" }), "Yes");
    await user.tab();
    const last = onMemoryChange.mock.calls.at(-1)![0] as CuratorMemory;
    expect(last).toEqual({ ...memory, notes: "Road trip", dislikedArtists: ["Yes"] });
    // The first save's late echo must not wipe either draft.
    rerender(<CuratorChat messages={[]} memory={onMemoryChange.mock.calls[0][0]} busy={false} onSend={vi.fn()} onMemoryChange={onMemoryChange} />);
    expect(screen.getByRole("textbox", { name: "Notes" })).toHaveValue("Road trip");
    expect(screen.getByRole("textbox", { name: "Artists to avoid" })).toHaveValue("Yes");
  });

  it("saves after a pause in typing, and Done closes the editor without saving twice", async () => {
    vi.useFakeTimers();
    const { onMemoryChange, rerender } = renderChat();
    fireEvent.click(screen.getByRole("button", { name: "Edit memory" }));

    fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), { target: { value: "Road trip " } });
    await act(async () => { vi.advanceTimersByTime(MEMORY_SAVE_DELAY_MS - 1); });
    expect(onMemoryChange).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(onMemoryChange).toHaveBeenCalledTimes(1);
    const saved = onMemoryChange.mock.calls[0][0] as CuratorMemory;
    expect(saved.notes).toBe("Road trip ");
    expect(screen.getByRole("textbox", { name: "Notes" })).toHaveValue("Road trip ");

    rerender(<CuratorChat messages={[]} memory={saved} busy={false} onSend={vi.fn()} onMemoryChange={onMemoryChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onMemoryChange).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("curator-memory")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit memory" })).toHaveAttribute("aria-expanded", "false");
  });
});

describe("CuratorChat memory learned while the editor is open", () => {
  const learned: CuratorMemory = { ...memory, preferredGenres: ["heavy metal"], dislikedArtists: ["Nickelback"] };

  it("shows what the curator learned and Done does not erase it", () => {
    const { onMemoryChange, rerender } = renderChat();
    fireEvent.click(screen.getByRole("button", { name: "Edit memory" }));

    rerender(<CuratorChat messages={[]} memory={learned} busy={false} onSend={vi.fn()} onMemoryChange={onMemoryChange} />);
    expect(screen.getByRole("textbox", { name: "Artists to avoid" })).toHaveValue("Nickelback");
    expect(screen.getByRole("textbox", { name: "Preferred genres" })).toHaveValue("heavy metal");

    fireEvent.blur(screen.getByRole("textbox", { name: "Notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onMemoryChange).not.toHaveBeenCalled();
  });

  it("keeps the person's edit in one field and the learned values in the others", () => {
    const { onMemoryChange, rerender } = renderChat();
    fireEvent.click(screen.getByRole("button", { name: "Edit memory" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), { target: { value: "Road trip" } });

    rerender(<CuratorChat messages={[]} memory={learned} busy={false} onSend={vi.fn()} onMemoryChange={onMemoryChange} />);
    expect(screen.getByRole("textbox", { name: "Notes" })).toHaveValue("Road trip");
    expect(screen.getByRole("textbox", { name: "Artists to avoid" })).toHaveValue("Nickelback");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onMemoryChange).toHaveBeenCalledTimes(1);
    expect(onMemoryChange).toHaveBeenCalledWith({ ...learned, notes: "Road trip" });
  });

  it("does not wipe a half-typed new line when the saved memory comes back", async () => {
    vi.useFakeTimers();
    const { onMemoryChange, rerender } = renderChat();
    fireEvent.click(screen.getByRole("button", { name: "Edit memory" }));
    const avoid = screen.getByRole("textbox", { name: "Artists to avoid" });
    fireEvent.change(avoid, { target: { value: "Pink Floyd\n" } });
    await act(async () => { vi.advanceTimersByTime(MEMORY_SAVE_DELAY_MS); });
    const saved = onMemoryChange.mock.calls[0][0] as CuratorMemory;
    expect(saved.dislikedArtists).toEqual(["Pink Floyd"]);

    rerender(<CuratorChat messages={[]} memory={saved} busy={false} onSend={vi.fn()} onMemoryChange={onMemoryChange} />);
    expect(avoid).toHaveValue("Pink Floyd\n");
  });
});

describe("CuratorChat composer", () => {
  it("ignores Enter while an input method is composing", () => {
    const { onSend } = renderChat();
    const composer = screen.getByRole("textbox", { name: "Ask the MXTP curator" });
    fireEvent.change(composer, { target: { value: "日本の曲" } });

    fireEvent.keyDown(composer, { key: "Enter", isComposing: true });
    fireEvent.keyDown(composer, { key: "Enter", keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(composer, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("日本の曲");
  });

  it("keeps focus in the composer while the curator is busy", async () => {
    const user = userEvent.setup();
    const { onSend, rerender } = renderChat();
    const composer = screen.getByRole("textbox", { name: "Ask the MXTP curator" });
    await user.type(composer, "More grunge{Enter}");
    expect(onSend).toHaveBeenCalledWith("More grunge");

    rerender(<CuratorChat messages={[]} memory={memory} busy onSend={onSend} onMemoryChange={vi.fn()} />);
    expect(composer).toHaveFocus();
    expect(composer).not.toBeDisabled();
    expect(composer).toHaveAttribute("readonly");
    expect(composer).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();

    fireEvent.change(composer, { target: { value: "again" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
