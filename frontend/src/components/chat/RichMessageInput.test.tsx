import { describe, expect, it } from "vitest";
import { serializeEditor } from "./RichMessageInput";

function editor(html: string) {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

describe("serializeEditor", () => {
  it("turns inline animated emoji into their unicode fallback with UTF-16 offsets", () => {
    const root = editor(
      'Hi <img class="inline-emoji" data-item-id="a1" data-path="h/original.webp" data-fallback="😂"> there <img class="inline-emoji" data-item-id="b2" data-path="k/original.webp" data-fallback="🔥">',
    );
    const { text, emoji } = serializeEditor(root);
    expect(text).toBe("Hi 😂 there 🔥");
    expect(emoji).toEqual([
      { offset: 3, length: 2, packItemId: "a1", relativePath: "h/original.webp", packId: undefined },
      { offset: 12, length: 2, packItemId: "b2", relativePath: "k/original.webp", packId: undefined },
    ]);
    expect(text.slice(emoji[1].offset, emoji[1].offset + emoji[1].length)).toBe("🔥");
  });

  it("maps <br> and block lines to newlines but ignores the browser's trailing placeholder <br>", () => {
    expect(serializeEditor(editor("one<br>two<br>")).text).toBe("one\ntwo");
    expect(serializeEditor(editor("<div>one</div><div>two</div>")).text).toBe("one\ntwo");
  });

  it("normalises non-breaking spaces from contenteditable", () => {
    expect(serializeEditor(editor("a b")).text).toBe("a b");
  });
});
