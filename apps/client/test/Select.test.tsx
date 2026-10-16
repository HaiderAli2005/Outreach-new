import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Select } from "@/components/ui/Select";

function Harness({ onChange, zones }: { onChange: (v: string) => void; zones?: string[] }) {
  const [v, setV] = useState("b");
  return (
    <Select
      aria-label="Pick"
      value={v}
      onChange={(e) => {
        setV(e.target.value);
        onChange(e.target.value);
      }}
    >
      {zones ? (
        zones.map((z) => (
          <option key={z} value={z}>
            {z}
          </option>
        ))
      ) : (
        <>
          <option value="a">Alpha</option>
          <option value="b">
            Bravo {2} {"(two)"}
          </option>
          <option value="c" disabled>
            Charlie
          </option>
          <option value="d">Delta</option>
        </>
      )}
    </Select>
  );
}

describe("Select", () => {
  it("shows the current option's text, built from several children", () => {
    render(<Harness onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Pick" })).toHaveTextContent("Bravo 2 (two)");
  });

  it("picks with the mouse and reports a native-shaped change", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Pick" }));
    expect(screen.getByRole("option", { name: /Bravo/ })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("option", { name: "Alpha" }));
    expect(onChange).toHaveBeenCalledWith("a");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("moves with the keyboard and skips disabled options", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    screen.getByRole("button", { name: "Pick" }).focus();
    await userEvent.keyboard("{Enter}{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("d");
  });

  it("ignores clicks on disabled options and closes on Escape", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Pick" }));
    await userEvent.click(screen.getByRole("option", { name: "Charlie" }));
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("filters long lists with a search box", async () => {
    const onChange = vi.fn();
    const zones = Array.from({ length: 20 }, (_, i) => `Zone/${i === 7 ? "Stockholm" : `Place${i}`}`);
    render(<Harness onChange={onChange} zones={zones} />);
    await userEvent.click(screen.getByRole("button", { name: "Pick" }));
    await userEvent.keyboard("stock");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("Zone/Stockholm");
  });
});
