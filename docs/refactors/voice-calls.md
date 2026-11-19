# Refactor Spec: Voice Calls

> **RESOLVED (DECISIONS Q3): Option A — build it properly.** SFU (LiveKit) + TURN (coturn) +
> Redis-backed signalling state. The current mesh/in-memory implementation is a prototype to
> replace. Audio first, video-capable architecture. Delivery: BACKEND B8 / FRONTEND F8 / FLUTTER A8.

## 1. Current implementation
1:1 ring/accept/decline + group "join anytime" calls. WebRTC **mesh** (`simple-peer`), signalling
over the main Socket.IO connection. ~13 `call_*` gateway handlers with **in-memory** `activeCalls`
/ `privateCallByChannel` / participant-socket maps. Call-log system messages (`type: voice_call`:
declined / cancelled / ended+duration). Frontend: `use-call-webrtc.ts` (772), `call-context.tsx`
(259), `call-*.tsx` ×7, `call-socket-listener.tsx`, speaking detection via Web Audio, mic device
selection, noise/echo/gain toggles, health check. `NEXT_PUBLIC_CALL_HOST` points at an external
domain (`calls.example.com/en`) via `lib/call-room.ts` — external page, **code not in
these repos (UNKNOWN)**.

## 2. Current architecture
```
call_request → gateway registers activeCalls (memory) → call_incoming to user:<other>
accept → join call:<id> → call_participants → use-call-webrtc creates simple-peer per participant (mesh)
call_signal relays SDP/ICE via user:<target>
leave/cancel/decline → call-log message + call_ended
```

## 3. Current problems
- **All call state in one process's memory** → no horizontal scale, lost on restart, reconnect races (manual "stale socketId" patches prove it).
- **Mesh** → N² peer connections; ~5–6 max.
- **No TURN** → fails on symmetric NAT; participant IPs exposed to each other.
- Audio only despite `MessageType.VIDEO`.
- ~2000 LoC across both repos for a feature whose **usage is UNKNOWN**.
- External `CALL_HOST` = undocumented trust boundary.
- `call_signal` relays arbitrary payloads (SECURITY W1); no per-socket rate limit.
- Call handlers bloat the gateway (13 of ~30).

## 4. Decision fork

### Option A — Calls are core → do it properly
- **SFU** (LiveKit or mediasoup) instead of mesh; the API issues room tokens.
- **TURN** server (coturn) for NAT traversal.
- Call state in **Redis** (rooms, participants, mute), not process memory.
- Move all `call_*` handlers into a `CallsModule` behind a flag; gateway only relays "call ringing" notifications.
- Remove `NEXT_PUBLIC_CALL_HOST` / `lib/call-room.ts` (or make it a first-party, in-repo page).
- Optional: add video (SFU makes this cheap).
- Effort: HIGH (weeks) + infra (SFU + TURN + Redis).

### Option B — Calls are occasional → externalise
- Replace in-app calling with a generated one-off room link (Jitsi/LiveKit-hosted) posted as a message; the app just deep-links out.
- Delete `use-call-webrtc`, mesh code, most gateway handlers; keep a "Start call" button that mints a link.
- Effort: LOW–MED. Loses the integrated ringing UX.

### Option C — Calls are unused → remove
- Delete: gateway `call_*` handlers + `activeCalls` maps, `use-call-webrtc.ts`, `call-context.tsx`,
  `call-*.tsx` ×7, `call-socket-listener.tsx`, `group-call-banner.tsx`, `outgoing-call-modal.tsx`,
  `current-voice-bar` call bits, `simple-peer` + `@types/simple-peer`, `lib/call-room.ts`,
  `NEXT_PUBLIC_CALL_HOST`, `MessageType.VOICE_CALL` handling.
- ~2000 LoC + 1 dependency gone; gateway drops to ~15 handlers.
- Effort: LOW.

**Recommendation:** default to **C** unless analytics/owner confirm real use; if calling matters,
**A** with LiveKit (managed) to avoid running an SFU.

## 5–9. (If Option A) New architecture / backend / frontend / UX / contract
```
POST /v1/calls  { channelId }            → creates a call, returns { callId, roomToken (LiveKit) }
POST /v1/calls/:id/join                   → roomToken for a joiner
gateway: call:ringing (to user:<callee>), call:ended (to channel/user) — notifications only
media: LiveKit room (SFU) ; TURN via LiveKit ; speaking/mute events from the SDK
call-log messages: kept, emitted by CallsModule on end/decline/cancel
frontend: `@livekit/components-react` replaces `use-call-webrtc`; CallContext keeps only
  { callId, roomToken, participants, minimized, localMuted } ; global overlay unchanged in spirit
UX: incoming modal, global call pill (minimizable), participant grid with speaking rings, mic
  select + mute, connection quality indicator, "rejoin" for group calls
```

## 10. Performance (Option A)
- SFU: 1 up + 1 down stream per participant (vs mesh N-1 each).
- Redis state → multi-node + restart-safe.
- Gateway offloads media entirely.

## 11. Migration
- Feature-flag the new calls module; run alongside old for a release; then delete mesh code.
- Option C: flag off → soak → delete.

## 12. Tests
- (A) token issuance + room lifecycle; ringing → join → leave → end; call-log message emitted once; multi-node.
- (C) removal doesn't break message rendering (no `voice_call` type crashes); gateway handler count drops.

## 13. Risks
- (A) new infra (SFU/TURN or LiveKit cost); (B) worse UX; (C) irreversible — snapshot + confirm usage first.
- External `CALL_HOST` may already be load-bearing — identify what it is before touching.

## 14. Acceptance criteria
- **A:** no call state in process memory; SFU + TURN; calls survive an API restart; gateway has ≤ 3 call-related (notification) handlers; `NEXT_PUBLIC_CALL_HOST` removed or first-party.
- **B:** "Start call" mints an external room link; no `simple-peer`; gateway call handlers removed.
- **C:** all call code + `simple-peer` + `CALL_HOST` removed; ~2000 LoC deleted; `voice_call` message handling removed cleanly.
