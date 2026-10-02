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
  /// Reported to the phone so its log says which receiver the TV loaded.
  const VERSION = "28";
  /// How often the receiver tells the phone what it sees (milliseconds).
  const STATS_EVERY = 3000;
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
  function liveSeekTarget(currentTime, start, end, maxBehind) {
    if (!(end > start)) return null;
    const limit = maxBehind > 0 ? maxBehind : MAX_BEHIND;
    if (currentTime >= start && end - currentTime <= limit) return null;
    return Math.max(start, end - LIVE_EDGE);
  }

  /// Playback policy. The phone (or a test bench) can override these in
  /// hello's `x` while the right values for each Chromecast are worked out.
  const DEFAULT_POLICY = { manage: 1, seek: 1, rate: 1, maxBehind: MAX_BEHIND, cushion: 0, cooldown: 0 };

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

  function round(value) { return Math.round(value * 1000) / 1000; }

  /// Drives a <video> element from stream messages. `send` replies to the
  /// phone on the video namespace; `onLive(isLive)` reports whether the
  /// stream is showing so the receiver can hide its scoreboard;
  /// `onStatus(text)`, when a TestFlight phone asks for it, shows the
  /// player's counters on the TV.
  function createPlayer(video, send, onLive, onStatus) {
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
    let appended = 0;
    let waitingForKey = 0;
    let lastError = "";
    let lastErrorSentAt = 0;
    let lastStatsAt = 0;
    let debug = false;
    let policy = Object.assign({}, DEFAULT_POLICY);
    let started = false;
    let seeks = 0;
    let lastSeekAt = 0;

    /// Tells the phone what went wrong (at most twice a second).
    function report(where, error) {
      const message = error && error.name ? error.name + ": " + (error.message || "") : String(error);
      lastError = where + " " + message;
      if (Date.now() - lastErrorSentAt < 500) return;
      lastErrorSentAt = Date.now();
      send({ t: "error", where, message: message.slice(0, 200) });
    }

    function snapshot() {
      const ranges = video.buffered;
      const end = ranges && ranges.length ? ranges.end(ranges.length - 1) : 0;
      const quality = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
      return {
        rx: received, app: appended, wait: waitingForKey, q: queue.length,
        open: opening ? 1 : 0, ms: mediaSource ? mediaSource.readyState : "none", sb: sourceBuffer ? 1 : 0,
        rs: video.readyState, ct: round(video.currentTime || 0), behind: round(end - (video.currentTime || 0)),
        live: live ? 1 : 0, rate: video.playbackRate, dec: quality ? quality.totalVideoFrames : -1,
        lost: quality ? quality.droppedVideoFrames : -1, rec: recoveries.length, err: lastError,
        sk: seeks, pz: video.paused ? 1 : 0, sg: video.seeking ? 1 : 0, buf: ranges ? ranges.length : 0,
        st: ranges && ranges.length ? round(ranges.start(ranges.length - 1)) : 0, go: started ? 1 : 0
      };
    }

    function shareStatus() {
      if (!received && !opening && !lastError) return;
      const stats = snapshot();
      if (debug && onStatus) {
        onStatus("TV " + VERSION + " · frames " + stats.rx + " in, " + stats.app + " played · " +
          (stats.live ? "live" : "not live") + " · behind " + stats.behind.toFixed(2) + " s · decoded " + stats.dec +
          (stats.err ? " · " + stats.err : ""));
      }
      if (Date.now() - lastStatsAt >= STATS_EVERY) {
        lastStatsAt = Date.now();
        send(Object.assign({ t: "stats" }, stats));
      }
    }

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
      started = false;
      needKey = true;
      const type = 'video/mp4; codecs="' + stream.codec + '"';
      if (!window.MediaSource || !MediaSource.isTypeSupported(type)) {
        gaveUp = true;
        send({ t: "unsupported", codec: stream.codec, reason: "type not supported" });
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
          buffer.addEventListener("error", () => {
            if (sourceBuffer !== buffer) return;
            report("sourceBuffer", "error event");
            recover();
          });
          sourceBuffer = buffer;
          pump();
        } catch (error) {
          report("addSourceBuffer", error);
          gaveUp = true;
          send({ t: "unsupported", codec: stream.codec, reason: "addSourceBuffer failed" });
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
        send({ t: "unsupported", codec: opening.codec, reason: "player kept failing: " + lastError });
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
        if (!item.opening) appended += 1;
      } catch (error) {
        report("append", error);
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
      // Some players need a little picture in hand before they start.
      if (!started && end - start < policy.cushion) return;
      if (policy.manage) {
        const target = policy.seek ? liveSeekTarget(video.currentTime, start, end, policy.maxBehind) : null;
        if (target !== null && Date.now() - lastSeekAt >= policy.cooldown * 1000) {
          lastSeekAt = Date.now();
          seeks += 1;
          video.playbackRate = 1;
          video.currentTime = target;
          floor.reset();
        } else if (policy.rate) {
          const behind = end - video.currentTime;
          floor.add(Date.now() / 1000, behind);
          const rate = catchUpRate(behind, floor.value, video.playbackRate);
          if (rate !== video.playbackRate) video.playbackRate = rate;
        }
      }
      if (video.paused) {
        const played = video.play();
        if (played && played.catch) played.catch((error) => report("play", error));
      }
      trim(false);
    }

    function handle(message) {
      if (!message || typeof message !== "object") return;
      if (message.t === "hello") {
        // The phone is starting (again): whatever it sent before is over.
        forgetStream();
        gaveUp = false;
        recoveries = [];
        debug = message.debug === 1;
        policy = Object.assign({}, DEFAULT_POLICY, message.x && typeof message.x === "object" ? message.x : {});
        const supported = !!(window.MediaSource && MediaSource.isTypeSupported('video/mp4; codecs="avc1.4D001F"'));
        const agent = typeof navigator === "object" && navigator.userAgent ? navigator.userAgent.slice(0, 160) : "";
        send({ t: "ready", video: supported ? 1 : 0, version: VERSION, ua: agent });
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
      if (needKey && first.key !== 1) { waitingForKey += 1; return; }
      needKey = false;
      queue.push({ opening: false, bytes: complete.bytes });
      if (queue.length > 45) { dropQueuedFrames(); needKey = true; send({ t: "need-key" }); return; }
      pump();
      setLive(true);
    }

    video.addEventListener("playing", () => { started = true; });
    // Only the current player's failure: a replaced one may report late.
    video.addEventListener("error", () => {
      if (!video.error || !mediaSource) return;
      report("video", "code " + video.error.code + " " + (video.error.message || ""));
      recover();
    });
    let ticks = 0;
    const upkeep = setInterval(() => {
      if (live && Date.now() - lastHeardAt > STALL_SECONDS * 1000) setLive(false);
      if (live) keepLive();
      ticks += 1;
      if (ticks % 4 === 0) shareStatus();
    }, 250);
    if (upkeep && upkeep.unref) upkeep.unref();

    return {
      handle,
      report,
      get stats() { return { received, live, queued: queue.length, gaveUp, appended }; }
    };
  }

  return {
    NAMESPACE, VERSION, LIVE_EDGE, MAX_BEHIND, CATCH_UP_ABOVE, CATCH_UP_UNTIL, CATCH_UP_RATE, ACK_EVERY,
    createAssembler, base64ToBytes, liveSeekTarget, createFloor, catchUpRate, shouldAcknowledge, createPlayer
  };
});
