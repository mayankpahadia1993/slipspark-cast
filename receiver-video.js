(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RallycadeReceiverVideo = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // The phone's screen as H.264 in fragmented MP4, sent over the Cast message
  // channel in base64 parts (a Cast message carries at most 64 KB) and played
  // through Media Source Extensions. The phone places frames back to back on
  // the stream's timeline, so playback shows each one as it arrives.
  const NAMESPACE = "urn:x-cast:com.slipspark.video";
  /// After a jump, play from this far behind the newest frame (seconds).
  const LIVE_EDGE = 0.1;
  /// Every decoder trails the newest frame a little; the least it has
  /// trailed over this window is what this TV needs.
  const FLOOR_WINDOW = 6;
  /// Trailing more than that by this much, play slightly faster until close
  /// again (only the delay piled up by a hiccup can be caught up; speeding
  /// into the decoder's own delay just stutters)…
  const CATCH_UP_ABOVE = 0.15;
  const CATCH_UP_UNTIL = 0.05;
  const CATCH_UP_RATE = 1.25;
  /// …and further behind than this, jump (decoding from a keyframe costs a
  /// moment on older Chromecasts, so it is the last resort).
  const MAX_BEHIND = 1.0;
  /// Without a frame or keep-alive for this long, the phone has stopped.
  const STALL_SECONDS = 2.5;
  /// Acknowledge every this many frames so the phone knows how far the TV got.
  const ACK_EVERY = 5;
  /// More player failures than this within ten seconds: give up on the picture.
  const MAX_RECOVERIES = 4;

  /// Joins the base64 parts of one message. Returns the decoded bytes when the
  /// last part arrives, otherwise null. A newer sequence drops older partials.
  function createAssembler(decode) {
    let pending = null;
    return function add(message) {
      if (!message || typeof message.data !== "string") return null;
      const parts = Math.max(1, Number(message.parts) || 1);
      const part = Math.max(0, Number(message.part) || 0);
      if (parts === 1) { pending = null; return { message, bytes: decode(message.data) }; }
      if (!pending || pending.t !== message.t || pending.seq !== message.seq) {
        // Any other message ends a partial one: parts arrive in order.
        pending = part === 0 ? { t: message.t, seq: message.seq, parts, chunks: [], first: message } : null;
        if (!pending) return null;
      }
      if (part !== pending.chunks.length) { pending = null; return null; }
      pending.chunks.push(message.data);
      if (pending.chunks.length < parts) return null;
      const done = pending;
      pending = null;
      return { message: done.first, bytes: decode(done.chunks.join("")) };
    };
  }

  function base64ToBytes(text) {
    if (typeof atob === "function") {
      const binary = atob(text);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    return new Uint8Array(Buffer.from(text, "base64"));
  }

  /// Where to jump so playback continues near the newest frame, or null to
  /// stay. `start` and `end` bound the newest buffered range.
  function liveSeekTarget(currentTime, start, end) {
    if (!(end > start)) return null;
    if (currentTime >= start && end - currentTime <= MAX_BEHIND) return null;
    return Math.max(start, end - LIVE_EDGE);
  }

  /// The least playback has trailed the newest frame within the window.
  function createFloor(windowSeconds) {
    let samples = [];
    return {
      add(at, behind) {
        samples.push({ at, behind });
        while (samples.length && at - samples[0].at > windowSeconds) samples.shift();
      },
      get value() { return samples.reduce((least, sample) => Math.min(least, sample.behind), Infinity); },
      reset() { samples = []; }
    };
  }

  /// Playback speed: a little faster while further behind than the decoder
  /// needs, normal once close.
  function catchUpRate(behind, floor, currentRate) {
    const extra = behind - (Number.isFinite(floor) ? floor : 0);
    if (extra > CATCH_UP_ABOVE) return CATCH_UP_RATE;
    if (extra < CATCH_UP_UNTIL) return 1;
    return currentRate;
  }

  /// Every few frames, and at once for a stream that started over.
  function shouldAcknowledge(seq, lastAck) {
    return seq < lastAck || seq - lastAck >= ACK_EVERY;
  }

  /// Drives a <video> element from stream messages. `send` replies to the
  /// phone on the video namespace; `onLive(isLive)` reports whether the
  /// stream is showing so the receiver can hide its scoreboard.
  function createPlayer(video, send, onLive) {
    const assemble = createAssembler(base64ToBytes);
    let mediaSource = null;
    let sourceBuffer = null;
    let objectUrl = null;
    let queue = [];
    /// The stream's opening ({ codec, bytes }): a new player starts from it.
    let opening = null;
    let needKey = true;
    let lastHeardAt = 0;
    let live = false;
    let gaveUp = false;
    let received = 0;
    let lastAck = 0;
    let askedForOpeningAt = 0;
    let recoveries = [];
    const floor = createFloor(FLOOR_WINDOW);

    function setLive(value) {
      if (live === value) return;
      live = value;
      onLive(value);
    }

    function teardown() {
      queue = [];
      sourceBuffer = null;
      if (!mediaSource) return;
      mediaSource = null;
      video.removeAttribute("src");
      try { video.load(); } catch (error) { /* ignore */ }
      if (objectUrl) { try { URL.revokeObjectURL(objectUrl); } catch (error) { /* ignore */ } }
      objectUrl = null;
    }

    function forgetStream() {
      teardown();
      opening = null;
      needKey = true;
      lastAck = 0;
      askedForOpeningAt = 0;
      setLive(false);
    }

    /// A fresh player for the stream's opening; frames wait for its keyframe.
    function open(stream) {
      teardown();
      floor.reset();
      needKey = true;
      const type = 'video/mp4; codecs="' + stream.codec + '"';
      if (!window.MediaSource || !MediaSource.isTypeSupported(type)) {
        gaveUp = true;
        send({ t: "unsupported", codec: stream.codec });
        return;
      }
      const source = new MediaSource();
      mediaSource = source;
      queue.push({ opening: true, bytes: stream.bytes });
      source.addEventListener("sourceopen", () => {
        if (mediaSource !== source) return;
        try {
          const buffer = source.addSourceBuffer(type);
          buffer.mode = "segments";
          buffer.addEventListener("updateend", () => { keepLive(); pump(); });
          buffer.addEventListener("error", () => { if (sourceBuffer === buffer) recover(); });
          sourceBuffer = buffer;
          pump();
        } catch (error) {
          gaveUp = true;
          send({ t: "unsupported", codec: stream.codec });
        }
      }, { once: true });
      objectUrl = URL.createObjectURL(source);
      video.src = objectUrl;
    }

    /// The player failed (usually a frame that didn't decode): start a new
    /// one from the opening and wait for the next keyframe.
    function recover() {
      if (!opening || gaveUp) return;
      const now = Date.now();
      recoveries = recoveries.filter((at) => now - at < 10000).concat(now);
      if (recoveries.length > MAX_RECOVERIES) {
        gaveUp = true;
        teardown();
        setLive(false);
        send({ t: "unsupported", codec: opening.codec });
        return;
      }
      open(opening);
      send({ t: "need-key" });
    }

    function dropQueuedFrames() {
      queue = queue.filter((item) => item.opening);
    }

    function pump() {
      if (!sourceBuffer || sourceBuffer.updating || queue.length === 0) return;
      const item = queue.shift();
      try {
        sourceBuffer.appendBuffer(item.bytes);
      } catch (error) {
        if (error && error.name === "QuotaExceededError") {
          // Full: drop what has played and carry on from the next keyframe.
          trim(true);
          dropQueuedFrames();
          needKey = true;
          send({ t: "need-key" });
        } else {
          recover();
        }
      }
    }

    function trim(force) {
      if (!sourceBuffer || sourceBuffer.updating || video.buffered.length === 0) return;
      const start = video.buffered.start(0);
      const keepFrom = video.currentTime - 4;
      if (keepFrom - start > (force ? 0.5 : 8)) {
        try { sourceBuffer.remove(start, keepFrom); } catch (error) { /* ignore */ }
      }
    }

    function keepLive() {
      const ranges = video.buffered;
      if (!ranges || ranges.length === 0) return;
      const last = ranges.length - 1;
      const start = ranges.start(last);
      const end = ranges.end(last);
      const target = liveSeekTarget(video.currentTime, start, end);
      if (target !== null) {
        video.playbackRate = 1;
        video.currentTime = target;
        floor.reset();
      } else {
        const behind = end - video.currentTime;
        floor.add(Date.now() / 1000, behind);
        const rate = catchUpRate(behind, floor.value, video.playbackRate);
        if (rate !== video.playbackRate) video.playbackRate = rate;
      }
      if (video.paused) { const played = video.play(); if (played && played.catch) played.catch(() => {}); }
      trim(false);
    }

    function handle(message) {
      if (!message || typeof message !== "object") return;
      if (message.t === "hello") {
        // The phone is starting (again): whatever it sent before is over.
        forgetStream();
        gaveUp = false;
        recoveries = [];
        const supported = !!(window.MediaSource && MediaSource.isTypeSupported('video/mp4; codecs="avc1.4D001F"'));
        send({ t: "ready", video: supported ? 1 : 0 });
        return;
      }
      if (message.t === "stop") { forgetStream(); return; }
      if (message.t === "alive") { lastHeardAt = Date.now(); return; }
      if (gaveUp) return;
      const complete = assemble(message);
      if (!complete) return;
      const first = complete.message;
      if (first.t === "init") {
        opening = { codec: first.codec || "avc1.4D001F", bytes: complete.bytes };
        open(opening);
        return;
      }
      if (first.t !== "frag") return;
      lastHeardAt = Date.now();
      received += 1;
      // Acknowledge what arrived, playable or not: it tells the phone how
      // far behind the TV is.
      if (shouldAcknowledge(first.seq, lastAck)) { lastAck = first.seq; send({ t: "ack", seq: first.seq }); }
      if (!opening) {
        // Joined mid-stream: ask for the opening, at most once a second.
        if (Date.now() - askedForOpeningAt > 1000) { askedForOpeningAt = Date.now(); send({ t: "need-init" }); }
        return;
      }
      if (needKey && first.key !== 1) return;
      needKey = false;
      queue.push({ opening: false, bytes: complete.bytes });
      if (queue.length > 45) { dropQueuedFrames(); needKey = true; send({ t: "need-key" }); return; }
      pump();
      setLive(true);
    }

    // Only the current player's failure: a replaced one may report late.
    video.addEventListener("error", () => { if (video.error && mediaSource) recover(); });
    const upkeep = setInterval(() => {
      if (live && Date.now() - lastHeardAt > STALL_SECONDS * 1000) setLive(false);
      if (live) keepLive();
    }, 250);
    if (upkeep && upkeep.unref) upkeep.unref();

    return {
      handle,
      get stats() { return { received, live, queued: queue.length, gaveUp }; }
    };
  }

  return {
    NAMESPACE, LIVE_EDGE, MAX_BEHIND, CATCH_UP_ABOVE, CATCH_UP_UNTIL, CATCH_UP_RATE, ACK_EVERY,
    createAssembler, base64ToBytes, liveSeekTarget, createFloor, catchUpRate, shouldAcknowledge, createPlayer
  };
});
