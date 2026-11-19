# Infra setup — the pieces that needed more than code

**Status as of 2026-09-26: done.** Both categories below are now live and verified — Docker
Desktop is running with the self-hosted stack up, and a real Firebase project is fully wired.
This doc is kept as the record of what was needed and how it was verified, and as the runbook
for bringing it back up after a reboot (Docker containers don't survive one; `.env`/`livekit.yaml`
do).

---

## 1. Docker services — media uploads + calls ✅ done

Unblocks: real photo/video/voice messages, real wallpaper/pack image uploads, and the calls
(LiveKit) feature. All self-hosted via this repo's own `backend/docker-compose.yml` — never a
cloud account.

**Setup (already done):**
- `backend/.env` has real `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`/`TURN_SECRET` and
  `MEDIA_STORAGE_DRIVER=s3` pointed at `127.0.0.1:9010`.
- `backend/livekit.yaml` (gitignored — the tracked file is only `livekit.yaml.example`) exists,
  with its `keys:` entry matching `.env` exactly.
- Docker Desktop is running; `docker compose up -d minio minio-init livekit coturn` brought up
  `backend-minio-1`, `backend-livekit-1`, `backend-coturn-1` (the `mongodb`/`redis`/`app` services
  in the same compose file are unused here — this environment runs those three natively instead).

**Live-verified, not just "containers are up":**
- Uploaded a real PNG via `POST /v2/wallpapers/upload/image` — came back as a processed JPEG,
  fetched it back from `/uploads/media/...` and confirmed valid image bytes (200, correct file
  type). Real MinIO round-trip, not a mock.
- Started a real call via `POST /v1/calls` — got back a room token whose `iss` claim matches the
  configured LiveKit key, confirming the backend and the LiveKit container are actually talking
  and agree on the signing key. Ended it cleanly via `/leave`.

**To bring this back up after a reboot** (Docker containers don't persist across a restart of
Docker Desktop itself, only across the app being closed and reopened while the Mac stays on):
```bash
cd chat-app/backend
docker compose up -d minio minio-init livekit coturn
```
Then restart the backend dev server so it reconnects.

**If you ever want uploads without Docker at all:** switch `MEDIA_STORAGE_DRIVER=disk` in
`backend/.env` — writes to a local `uploads/` folder, no container needed. Calls still need the
`livekit`/`coturn` containers regardless.

---

## 2. Firebase — push notifications ✅ done

Unblocks: background/killed-app push notifications. The backend already had a complete FCM send
pipeline (`FcmService` + `firebase-admin`, wired into `notification.service.ts`'s per-recipient
fan-out) sitting unused for lack of credentials — this was purely a "get real credentials, then
wire the frontend half" task, not a backend build.

**What's in place:**
- `chat-app/firebase.json` — the web app's public `firebaseConfig` (mirrored into
  `frontend/.env.local` as `NEXT_PUBLIC_FIREBASE_*`, and duplicated literally inside
  `frontend/public/firebase-messaging-sw.js`, since a service worker can't read Next.js env vars).
- `backend/.env`'s `FIREBASE_WEB_PUSH_KEY` — the VAPID public key, also mirrored to
  `NEXT_PUBLIC_FIREBASE_VAPID_KEY` for the frontend.
- `backend/secrets/fcm-service-account.json` — the real admin credential (gitignored via
  `/secrets`). `FcmService` reads it automatically at boot from this exact default path; no env
  var needed to point at it.
- Frontend: `lib/push.ts` (permission request → service worker → real FCM token →
  `POST /v1/push/tokens`, degrading quietly if unsupported/denied/unconfigured) and a "Browser
  notifications" toggle in Settings, wired to unregister on logout.

**Live-verified, working around one real sandbox limitation:** this environment's automated
browser denies the native `Notification` permission prompt outright (no human present to click
"Allow"), so the full click-through UI flow couldn't be exercised end to end here. Everything
around that gate was: registered a token directly via `POST /v1/push/tokens`, confirmed it in
Mongo (`push_tokens`, keyed by plain-string `userId` — not an ObjectId), sent a real message to
that user while their socket was disconnected (so the fan-out doesn't skip them as "already
watching"), and confirmed Firebase's own API rejected the fake test token as
`invalid-registration-token` — which could only happen via a genuine network call to Firebase's
messaging API — and confirmed the backend's own cleanup logic then removed it from the DB. That's
about as complete a proof as this sandbox can produce without a real device holding a real token;
the actual permission-prompt-and-register flow on a real browser should be spot-checked once,
by a human, the first time it matters.

---

## Everything else already blocked-and-flagged in the plan docs

Nothing else in `FRONTEND_PLAN.md`/`BACKEND_PLAN.md` needs infra beyond the two things above — if
a future pass finds something else genuinely blocked on external setup, it belongs in this file
too, not buried in a phase's own notes.
