import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Confirm, Modal } from "@/components/ui/overlays";
import { Button } from "@/components/ui/primitives";

/** The delete-workspace shape: a typed confirmation that enables the main button. */
function TypeToConfirm({ onDelete, onKeep }: { onDelete: () => void; onKeep: () => void }) {
  const [v, setV] = useState("");
  return (
    <Modal
      title="Delete acme.io?"
      onClose={onKeep}
      actions={
        <>
          <button type="button" onClick={onKeep}>
            Keep it
          </button>
          <Button variant="danger" disabled={v !== "acme.io"} onClick={onDelete}>
            Delete workspace
          </Button>
        </>
      }
    >
      <input aria-label="Type acme.io to confirm" value={v} onChange={(e) => setV(e.target.value)} />
      <textarea aria-label="Note" />
    </Modal>
  );
}

describe("Modal: Enter presses the main action", () => {
  it("runs the main button from the text box once it is enabled, and never while it is disabled", async () => {
    const onDelete = vi.fn();
    const onKeep = vi.fn();
    render(<TypeToConfirm onDelete={onDelete} onKeep={onKeep} />);
    const box = screen.getByRole("textbox", { name: "Type acme.io to confirm" });
    await userEvent.type(box, "acme{Enter}");
    expect(onDelete).not.toHaveBeenCalled();
    await userEvent.type(box, ".io{Enter}");
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onKeep).not.toHaveBeenCalled();
  });

  it("leaves Enter alone in a textarea, where it starts a new line", async () => {
    const onDelete = vi.fn();
    render(<TypeToConfirm onDelete={onDelete} onKeep={vi.fn()} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Type acme.io to confirm" }), "acme.io");
    await userEvent.type(screen.getByRole("textbox", { name: "Note" }), "a{Enter}b");
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("confirms a Confirm dialog with Enter", async () => {
    const onConfirm = vi.fn();
    render(<Confirm title="Stop outreach?" body="Nothing else goes out." confirmLabel="Stop" onConfirm={onConfirm} onClose={vi.fn()} />);
    await userEvent.keyboard("{Enter}");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
