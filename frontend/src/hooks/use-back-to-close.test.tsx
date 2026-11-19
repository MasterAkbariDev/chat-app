import { act, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { openOverlayCount, useBackToClose } from "./use-back-to-close";

function Overlay({ name, onClose }: { name: string; onClose: () => void }) {
  useBackToClose(onClose);
  return <div data-testid={name}>{name}</div>;
}

function Harness() {
  const [a, setA] = useState(false);
  const [b, setB] = useState(false);
  return (
    <div>
      <button onClick={() => setA(true)}>open-a</button>
      <button onClick={() => setB(true)}>open-b</button>
      <button onClick={() => setA(false)}>close-a</button>
      {a ? <Overlay name="a" onClose={() => setA(false)} /> : null}
      {b ? <Overlay name="b" onClose={() => setB(false)} /> : null}
    </div>
  );
}

const depth = () => (window.history.state as { __overlayDepth?: number } | null)?.__overlayDepth ?? 0;
const back = () =>
  act(async () => {
    window.history.back();
    await new Promise((r) => setTimeout(r, 30));
  });

describe("useBackToClose", () => {
  it("Back closes the topmost overlay only, one per press, and the URL never changes", async () => {
    const url = location.href;
    const { getByText, queryByTestId } = render(<Harness />);
    act(() => getByText("open-a").click());
    act(() => getByText("open-b").click());
    expect(openOverlayCount()).toBe(2);
    expect(depth()).toBe(2);

    await back();
    expect(queryByTestId("b")).toBeNull();
    expect(queryByTestId("a")).not.toBeNull();

    await back();
    expect(queryByTestId("a")).toBeNull();
    expect(openOverlayCount()).toBe(0);
    expect(depth()).toBe(0);
    expect(location.href).toBe(url);
  });

  it("closing another way pops its history entry again", async () => {
    const { getByText, queryByTestId } = render(<Harness />);
    act(() => getByText("open-a").click());
    expect(depth()).toBe(1);
    const opened = window.history.length;
    act(() => getByText("close-a").click());
    expect(queryByTestId("a")).toBeNull();
    await waitFor(() => expect(depth()).toBe(0));
    // Re-opening replaces the popped entry instead of growing history.
    act(() => getByText("open-a").click());
    expect(depth()).toBe(1);
    expect(window.history.length).toBe(opened);
  });
});
