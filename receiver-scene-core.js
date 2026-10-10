(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RallycadeSceneCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // The phone draws the stadium into a 1280 x 720 stage and sends each moment
  // as drawing commands (SlipSpark/Services/CastScene/StadiumSceneRecorder.swift).
  // Coordinates are tenths of a stage point, matrices' linear parts
  // ten-thousandths, opacities thousandths: all whole numbers, so two frames
  // of the same shapes blend number by number.
  const STAGE = { width: 1280, height: 720 };
  const OPS = new Set(["f", "s", "i", "t", "L", "l"]);
  // Fields that name things rather than measure them: never blended, and a
  // difference means the frames are not the same shapes.
  const DISCRETE = {
    f: [2, 3, 6, 7, 8],
    s: [2, 3, 9, 10],
    i: [2, 3, 5, 6],
    t: [2, 3, 5, 6, 10],
    L: [2, 3, 4],
    l: []
  };
  // Frames further apart than this are not blended: something happened between.
  const MAX_BLEND_GAP = 120;
  // Frames kept behind the one on screen, and the most queued ahead.
  const MAX_QUEUE = 90;

  function isArray(value) { return Array.isArray(value); }

  // A frame from the phone: `s` its moment (phone milliseconds), `o` the
  // commands, `fl` filter lists, `cl` clip lists, `h` the HUD when it changed.
  function normalizeFrame(raw) {
    if (!raw || typeof raw !== "object" || !Number.isFinite(Number(raw.s)) || !isArray(raw.o)) return null;
    const ops = raw.o.filter((op) => isArray(op) && OPS.has(op[0]));
    return {
      s: Number(raw.s),
      o: ops,
      fl: isArray(raw.fl) ? raw.fl : [],
      cl: isArray(raw.cl) ? raw.cl : [],
      h: raw.h && typeof raw.h === "object" ? raw.h : null
    };
  }

  // The frame's shapes without their measurements: two frames with the same
  // key differ only in numbers, so they can be blended.
  function shapeKey(frame) {
    if (frame.__shape) return frame.__shape;
    const parts = [];
    const walk = (value) => {
      if (isArray(value)) {
        parts.push("[" + value.length);
        for (let index = 0; index < value.length; index += 1) walk(value[index]);
        parts.push("]");
      } else if (typeof value === "string") {
        parts.push("'" + value);
      } else {
        parts.push("#");
      }
    };
    for (const op of frame.o) {
      const discrete = DISCRETE[op[0]] || [];
      parts.push("<" + op[0] + op.length);
      for (let index = 1; index < op.length; index += 1) {
        if (discrete.indexOf(index) >= 0 && !isArray(op[index])) parts.push("=" + op[index]);
        else if (op[0] === "s" && index === 6 && isArray(op[6])) parts.push("g" + op[6].length + ":" + op[6][1] + ":" + op[6][2]);
        else walk(op[index]);
      }
    }
    parts.push("|fl");
    walk(frame.fl);
    parts.push("|cl");
    for (const clip of frame.cl) {
      if (!isArray(clip)) { parts.push("?"); continue; }
      parts.push("{" + clip.length);
      for (const entry of clip) {
        if (isArray(entry)) { parts.push(String(entry[0]) + ":" + (isArray(entry[1]) ? entry[1].length : 0) + ":" + entry[2]); }
      }
    }
    frame.__shape = parts.join("");
    return frame.__shape;
  }

  function blendValue(a, b, u) {
    if (typeof a === "number" && typeof b === "number") return a + (b - a) * u;
    if (isArray(a) && isArray(b)) {
      const out = new Array(a.length);
      for (let index = 0; index < a.length; index += 1) out[index] = blendValue(a[index], b[index], u);
      return out;
    }
    return a;
  }

  // The moment between two frames of the same shapes, `u` of the way from a to b.
  function blendFrames(a, b, u) {
    const ops = new Array(a.o.length);
    for (let index = 0; index < a.o.length; index += 1) {
      const opA = a.o[index];
      const opB = b.o[index];
      const discrete = DISCRETE[opA[0]] || [];
      const op = new Array(opA.length);
      op[0] = opA[0];
      for (let field = 1; field < opA.length; field += 1) {
        op[field] = discrete.indexOf(field) >= 0 ? opA[field] : blendValue(opA[field], opB[field], u);
      }
      ops[index] = op;
    }
    return { s: a.s + (b.s - a.s) * u, o: ops, fl: blendValue(a.fl, b.fl, u), cl: blendValue(a.cl, b.cl, u), h: null };
  }

  // Blends `a` toward `b` into `out`, a frame of the same shapes from
  // `cloneFrame`. Drawing thirty blended frames a second as new arrays kept
  // the Chromecast's garbage collector busy, and each collection cost a
  // frame (build 121: ~26 a 15 s innings stretch, up to 13 ms each).
  function blendInto(out, a, b, u) {
    for (let index = 0; index < a.length; index += 1) {
      const x = a[index];
      const y = b[index];
      if (typeof x === "number" && typeof y === "number") out[index] = x + (y - x) * u;
      else if (isArray(x) && isArray(y) && isArray(out[index])) blendInto(out[index], x, y, u);
      else out[index] = x;
    }
  }

  function cloneValue(value) {
    return isArray(value) ? value.map(cloneValue) : value;
  }

  function cloneFrame(frame) {
    return { s: frame.s, o: frame.o.map(cloneValue), fl: cloneValue(frame.fl), cl: cloneValue(frame.cl), h: null };
  }

  function blendFramesInto(out, a, b, u) {
    for (let index = 0; index < a.o.length; index += 1) {
      const opA = a.o[index];
      const opB = b.o[index];
      const op = out.o[index];
      const discrete = DISCRETE[opA[0]] || [];
      op[0] = opA[0];
      for (let field = 1; field < opA.length; field += 1) {
        const x = opA[field];
        if (discrete.indexOf(field) >= 0) op[field] = x;
        else if (typeof x === "number") op[field] = x + (opB[field] - x) * u;
        else if (isArray(x) && isArray(op[field])) blendInto(op[field], x, opB[field], u);
        else op[field] = x;
      }
    }
    out.s = a.s + (b.s - a.s) * u;
    blendInto(out.fl, a.fl, b.fl, u);
    blendInto(out.cl, a.cl, b.cl, u);
    return out;
  }

  // The frames on their way to the screen, by moment. A redraw (a newer
  // epoch) replaces everything from its first moment on, and frames of an
  // older epoch still arriving are dropped.
  function createTimeline() {
    let frames = [];
    let epoch = 0;
    // The blended frame `at` hands out, reused while the shapes stay the same.
    let scratch = null;
    let scratchShape = null;
    // The HUD changes waiting for their moment, oldest first.
    let huds = [];

    function insert(frame) {
      let index = frames.length;
      while (index > 0 && frames[index - 1].s > frame.s) index -= 1;
      if (index > 0 && frames[index - 1].s === frame.s) frames[index - 1] = frame;
      else frames.splice(index, 0, frame);
      if (frame.h) {
        huds = huds.filter((entry) => entry.s !== frame.s);
        huds.push({ s: frame.s, h: frame.h });
        huds.sort((x, y) => x.s - y.s);
      }
      if (frames.length > MAX_QUEUE) frames = frames.slice(frames.length - MAX_QUEUE);
    }

    return {
      get epoch() { return epoch; },
      get length() { return frames.length; },
      get newest() { return frames.length ? frames[frames.length - 1] : null; },

      // One frame ("f"): ignored when an older epoch's.
      add(rawFrame, frameEpoch) {
        const frame = normalizeFrame(rawFrame);
        if (!frame) return null;
        const e = Number(frameEpoch) || 0;
        if (e < epoch) return null;
        epoch = e;
        insert(frame);
        return frame;
      },

      // A redraw ("fs"): its frames replace those from its first moment on.
      replace(rawFrames, frameEpoch) {
        const e = Number(frameEpoch) || 0;
        if (e < epoch || !isArray(rawFrames)) return [];
        epoch = e;
        const incoming = rawFrames.map(normalizeFrame).filter(Boolean).sort((x, y) => x.s - y.s);
        if (!incoming.length) return [];
        const from = incoming[0].s;
        frames = frames.filter((frame) => frame.s < from);
        huds = huds.filter((entry) => entry.s < from);
        incoming.forEach(insert);
        return incoming;
      },

      // What to draw at phone moment `now`: the frame due, blended toward
      // the next when they are the same shapes. Frames before the one due
      // are let go.
      at(now) {
        let due = -1;
        for (let index = 0; index < frames.length; index += 1) {
          if (frames[index].s <= now) due = index; else break;
        }
        if (due < 0) return null;
        if (due > 0) frames = frames.slice(due);
        const a = frames[0];
        const b = frames[1];
        if (b && b.s - a.s <= MAX_BLEND_GAP && shapeKey(a) === shapeKey(b)) {
          const u = Math.min(1, Math.max(0, (now - a.s) / (b.s - a.s)));
          if (u <= 0) return { frame: a, stamp: a.s, blended: false };
          if (scratchShape !== shapeKey(a)) { scratch = cloneFrame(a); scratchShape = shapeKey(a); }
          return { frame: blendFramesInto(scratch, a, b, u), stamp: a.s, blended: true };
        }
        return { frame: a, stamp: a.s, blended: false };
      },

      // The newest HUD due at `now`, once; null when nothing new.
      hudAt(now) {
        let latest = null;
        while (huds.length && huds[0].s <= now) latest = huds.shift().h;
        return latest;
      },

      clear() { frames = []; huds = []; },

      // A new phone (or the same one, started again) counts epochs afresh.
      reset() { frames = []; huds = []; epoch = 0; }
    };
  }

  // Maps the phone's moments to this TV's clock. The phone measures the
  // offset (this clock minus its own) from round trips and sends it; until
  // then, a frame is shown as soon as it arrives.
  function createClock() {
    let offset = null;
    let provisional = null;
    return {
      get synced() { return offset !== null; },
      get offset() { return offset !== null ? offset : provisional; },
      set(value) { if (Number.isFinite(Number(value))) offset = Number(value); },
      // A frame arrived at local `local` for phone moment `stamp`.
      noteArrival(stamp, local) {
        if (offset === null && provisional === null) provisional = local - stamp;
      },
      phoneNow(local) {
        const o = offset !== null ? offset : provisional;
        return o === null ? null : local - o;
      },
      reset() { offset = null; provisional = null; }
    };
  }

  // The p-th percentile (0..1) of a list of numbers.
  function percentile(values, p) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  }

  // MARK: Pictures

  // A named picture's key ends in its size on the phone ("bowler-3-119x301"),
  // and the phone's matrices map that many pixels onto the stage. The TV
  // draws whatever file it has into that rect, so a sharper copy of the same
  // art (more pixels) lands in the same place. Keys without a size (pictures
  // known by a hash of their pixels) are drawn at the file's own size.
  function pictureSize(key) {
    const match = /-(\d+)x(\d+)$/.exec(String(key == null ? "" : key));
    if (!match) return null;
    const width = Number(match[1]), height = Number(match[2]);
    return width > 0 && height > 0 ? { width, height } : null;
  }

  // MARK: Canvas size

  // How wide the canvas is drawn. A Chromecast Ultra rasterises the canvas
  // in software: 13–15 frames a second at 1920 x 1080, 25–30 at 1280 x 720.
  // Devices running Android TV (the Google TV Streamer, Chromecast with
  // Google TV 4K and HD, TVs with Cast built in) start at 1920 and drop to
  // 1280 for good if they can't keep `minFps`; the Linux Cast dongles
  // (Chromecast 1st–3rd generation, Ultra) stay at 1280 and never try.
  const CANVAS = { wide: 1920, narrow: 1280, minFps: 25 };

  // `device`: `ua` (navigator.userAgent), `pinned` (a width the phone or the
  // bench asked for in `hello`), `wide` (the phone's hello allows 1920: build
  // 134 on), `remembered` (what this TV found last time: `{ua, width}`).
  // Returns the most pixels across, whether to keep watching the frame
  // rate, and why (sent in `stats`). Phones that don't allow it (the App
  // Store's 2.6) keep the 1280 canvas they were released with.
  function canvasPlan(device) {
    const ua = String((device && device.ua) || "");
    const pinned = Number(device && device.pinned);
    if (pinned >= 320) return { width: Math.min(CANVAS.wide, Math.round(pinned)), adaptive: false, why: "asked" };
    if (!(device && device.wide)) return { width: CANVAS.narrow, adaptive: false, why: "phone" };
    const remembered = device && device.remembered;
    if (remembered && remembered.ua === ua && Number(remembered.width) <= CANVAS.narrow) {
      return { width: CANVAS.narrow, adaptive: false, why: "slow-before" };
    }
    if (/Android|GoogleTV|Google TV/i.test(ua)) return { width: CANVAS.wide, adaptive: true, why: "tv" };
    return { width: CANVAS.narrow, adaptive: false, why: "dongle" };
  }

  // The canvas's width for a stage box `box` CSS pixels wide: the screen's
  // own pixels, at most `max`, never more than the screen has.
  function canvasWidth(box, pixelRatio, max) {
    const ratio = Math.min(Number(pixelRatio) || 1, 2);
    return Math.max(1, Math.round(Math.min(max, (Number(box) || 0) * ratio)));
  }

  // Watches a wide canvas's frame rate: how long from each animation frame
  // that drew to the next frame. `tick(now, drew)` once per animation frame
  // while the stadium is on; it answers true when `strikes` batches in a row
  // had a median slower than `minFps`. A gap over a second (the stadium
  // waiting, a hidden page) is no measure of drawing and is skipped.
  function createRateWatch(options) {
    const batch = (options && options.batch) || 20;
    const strikesToDrop = (options && options.strikes) || 2;
    const slowest = 1000 / ((options && options.minFps) || CANVAS.minFps);
    let samples = [];
    let strikes = 0;
    let lastDrew = null;
    return {
      get strikes() { return strikes; },
      tick(now, drew) {
        if (lastDrew !== null && now - lastDrew < 1000) samples.push(now - lastDrew);
        lastDrew = drew ? now : null;
        if (samples.length < batch) return false;
        strikes = percentile(samples, 0.5) > slowest ? strikes + 1 : 0;
        samples = [];
        return strikes >= strikesToDrop;
      },
      reset() { samples = []; strikes = 0; lastDrew = null; }
    };
  }

  // Path commands and their points (tenths) to drawing calls, given a target
  // with moveTo/lineTo/quadraticCurveTo/bezierCurveTo/closePath (Path2D).
  function tracePath(target, commands, points) {
    let p = 0;
    const v = (index) => points[index] / 10;
    for (let index = 0; index < commands.length; index += 1) {
      switch (commands[index]) {
        case "M": target.moveTo(v(p), v(p + 1)); p += 2; break;
        case "L": target.lineTo(v(p), v(p + 1)); p += 2; break;
        case "Q": target.quadraticCurveTo(v(p), v(p + 1), v(p + 2), v(p + 3)); p += 4; break;
        case "C": target.bezierCurveTo(v(p), v(p + 1), v(p + 2), v(p + 3), v(p + 4), v(p + 5)); p += 6; break;
        case "Z": target.closePath(); break;
        default: break;
      }
    }
    return target;
  }

  function cssColor(color, multiply) {
    if (!isArray(color)) return "rgba(0,0,0,0)";
    let r = color[0], g = color[1], b = color[2], a = color[3] / 1000;
    if (multiply) {
      r = r * multiply[0] / 255; g = g * multiply[1] / 255; b = b * multiply[2] / 255; a *= multiply[3] / 1000;
    }
    return "rgba(" + Math.round(r) + "," + Math.round(g) + "," + Math.round(b) + "," + Math.max(0, Math.min(1, a)).toFixed(3) + ")";
  }

  return {
    STAGE, MAX_BLEND_GAP, CANVAS, normalizeFrame, shapeKey, blendFrames, blendFramesInto, cloneFrame, createTimeline, createClock,
    percentile, tracePath, cssColor, pictureSize, canvasPlan, canvasWidth, createRateWatch
  };
});
