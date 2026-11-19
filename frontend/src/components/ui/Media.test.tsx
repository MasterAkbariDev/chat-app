import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Media } from "./Media";

describe("Media", () => {
  it("falls back to a plain <img> when width/height aren't known", () => {
    render(<Media src="https://cdn.example.com/photo.jpg" alt="a photo" />);
    const img = screen.getByAltText("a photo");
    expect(img.tagName).toBe("IMG");
    expect(img).toHaveAttribute("src", "https://cdn.example.com/photo.jpg");
  });

  it("renders via next/image (with real width/height) once dimensions are known", () => {
    render(<Media src="https://cdn.example.com/photo.jpg" alt="a photo" width={800} height={600} />);
    const img = screen.getByAltText("a photo");
    expect(img).toHaveAttribute("width", "800");
    expect(img).toHaveAttribute("height", "600");
  });

  it("degrades quietly (no crash, no placeholder) when canvas 2D isn't available — e.g. this jsdom test environment", () => {
    // jsdom doesn't implement a real <canvas> 2D context — HTMLCanvasElement.getContext
    // returns null here — which is exactly the "no blurhash placeholder, not a crash"
    // path Media.tsx's own comment says this should degrade through.
    expect(() =>
      render(
        <Media
          src="https://cdn.example.com/photo.jpg"
          alt="a photo"
          width={800}
          height={600}
          blurhash="LEHV6nWB2yk8pyo0adR*.7kCMdnj"
        />,
      ),
    ).not.toThrow();
    expect(screen.getByAltText("a photo")).toBeInTheDocument();
  });
});
