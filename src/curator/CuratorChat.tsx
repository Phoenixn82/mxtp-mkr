import { useEffect, useRef, useState } from "react";
import type { CuratorMessage, CuratorMemory } from "../project/catalog";

interface CuratorChatProps {
  projectName?: string;
  messages: CuratorMessage[];
  memory: CuratorMemory;
  busy: boolean;
  onSend: (prompt: string) => void;
  onMemoryChange: (memory: CuratorMemory) => void;
  pendingProposalId?: string;
  onAcceptProposal?: (proposalId: string) => void;
  onDeclineProposal?: (proposalId: string) => void;
}

interface MemoryDrafts {
  dislikedArtists: string;
  preferredGenres: string;
  notes: string;
}

/** How long typing must pause before the memory drafts are saved. */
export const MEMORY_SAVE_DELAY_MS = 600;

export function CuratorChat({ projectName, messages, memory, busy, onSend, onMemoryChange, pendingProposalId, onAcceptProposal, onDeclineProposal }: CuratorChatProps) {
  const [draft, setDraft] = useState("");
  const [memoryDrafts, setMemoryDrafts] = useState<MemoryDrafts>();
  const memoryRef = useRef(memory);
  const draftsRef = useRef(memoryDrafts);
  // The memory each draft field last started from. A field whose draft still
  // equals its base is untouched by the person, so the prop owns it.
  const baseRef = useRef<MemoryDrafts>();
  const onMemoryChangeRef = useRef(onMemoryChange);
  memoryRef.current = memory;
  draftsRef.current = memoryDrafts;
  onMemoryChangeRef.current = onMemoryChange;
  const editingMemory = memoryDrafts !== undefined;

  // The textareas edit plain strings; the list split runs only when a draft is
  // committed (blur, Done, closing the editor, or a pause in typing), so spaces
  // and new lines survive while the person is still typing. Only fields the
  // person changed are written; everything else, including what the curator
  // learned while the editor was open, comes from the current memory.
  function commitMemory() {
    const drafts = draftsRef.current;
    const base = baseRef.current;
    if (!drafts || !base) return;
    const current = memoryRef.current;
    const next = { ...current };
    if (drafts.dislikedArtists !== base.dislikedArtists) next.dislikedArtists = lines(drafts.dislikedArtists);
    if (drafts.preferredGenres !== base.preferredGenres) next.preferredGenres = lines(drafts.preferredGenres);
    if (drafts.notes !== base.notes) next.notes = drafts.notes;
    // The base stays put: until the save echoes back, the memory prop is stale,
    // so every commit resends every field the person changed.
    if (sameMemory(next, current)) return;
    memoryRef.current = next;
    onMemoryChangeRef.current(next);
  }

  // Memory can change under an open editor (the curator learns "avoid X" or a
  // genre from a prompt). Show it in every field the person has not touched.
  useEffect(() => {
    const drafts = draftsRef.current;
    const base = baseRef.current;
    if (!drafts || !base) return;
    const fresh = toDrafts(memory);
    const next = { ...drafts };
    const nextBase = { ...base };
    let changed = false;
    for (const field of MEMORY_FIELDS) {
      if (drafts[field] !== base[field] || draftMatches(field, drafts[field], memory)) continue;
      next[field] = fresh[field];
      nextBase[field] = fresh[field];
      changed = true;
    }
    if (!changed) return;
    baseRef.current = nextBase;
    draftsRef.current = next;
    setMemoryDrafts(next);
  }, [memory]);

  useEffect(() => {
    if (!memoryDrafts) return;
    const timer = window.setTimeout(commitMemory, MEMORY_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [memoryDrafts]);

  // Keep anything still unsaved when the chat goes away mid-edit.
  useEffect(() => commitMemory, []);

  function toggleMemoryEditor() {
    if (editingMemory) {
      commitMemory();
      baseRef.current = undefined;
      setMemoryDrafts(undefined);
      return;
    }
    const drafts = toDrafts(memory);
    baseRef.current = drafts;
    setMemoryDrafts(drafts);
  }

  function editDraft(field: keyof MemoryDrafts, value: string) {
    setMemoryDrafts((current) => current && { ...current, [field]: value });
  }

  function submit() {
    const prompt = draft.trim();
    if (!prompt || busy) return;
    setDraft("");
    onSend(prompt);
  }

  return (
    <section className="curator-panel" aria-labelledby="curator-heading" data-testid="curator-chat">
      <header className="curator-head">
        <div>
          <span>{projectName ? "Curator · editing this project" : "Curator · new custom CD"}</span>
          <h1 id="curator-heading">{projectName ? projectName : "New custom CD"}</h1>
        </div>
        <button type="button" onClick={toggleMemoryEditor} aria-expanded={editingMemory}>Edit memory</button>
      </header>
      <p className="curator-privacy" role="note" data-testid="curator-context">
        Runs on this PC. Nothing you type and none of your listening history leaves MXTP.
      </p>
      {memoryDrafts ? (
        <div className="curator-memory" data-testid="curator-memory">
          <label>Artists to avoid<textarea value={memoryDrafts.dislikedArtists} onChange={(event) => editDraft("dislikedArtists", event.target.value)} onBlur={commitMemory} placeholder="One artist per line" /></label>
          <label>Preferred genres<textarea value={memoryDrafts.preferredGenres} onChange={(event) => editDraft("preferredGenres", event.target.value)} onBlur={commitMemory} placeholder="One genre per line" /></label>
          <label>Notes<textarea value={memoryDrafts.notes} onChange={(event) => editDraft("notes", event.target.value)} onBlur={commitMemory} placeholder="Anything the curator should remember for this project" /></label>
          <button type="button" onClick={toggleMemoryEditor}>Done</button>
        </div>
      ) : null}
      <div className="curator-transcript" aria-live="polite">
        {messages.length === 0 ? (
          <div className="curator-starters">
            <button type="button" onClick={() => onSend("Make a mixtape of my favorite stuff from 2026")}>My favorites from 2026</button>
            <button type="button" onClick={() => onSend("Give me the ultimate heavy metal mixtape")}>Ultimate heavy metal</button>
            <button type="button" onClick={() => onSend("How do I download a full album?")}>How do I download a full album?</button>
          </div>
        ) : messages.map((message) => {
          const proposal = message.proposal;
          return (
            <article key={message.id} className={`curator-message ${message.role}`}>
              <strong>{message.role === "user" ? "You" : "MXTP"}</strong>
              <p>{message.content}</p>
              {message.choices?.length ? (
                <ol className="curator-choices">
                  {message.choices.map((choice) => <li key={choice.trackId}><span>{choice.title} — {choice.artist}</span><small>{choice.explanation}</small></li>)}
                </ol>
              ) : null}
              {proposal && pendingProposalId !== undefined && proposal.id === pendingProposalId ? (
                <div className="curator-proposal-actions" aria-label="Recommendation decision">
                  <strong>Add these {proposal.trackCount} tracks to the burn list? Nothing downloads yet.</strong>
                  <button type="button" className="primary" disabled={busy} onClick={() => onAcceptProposal?.(proposal.id)}>Add to burn list</button>
                  <button type="button" disabled={busy} onClick={() => onDeclineProposal?.(proposal.id)}>No thanks</button>
                </div>
              ) : null}
              {message.citations?.length ? <details><summary>Sources and evidence</summary><ul>{message.citations.map((citation, index) => <li key={`${citation}-${index}`}>{citation}</li>)}</ul></details> : null}
            </article>
          );
        })}
        {busy ? <div className="curator-loading" role="status"><i />Ranking your library and preparing the project…</div> : null}
      </div>
      <div className="curator-composer">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter that confirms an IME candidate (CJK, dictation) is not a send.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
          }}
          placeholder="Ask how to use MXTP or request a mix…"
          aria-label="Ask the MXTP curator"
          data-help-target="curator-prompt"
          readOnly={busy}
          aria-busy={busy}
        />
        <button type="button" className="primary" onClick={submit} disabled={busy || !draft.trim()}>{busy ? "Working…" : "Send"}</button>
      </div>
    </section>
  );
}

const MEMORY_FIELDS = ["dislikedArtists", "preferredGenres", "notes"] as const;

function toDrafts(memory: CuratorMemory): MemoryDrafts {
  return { dislikedArtists: memory.dislikedArtists.join("\n"), preferredGenres: memory.preferredGenres.join("\n"), notes: memory.notes };
}

/** True when committing this draft would store exactly what memory already holds. */
function draftMatches(field: keyof MemoryDrafts, draft: string, memory: CuratorMemory): boolean {
  return field === "notes" ? draft === memory.notes : sameList(lines(draft), memory[field]);
}

function sameMemory(left: CuratorMemory, right: CuratorMemory): boolean {
  return sameList(left.dislikedArtists, right.dislikedArtists) && sameList(left.preferredGenres, right.preferredGenres) && left.notes === right.notes;
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
