"use client";

import { Image as ImageIcon } from "lucide-react";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { ListGroup, ListItem } from "@/components/ui/List";
import { PageBody, PageHeader } from "@/components/ui/PageHeader";
import { PerformanceSettings } from "@/components/settings/PerformanceSettings";

/** Bundles theme + wallpaper — the two real appearance settings that exist — behind
 *  the single "Appearance" row on the main Settings page. That row previously had no
 *  `onClick` at all (a dead click, despite promising "Theme, wallpaper, text size");
 *  text size isn't a real feature anywhere in this app yet, so it isn't promised here. */
export default function AppearancePage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PageHeader title="Appearance" backHref="/app/settings" backLabel="Back to settings" backOnDesktop />

      <PageBody>
        <section aria-labelledby="appearance-theme" className="flex flex-col gap-2">
          <h2 id="appearance-theme" className="px-1 text-[13.5px] font-semibold text-muted">
            Theme
          </h2>
          <div className="rounded-[var(--radius-md)] border border-line bg-panel p-4">
            <ThemeSwitcher />
          </div>
        </section>

        <ListGroup title="Wallpaper">
          <ListItem icon={ImageIcon} title="Chat wallpaper" subtitle="Default background for every chat" href="/app/settings/wallpaper" />
        </ListGroup>

        <PerformanceSettings />
      </PageBody>
    </div>
  );
}
