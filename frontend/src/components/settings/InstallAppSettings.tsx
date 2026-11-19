"use client";

import { useState } from "react";
import { Download, Share, Smartphone } from "lucide-react";
import { promptInstall, useInstallState } from "@/lib/install-app";

/** The "App" settings: whether Chat runs installed, and how to install it on this device. */
export function InstallAppSettings() {
  const state = useInstallState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function install() {
    setBusy(true);
    setError(null);
    try {
      await promptInstall();
    } catch {
      setError("The install didn't start. Try again from your browser's menu.");
    } finally {
      setBusy(false);
    }
  }

  const copy =
    state === "installed"
      ? { title: "Installed on this device", body: "Chat opens in its own full-screen window from your home screen or app list." }
      : state === "ready"
        ? { title: "Install Chat", body: "Add it to your home screen to open it full screen, like an app." }
        : state === "ios"
          ? { title: "Add to Home Screen", body: "Tap Share, then Add to Home Screen. It then opens full screen like an app." }
          : { title: "Install from your browser", body: "This browser doesn't offer installing here. Use its menu and look for Install app or Add to Home Screen." };

  return (
    <div className="flex min-h-[60px] items-center gap-3 px-4 py-2.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-sunken text-fg-2">
        {state === "ios" ? <Share className="size-[18px]" strokeWidth={1.8} aria-hidden /> : <Smartphone className="size-[18px]" strokeWidth={1.8} aria-hidden />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] text-fg">{copy.title}</div>
        <div className="text-[13px] text-muted">{copy.body}</div>
        {error ? <div className="mt-1 text-[13px] text-danger">{error}</div> : null}
      </div>
      {state === "ready" ? (
        <button
          type="button"
          onClick={install}
          disabled={busy}
          className="pressable inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 text-[14px] font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-60"
        >
          <Download className="size-4" strokeWidth={2} aria-hidden />
          Install
        </button>
      ) : null}
    </div>
  );
}
