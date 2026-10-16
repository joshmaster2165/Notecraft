// Password Protect This Section: the unlock screen shown in place of a locked
// section's pages, and the dialogs to protect a section, change its password
// or remove it.
import { useState, type FormEvent, type ReactNode } from "react";
import type { Section } from "../model/types.ts";
import * as ops from "../model/ops.ts";
import { store, useStore } from "../store/store.ts";
import { changePassword, lockSection, lockState, protectSection, removePassword, unlockSection, useLockVersion } from "../store/locks.ts";
import { selectSection } from "../store/actions.ts";
import { Icon } from "./icons.tsx";
import { Modal } from "./Modal.tsx";

const close = () => store.setUi({ dialog: null });
const message = (e: unknown) => (e as Error)?.message ?? String(e);

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="prompt-field">
      {label}
      {children}
    </label>
  );
}

/** Shown in the workspace while the current section is locked. */
export function LockedSection({ section }: { section: Section }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await unlockSection(section.id, password);
      selectSection(section.id);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };
  return (
    <div className="locked-section">
      <form className="locked-card" onSubmit={(e) => void submit(e)}>
        <span className="locked-icon"><Icon.lock width={28} height={28} /></span>
        <h2>“{section.name}” is password protected</h2>
        <p className="dialog-note">Enter the password to see and edit its pages.</p>
        {section.locked?.hint && <p className="lock-hint">Hint: {section.locked.hint}</p>}
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          aria-label="Password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={!!error}
        />
        {error && <p className="lock-error" role="alert">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={!password || busy}>{busy ? "Unlocking…" : "Unlock"}</button>
      </form>
    </div>
  );
}

/** Section menu entries for protection. */
export function SectionLockItems({ section, onClose }: { section: Section; onClose: () => void }) {
  useLockVersion();
  const state = lockState(section);
  const open = (kind: "protectSection" | "changePassword" | "removePassword") => (store.setUi({ dialog: { kind, sectionId: section.id } }), onClose());
  if (state === "none") return <button role="menuitem" onClick={() => open("protectSection")}><Icon.lock width={15} height={15} /> Password protect…</button>;
  if (state === "locked") return <button role="menuitem" onClick={() => (selectSection(section.id), onClose())}><Icon.unlock width={15} height={15} /> Unlock…</button>;
  return (
    <>
      <button role="menuitem" onClick={() => (void lockSection(section.id), onClose())}><Icon.lock width={15} height={15} /> Lock now</button>
      <button role="menuitem" onClick={() => open("changePassword")}>Change password…</button>
      <button role="menuitem" onClick={() => open("removePassword")}>Remove password…</button>
    </>
  );
}

function useSection(sectionId: string) {
  return useStore((s) => ops.findSection(s.lib, sectionId)?.section);
}

function PasswordDialog({ title, action, busyLabel, children, canSubmit, onSubmit }: { title: string; action: string; busyLabel: string; children: ReactNode; canSubmit: boolean; onSubmit: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
      close();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={close}
      footer={
        <>
          {error && <span className="lock-error" role="alert">{error}</span>}
          <span className="tb-spacer" />
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn btn-primary" disabled={!canSubmit || busy} onClick={() => void submit()}>{busy ? busyLabel : action}</button>
        </>
      }
    >
      <form className="lock-form" onSubmit={(e) => (e.preventDefault(), void submit())}>
        {children}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

const NO_RECOVERY = "If you forget the password, nobody can unlock the section, not even Notecraft. Locked sections are encrypted with AES-256.";

export function ProtectSectionDialog({ sectionId }: { sectionId: string }) {
  const section = useSection(sectionId);
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [hint, setHint] = useState("");
  if (!section) return null;
  const mismatch = !!confirm && pw !== confirm;
  return (
    <PasswordDialog
      title={`Password protect “${section.name}”`}
      action="Protect"
      busyLabel="Encrypting…"
      canSubmit={!!pw && pw === confirm}
      onSubmit={async () => {
        await protectSection(sectionId, pw, hint);
        store.toast(`“${section.name}” is password protected. It locks after 10 minutes away, or choose Lock now.`);
      }}
    >
      <Field label="Password"><input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
      <Field label="Confirm password"><input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={mismatch} /></Field>
      {mismatch && <p className="lock-error">The passwords don't match.</p>}
      <Field label="Hint (optional, shown on the lock screen)"><input value={hint} onChange={(e) => setHint(e.target.value)} /></Field>
      <p className="dialog-note">{NO_RECOVERY} Protected pages keep no version history, and pages deleted from the section skip Deleted Notes (its pages already there are deleted for good).</p>
    </PasswordDialog>
  );
}

export function ChangePasswordDialog({ sectionId }: { sectionId: string }) {
  const section = useSection(sectionId);
  const [old, setOld] = useState("");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [hint, setHint] = useState(section?.locked?.hint ?? "");
  if (!section) return null;
  const mismatch = !!confirm && pw !== confirm;
  return (
    <PasswordDialog
      title={`Change password for “${section.name}”`}
      action="Change"
      busyLabel="Encrypting…"
      canSubmit={!!old && !!pw && pw === confirm}
      onSubmit={async () => {
        await changePassword(sectionId, old, pw, hint);
        store.toast("Password changed");
      }}
    >
      <Field label="Current password"><input type="password" autoComplete="current-password" value={old} onChange={(e) => setOld(e.target.value)} /></Field>
      <Field label="New password"><input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
      <Field label="Confirm new password"><input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={mismatch} /></Field>
      {mismatch && <p className="lock-error">The passwords don't match.</p>}
      <Field label="Hint (optional)"><input value={hint} onChange={(e) => setHint(e.target.value)} /></Field>
      <p className="dialog-note">{NO_RECOVERY}</p>
    </PasswordDialog>
  );
}

export function RemovePasswordDialog({ sectionId }: { sectionId: string }) {
  const section = useSection(sectionId);
  const [pw, setPw] = useState("");
  if (!section) return null;
  return (
    <PasswordDialog
      title={`Remove password from “${section.name}”`}
      action="Remove password"
      busyLabel="Checking…"
      canSubmit={!!pw}
      onSubmit={async () => {
        await removePassword(sectionId, pw);
        store.toast(`“${section.name}” is no longer password protected`);
      }}
    >
      <Field label="Password"><input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
      <p className="dialog-note">The section's pages will be stored unencrypted again, and anyone with access to this computer's Notecraft library can read them.</p>
    </PasswordDialog>
  );
}
