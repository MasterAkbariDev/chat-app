import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Field, Input, Textarea } from "./Field";

describe("Field", () => {
  it("links a label to a single unlabeled Input via a generated id", () => {
    render(
      <Field label="Email">
        <Input placeholder="you@example.com" />
      </Field>,
    );
    // getByLabelText only succeeds if the label is *programmatically*
    // associated (htmlFor/id, or wrapping) — not just visually adjacent.
    // This is exactly the real Lighthouse-caught bug (see Field.tsx's own
    // comment): before the fix, this line failed.
    expect(screen.getByLabelText("Email")).toBeInstanceOf(HTMLInputElement);
  });

  it("links a label to a single unlabeled Textarea the same way", () => {
    render(
      <Field label="Bio">
        <Textarea />
      </Field>,
    );
    expect(screen.getByLabelText("Bio")).toBeInstanceOf(HTMLTextAreaElement);
  });

  it("respects a caller-supplied id instead of overwriting it, and still links via it", () => {
    render(
      <Field label="Password">
        <Input id="login-password" type="password" />
      </Field>,
    );
    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("id", "login-password");
  });

  it("renders no label element at all when none is given", () => {
    render(
      <Field>
        <Input placeholder="no label" />
      </Field>,
    );
    expect(screen.queryByText("no label")).not.toBeInTheDocument();
    expect(document.querySelector("label")).not.toBeInTheDocument();
  });

  it("doesn't guess which child a label describes when there's more than one", () => {
    // Mirrors login/page.tsx's password field: a custom label row plus a
    // separate Input, both as direct Field children — Field shouldn't try
    // to associate its own generated label with either of them (there isn't
    // one here; `label` is intentionally omitted, matching that real usage).
    render(
      <Field>
        <div>Custom label row</div>
        <Input placeholder="multi-child" />
      </Field>,
    );
    expect(screen.getByPlaceholderText("multi-child")).not.toHaveAttribute("id");
  });

  it("shows the error message instead of the hint when both are given", () => {
    render(
      <Field label="Username" hint="Letters and numbers only" error="Already taken">
        <Input />
      </Field>,
    );
    expect(screen.getByText("Already taken")).toBeInTheDocument();
    expect(screen.queryByText("Letters and numbers only")).not.toBeInTheDocument();
  });
});
