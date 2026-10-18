(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RallycadeMusic = api;
})(typeof window === "undefined" ? globalThis : window, function () {
  "use strict";
  const NAMESPACE = "urn:x-cast:com.slipspark.music", LEASE_MS = 3000;
  // Only the bundled original bed: a sender cannot make the TV fetch a URL.
  function createPlayer({ audio, send, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let owner = null, id = null, sequence = -1, deadline = 0, lease, ramp, target = 0, version = 0, ownerVersion = 0, playPending = false;
    audio.loop = true; audio.preload = "auto"; audio.volume = 0;
    function stop() {
      version++; ownerVersion++; playPending = false; target = 0; clearTimer(lease); clearTimer(ramp);
      audio.volume = 0; audio.pause();
    }
    function reply(t, extra = {}) {
      if (owner) send(owner, Object.assign({ t, id, seq: sequence, time: now(), position: Number(audio.currentTime) || 0 }, extra));
    }
    function failure() { stop(); reply("music-error", { stopped: true }); }
    audio.addEventListener("error", failure);
    function fade(to, seconds) {
      clearTimer(ramp);
      const from = audio.volume, began = now(), token = version;
      function step() {
        if (token !== version) return;
        const part = seconds > 0 ? Math.min(1, (now() - began) / (seconds * 1000)) : 1;
        audio.volume = Math.max(0, Math.min(1, from + (to - from) * part));
        if (part < 1) ramp = setTimer(step, 20);
        else if (to === 0) { audio.pause(); reply("music-status", { stopped: true }); }
      }
      step();
    }
    function handle(sender, raw) {
      let message;
      try { message = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (_) { return; }
      if (!message || typeof message.id !== "string" || message.id.length > 64) return;
      if (message.t === "hello" && message.v === 1) {
        if (owner !== sender || id !== message.id) { stop(); owner = sender; id = message.id; sequence = -1; }
        reply("ready", { v: 1, sent: message.sent }); return;
      }
      if (message.t !== "music" || owner !== sender || id !== message.id) return;
      const { seq, volume, position, expires } = message;
      if (![seq, volume, position, expires].every(Number.isFinite) || !Number.isInteger(seq) || seq <= sequence
          || volume < 0 || volume > 1 || position < 0 || position > 86400 || expires <= now()) return;
      const shouldRamp = volume !== target || (volume === 0 && !(Number(message.fade) > 0));
      sequence = seq; deadline = Math.min(expires, now() + LEASE_MS); target = volume;
      clearTimer(lease);
      lease = setTimer(() => { if (now() >= deadline) { stop(); reply("music-status", { stopped: true }); } }, Math.max(0, deadline - now()));
      if (shouldRamp) ++version;
      if (volume === 0) { ownerVersion++; playPending = false; }
      if (volume === 0 && !(Number(message.fade) > 0)) { audio.volume = 0; audio.pause(); }
      if (volume > 0 && audio.paused) {
        try {
          if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = position % audio.duration;
          else audio.currentTime = position;
          const token = ownerVersion;
          playPending = true;
          const playing = audio.play();
          Promise.resolve(playing).then(() => {
            if (token !== ownerVersion) return;
            playPending = false;
            if (now() >= deadline || target === 0) { stop(); return; }
            reply("music-status", { stopped: false });
          }, () => { if (token === ownerVersion) failure(); });
        } catch (_) { failure(); return; }
      } else if (!playPending) reply("music-status", { stopped: volume === 0 && audio.paused });
      if (shouldRamp) fade(volume, Math.max(0, Math.min(3, Number(message.fade) || 0)));
    }
    return { handle, stop, disconnected(sender) { if (sender === owner) { stop(); owner = null; id = null; } } };
  }
  return { NAMESPACE, LEASE_MS, createPlayer };
});
