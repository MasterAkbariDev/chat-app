/** Shown in the main pane while a page's code is still loading. It fades in
 * only after 300ms, so fast navigations never flash it; the top progress
 * bar covers the rest. */
export default function AppSegmentLoading() {
  return (
    <div className="flex flex-1 items-center justify-center bg-canvas" role="status" aria-label="Loading">
      <span
        className="size-7 rounded-full border-[3px] border-line border-t-accent"
        style={{ animation: "spin 0.8s linear infinite, fade-in 200ms ease-out 300ms both" }}
      />
    </div>
  );
}
