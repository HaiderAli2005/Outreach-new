"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
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

export function Modal({ title, onClose, children, actions, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode; wide?: boolean }) {
  useEscape(onClose);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Portal>
      <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div ref={ref} tabIndex={-1} className={`modal glass${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <h3>{title}</h3>
            <button type="button" className="btn btn-text btn-xs" onClick={onClose} aria-label="Close">
              <Icon id="x" />
            </button>
          </div>
          <div style={{ marginTop: 16 }}>{children}</div>
          {actions ? <div className="actions">{actions}</div> : null}
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
