"use client";

import { useContext } from "react";
import { Track, type Participant } from "livekit-client";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/ui/Avatar";
import { ActiveCallContext, useElementSize } from "./call-hooks";
import { CallTile } from "./CallTile";
import { gridShape, type CallLayout } from "./call-utils";
import { DraggableCorner } from "./DraggableCorner";

export interface StageTile {
  key: string;
  participant: Participant;
  source: Track.Source;
}

export interface CallStageProps {
  layout: CallLayout;
  tiles: StageTile[];
  focusKey: string | null;
  maximizedKey: string | null;
  /** 1:1 with video: whether the self-view and the other person are swapped. */
  swapped: boolean;
  statusText: string;
  onFocus: (key: string | null) => void;
  onMaximize: (key: string | null) => void;
  onSwap: () => void;
}

/** The middle of the call screen: picks between the waiting screen, the
 * adaptive grid, the spotlight (+ filmstrip), the Telegram-style 1:1 view
 * (other person full, self-view as a draggable picture-in-picture) and the
 * maximized single tile. */
export function CallStage(props: CallStageProps) {
  const { layout, tiles, focusKey, maximizedKey, swapped, onFocus, onMaximize, onSwap } = props;
  const [stageRef, size] = useElementSize<HTMLDivElement>();
  const portrait = size.height > size.width * 1.05;
  const wide = size.width >= 1100;

  const local = tiles.find((t) => t.participant.isLocal && t.source === Track.Source.Camera);
  const toggleMax = (key: string) => onMaximize(maximizedKey === key ? null : key);

  const maximized = maximizedKey ? tiles.find((t) => t.key === maximizedKey) : undefined;
  if (maximized) {
    return (
      <div ref={stageRef} className="absolute inset-0">
        <CallTile
          participant={maximized.participant}
          source={maximized.source}
          variant="stage"
          maximized
          className="absolute inset-0"
          onMaximize={() => onMaximize(null)}
        />
      </div>
    );
  }

  if (layout === "waiting") {
    return (
      <div ref={stageRef} className="absolute inset-0">
        <WaitingCard statusText={props.statusText} />
        {local ? (
          <DraggableCorner {...pipBox(portrait, size.width)} label="Your video">
            <CallTile participant={local.participant} source={local.source} variant="pip" className="size-full" />
          </DraggableCorner>
        ) : null}
      </div>
    );
  }

  if (layout === "duo") {
    const remote = tiles.find((t) => !t.participant.isLocal);
    const big = swapped ? local : remote;
    const small = swapped ? remote : local;
    return (
      <div ref={stageRef} className="absolute inset-0 px-2 pb-2 sm:px-4">
        {big ? (
          <CallTile
            key={big.key}
            participant={big.participant}
            source={big.source}
            variant="stage"
            fill
            className="size-full"
            onActivate={() => {}}
            activateLabel={`${big.participant.isLocal ? "You" : "Other person"} — double tap for full screen`}
            onMaximize={() => toggleMax(big.key)}
          />
        ) : null}
        {small ? (
          <DraggableCorner {...pipBox(portrait, size.width)} label={swapped ? "Other person's video" : "Your video"}>
            <CallTile
              key={small.key}
              participant={small.participant}
              source={small.source}
              variant="pip"
              className="size-full"
              onActivate={onSwap}
              activateLabel="Swap views"
            />
          </DraggableCorner>
        ) : null}
      </div>
    );
  }

  if (layout === "spotlight" && focusKey) {
    const main = tiles.find((t) => t.key === focusKey);
    const rest = tiles.filter((t) => t.key !== focusKey);
    const side = !portrait && size.width >= 720;
    return (
      <div ref={stageRef} className={cn("absolute inset-0 flex gap-2 px-2 pb-2 sm:px-4", side ? "flex-row" : "flex-col")}>
        <div className="relative min-h-0 min-w-0 flex-1">
          {main ? (
            <CallTile
              key={main.key}
              participant={main.participant}
              source={main.source}
              variant="stage"
              className="absolute inset-0"
              onActivate={() => {}}
              activateLabel="Double tap for full screen"
              onMaximize={() => toggleMax(main.key)}
            />
          ) : null}
        </div>
        {rest.length > 0 ? (
          <ul
            aria-label="Other participants"
            className={cn(
              "flex shrink-0 gap-2 overscroll-contain",
              side ? "w-[184px] flex-col overflow-y-auto" : "h-[112px] flex-row overflow-x-auto",
            )}
          >
            {rest.map((t) => (
              <li key={t.key} className={cn("shrink-0", side ? "aspect-video w-full" : "h-full w-[92px]")}>
                <CallTile
                  participant={t.participant}
                  source={t.source}
                  variant="film"
                  className="size-full"
                  onActivate={() => onFocus(t.key)}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  // Grid
  const shape = gridShape(tiles.length, portrait, wide);
  const lastSpans = shape.rows !== null && shape.cols === 2 && tiles.length % 2 === 1 && tiles.length > 1;
  return (
    <div
      ref={stageRef}
      className={cn("absolute inset-0 grid gap-2 px-2 pb-2 sm:px-4", shape.rows === null ? "content-start overflow-y-auto overscroll-contain" : "")}
      style={{
        gridTemplateColumns: `repeat(${shape.cols}, minmax(0, 1fr))`,
        gridTemplateRows: shape.rows !== null ? `repeat(${shape.rows}, minmax(0, 1fr))` : undefined,
      }}
    >
      {tiles.map((t, i) => (
        <CallTile
          key={t.key}
          participant={t.participant}
          source={t.source}
          variant="grid"
          className={cn(
            "min-h-0",
            shape.rows === null && (portrait ? "aspect-[3/4]" : "aspect-video"),
            lastSpans && i === tiles.length - 1 && "col-span-2",
          )}
          onActivate={tiles.length > 1 ? () => onFocus(t.key) : undefined}
          activateLabel={undefined}
          onMaximize={() => toggleMax(t.key)}
        />
      ))}
    </div>
  );
}

/** Who's being rung, before anyone else has joined. */
function WaitingCard({ statusText }: { statusText: string }) {
  const call = useContext(ActiveCallContext);
  if (!call) return null;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 pb-16 text-center">
      <div className="pulse-ring rounded-full">
        <Avatar
          colorId={call.peerId ?? call.channelId}
          name={call.title}
          src={call.photo}
          size={132}
          shape={call.isPrivate ? "circle" : "square"}
        />
      </div>
      <p className="text-[15px] text-white/70">{statusText}</p>
    </div>
  );
}

/** Self-view size: portrait-shaped on a portrait stage, 16:9 otherwise. */
function pipBox(portrait: boolean, stageWidth: number) {
  const small = stageWidth < 640;
  const width = portrait ? (small ? 104 : 144) : small ? 148 : 240;
  const height = portrait ? Math.round(width * (4 / 3)) : Math.round(width * (9 / 16));
  const m = small ? "12px" : "16px";
  return { width, height, offsets: { top: m, bottom: m, side: m } };
}
