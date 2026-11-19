# Refactor Spec: Voice Messages

## 1. Current implementation
Composer records via MediaRecorder, shows a live waveform (bar samples), preview, then sends a
`type: voice` message with a `/upload` URL and `duration` in `CreateMessageDto`. **`duration` is
not in the `Message` schema → dropped.** Global mini-player (`CurrentVoiceContext`): a hidden
`<audio>` that survives navigation, auto-advances to the next voice in the channel
(`getNextVoiceInChannelRef` filled by the chat page), marks the message read on end, RAF progress
loop. `voice-player.tsx` per-bubble control + speed.

## 2. Current architecture
```
record → blob → uploadWithProgress → POST /upload → send {type:voice, content:url, duration}
play → VoicePlayer binds to CurrentVoiceContext → hidden <audio> → on end → onVoiceEndedRef (mark read) → next
```

## 3. Current problems
- `duration` silently lost server-side → every client re-derives from audio metadata (delayed, sometimes `Infinity` for webm).
- No persisted waveform → each client recomputes / shows a flat bar.
- Refs-as-event-bus between context and chat page (`scrollToMessageIdRef`, `onVoiceEndedRef`, `getNextVoiceInChannelRef`).
- Always-mounted hidden `<audio>` even when nothing plays.
- No transcription; no "played" state distinct from "read".

## 4. Refactor goal
Persist `durationSec` + a compact waveform; keep the global player but clean the wiring; small
optional "played" indicator.

## 5. New architecture
```
record → MediaService.uploadAudio → returns MediaRef { url, durationSec, waveform: number[64] }  (server probes + downsamples)
send → message.media = [MediaRef], type = voice
global player: a `VoicePlaybackProvider` with a typed API (play(messageId), next/prev, seek, speed)
  and a `getChannelVoiceQueue` supplied via context value (not a ref hole)
"played by me" tracked per message (message_plays or a client-only set) → optional dot
```

## 6. Backend changes
- `MediaService.uploadAudio`: ffprobe duration + generate a 64-point RMS waveform; store on the `MediaRef`.
- `MessageDto.media[].durationSec` + `.waveform`.
- Optional `message_plays { messageId, userId }` if "played" state is wanted (product decision — probably skip; "read" is enough for a family app).

## 7. Frontend changes
- `<VoiceMessage>` renders the stored waveform + duration immediately (no client probe).
- `VoicePlaybackProvider` exposes `{ current, playing, progress, play, toggle, seek, setSpeed }` and takes an `onEnded` + `queue` via props/context, not refs.
- Mount the `<audio>` lazily on first play; unmount when cleared.
- Auto-advance uses the RQ message cache for the channel (no ref callback from the page).

## 8. UI/UX
- Bubble: play/pause, waveform (progress fill), duration, speed toggle (1× / 1.5× / 2×).
- Recording: hold-to-record or tap-to-lock; slide-to-cancel; live waveform; release → preview with play + re-record + send.
- Global bar (when playing + scrolled away): title, mini waveform, play/pause, close, tap → scroll to message.
- Optional subtle "played" dot (if kept).

## 9. Data contract
`MediaRef (audio) { id, kind:"audio", url, durationSec, waveform: number[] }`.

## 10. Performance
- No client-side decode-to-measure on load (duration + waveform come from the server).
- `<audio>` not mounted when idle.

## 11. Migration
- New voice messages carry `durationSec`/`waveform`.
- Old ones: `durationSec` absent → client falls back to metadata probe (current behaviour) as a fallback path only.

## 12. Tests
- Upload returns correct duration + waveform length.
- Auto-advance picks the next voice in `createdAt` order, skips deleted.
- Global bar scroll-to-message; unmount on clear.
- Fallback probe path for legacy messages.

## 13. Risks
- Server ffprobe/waveform adds upload latency → do it inline for audio (small files) or async with a "processing" state.
- webm duration quirks server-side too → prefer a container that reports duration, or compute from sample count.

## 14. Acceptance criteria
- Voice messages persist `durationSec` and a waveform; clients render both without decoding.
- The global player wiring uses typed context, not `useRef` holes.
- `<audio>` is not mounted while idle.
- Legacy voice messages still play (fallback probe).
