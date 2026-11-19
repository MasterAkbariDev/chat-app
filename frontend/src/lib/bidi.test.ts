import { describe, expect, it } from "vitest";
import { firstStrongDirection, lineDirections, textDirection } from "./bidi";

describe("firstStrongDirection", () => {
  it("is decided by the first letter, not by digits", () => {
    expect(firstStrongDirection("544 تومان")).toBe("rtl");
    expect(firstStrongDirection("قیمت 544")).toBe("rtl");
    expect(firstStrongDirection("544 hello")).toBe("ltr");
    expect(firstStrongDirection("hello 544 سلام")).toBe("ltr");
    expect(firstStrongDirection("سلام hello")).toBe("rtl");
  });

  it("skips neutrals: punctuation, emoji, Persian/Arabic digits", () => {
    expect(firstStrongDirection("😀 «سلام»")).toBe("rtl");
    expect(firstStrongDirection("۱۲۳ ok")).toBe("ltr");
    expect(firstStrongDirection("@#! שלום")).toBe("rtl");
  });

  it("returns null when there is no strong character", () => {
    expect(firstStrongDirection("")).toBeNull();
    expect(firstStrongDirection(undefined)).toBeNull();
    expect(firstStrongDirection("544 ۱۲ 😀 ...")).toBeNull();
  });
});

describe("textDirection", () => {
  it("falls back when nothing is strong", () => {
    expect(textDirection("123")).toBe("ltr");
    expect(textDirection("123", "rtl")).toBe("rtl");
    expect(textDirection("سلام")).toBe("rtl");
  });
});

describe("lineDirections", () => {
  it("gives each line its own direction; neutral lines inherit", () => {
    expect(lineDirections("سلام 544\nhello 544 سلام\n544\n544 تومان")).toEqual(["rtl", "ltr", "ltr", "rtl"]);
  });
});
