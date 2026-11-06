"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { Button } from "./primitives";
import { useAppDispatch, useAppSelector } from "@/store";
import { dismissToast } from "@/store/toastSlice";

function useEscape(onClose: () => void) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", k);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
}

function Portal({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => setEl(document.body), []);
  return el ? createPortal(children, el) : null;
}

/**
 * Enter presses the dialog's main action: the last enabled button in its action row (every dialog puts it last).
 * Enter keeps its own meaning in a textarea, on a focused button or link, inside a form (which submits itself), and
 * while an input method is composing a character. A disabled main action means Enter does nothing.
 */
function enterPressesAction(e: React.KeyboardEvent<HTMLDivElement>, row: HTMLDivElement | null) {
  if (e.key !== "Enter" || e.shiftKey || e.altKey || e.nativeEvent.isComposing || e.defaultPrevented || !row) return;
  const t = e.target as HTMLElement;
  if (t.closest("textarea, button, a, select, [contenteditable='true'], form, [role='listbox'], [role='combobox'], .ui-select-pop")) return;
  const buttons = [...row.querySelectorAll<HTMLButtonElement>("button")];
  const main = buttons.at(-1);
  e.preventDefault();
  if (main && !main.disabled && main.getAttribute("aria-busy") !== "true") main.click();
}

/** `bare` keeps the scrim, focus, Escape and click-outside, and leaves the whole inside to `children` (a dialog with its own layout). */
export function Modal({ title, onClose, children, actions, wide, bare, className }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode; wide?: boolean; bare?: boolean; className?: string }) {
  useEscape(onClose);
  const row = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  // The portal mounts a render later than this component, so focus the dialog when it actually appears (an effect
  // here would run while it is still missing). Focus inside the dialog is what lets Enter, Tab and Escape reach it.
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (el && !focused.current && !el.contains(document.activeElement)) {
      focused.current = true;
      el.focus();
    }
  }, []);
  return (
    <Portal>
      <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div
          ref={ref}
          tabIndex={-1}
          className={`modal glass${wide ? " wide" : ""}${className ? ` ${className}` : ""}`}
          role="dialog"
          aria-modal="true"
          aria-label={typeof title === "string" ? title : undefined}
          onKeyDown={(e) => enterPressesAction(e, row.current)}
        >
          {bare ? children : (
          <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <h3>{title}</h3>
            <button type="button" className="btn btn-text btn-xs" onClick={onClose} aria-label="Close">
              <Icon id="x" />
            </button>
          </div>
          <div style={{ marginTop: 16 }}>{children}</div>
          {actions ? (
            <div className="actions" ref={row}>
              {actions}
            </div>
          ) : null}
          </>
          )}
        </div>
      </div>
    </Portal>
  );
}

export function Drawer({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  useEscape(onClose);
  return (
    <Portal>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer glass" role="dialog" aria-modal="true">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 18 }}>
          <div style={{ minWidth: 0 }}>{title}</div>
          <button type="button" className="btn btn-text btn-xs" onClick={onClose} aria-label="Close">
            <Icon id="x" />
          </button>
        </div>
        {children}
      </aside>
    </Portal>
  );
}

export function Confirm({
  title,
  body,
  confirmLabel = "Confirm",
  danger,
  loading,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div style={{ color: "var(--ink-2)", fontSize: 15 }}>{body}</div>
    </Modal>
  );
}

function ToastItem({ id, tone, message }: { id: string; tone: string; message: string }) {
  const dispatch = useAppDispatch();
  useEffect(() => {
    const t = setTimeout(() => dispatch(dismissToast(id)), tone === "bad" ? 8000 : 5000);
    return () => clearTimeout(t);
  }, [dispatch, id, tone]);
  return (
    <div className={`toast glass ${tone}`} role={tone === "bad" ? "alert" : "status"}>
      <i />
      <span>{message}</span>
      <button type="button" aria-label="Dismiss" onClick={() => dispatch(dismissToast(id))}>
        <Icon id="x" />
      </button>
    </div>
  );
}

export function Toaster() {
  const toasts = useAppSelector((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} {...t} />
      ))}
    </div>
  );
}
