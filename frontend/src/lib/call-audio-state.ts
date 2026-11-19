/** True while a call is connected (set by the call screen). Other app sounds
 *  — the message "ding", a ringtone — stay silent meanwhile: a Web Audio
 *  sound starting mid-call can move a phone's output from the earpiece to
 *  the loudspeaker. Its own tiny module so NotificationsHost can read it
 *  without pulling the LiveKit call bundle in. */
let active = false;

export function setCallAudioActive(on: boolean) {
  active = on;
}

export function isCallAudioActive() {
  return active;
}
