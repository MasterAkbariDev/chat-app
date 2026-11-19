import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageBubble, type MessageBubbleData } from "./MessageBubble";

const BASE: MessageBubbleData = {
  id: "m1",
  type: "voice_call",
  mine: false,
  createdAt: "10:00 AM",
};

describe("MessageBubble (voice_call / call-log rendering)", () => {
  // `message.text` carries the call-log's raw JSON `content` unchanged
  // (see ConversationView's toBubbleData) — mirrors exactly what the
  // backend's `finalizeCall` writes (calls.service.ts).
  it("renders a missed call, phrased for the recipient", () => {
    render(<MessageBubble message={{ ...BASE, text: JSON.stringify({ callLog: true, kind: "missed" }) }} />);
    expect(screen.getByText("Missed call")).toBeInTheDocument();
  });

  it("renders the same missed call phrased differently for the caller (mine: true)", () => {
    render(<MessageBubble message={{ ...BASE, mine: true, text: JSON.stringify({ callLog: true, kind: "missed" }) }} />);
    expect(screen.getByText("No answer")).toBeInTheDocument();
  });

  it("renders a completed call's real duration", () => {
    render(
      <MessageBubble
        message={{ ...BASE, text: JSON.stringify({ callLog: true, kind: "ended", durationMinutes: 4 }) }}
      />,
    );
    expect(screen.getByText("Call ended · 4m")).toBeInTheDocument();
  });

  it("falls back to a plain label if the content isn't real call-log JSON", () => {
    render(<MessageBubble message={{ ...BASE, text: "not json" }} />);
    expect(screen.getByText("Call")).toBeInTheDocument();
  });
});
