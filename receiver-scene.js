(function () {
  "use strict";

  // The stadium, drawn here from the phone's drawing commands (see
  // receiver-scene-core.js and docs/design/CAST_SCENE.md). Nothing about the
  // phone's screen is recorded: the TV draws each moment itself, on a clock
  // synced to the phone's, and lays the HUD over it.
  const NAMESPACE = "urn:x-cast:com.slipspark.scene";
  const VERSION = "scene-1";
  const core = window.RallycadeSceneCore;
  // Drawing commands are on the phone's 1280 x 720 stage; the HUD is laid
  // out on a 1920 x 1080 one, as the AirPlay TV's stadium is.
  const STAGE = core.STAGE;
  const HUD_STAGE = { width: 1920, height: 1080 };
  const CAPS = ["butt", "round", "square"];
  const JOINS = ["miter", "round", "bevel"];
  const ROUNDED = '"Nunito", "Varela Round", "Google Sans", sans-serif';
  const PLAIN = 'Inter, "Google Sans", system-ui, sans-serif';

  function createScene(options) {
    const root = options.root;
    const canvas = options.canvas;
    const hud = options.hud;
    const send = options.send;
    const ctx = canvas.getContext("2d");
    // The opaque photo a frame starts from (the stadium, or the replay's
    // outfield) sits behind the canvas as an image the TV's GPU composites:
    // the Chromecast's canvas is drawn in software and can't fill the screen
    // with a photo thirty times a second. Anything it hides isn't drawn.
    const backdrop = options.backdrop;
    let backdropKey = null;
    let backdropTransform = "";
    const timeline = core.createTimeline();
    const clock = core.createClock();
    const images = new Map();
    const tinted = new Map();
    const uploads = new Map();
    const wanted = new Set();
    const requested = new Set();
    const layers = [];
    let on = false;
    let debug = false;
    let scale = 1;
    let lastStamp = null;
    // The canvas's most pixels across: the Chromecast's software raster
    // can't fill 1920 x 1080 thirty times a second. The phone can set it.
    let maxCanvasWidth = 1280;
    let smoothing = "low";
    let lastLoop = 0;
    // A picture arrived or the screen changed size: draw the frame again.
    let needsRedraw = false;
    let lastAck = 0;
    let lastStats = 0;
    let lastNeed = 0;
    let readyToAnswer = false;
    let pendingHello = false;
    const counters = { draws: 0, blended: 0, frames: 0, late: [], drawMs: [], missing: 0, redraws: 0, gaps: [] };

    // MARK: Sizing

    function resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.round(Math.min(maxCanvasWidth, window.innerWidth * ratio));
      const height = Math.round(width * STAGE.height / STAGE.width);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        layers.length = 0;
        needsRedraw = true;
        backdropTransform = "";
      }
      scale = canvas.width / STAGE.width;
      const stageScale = Math.min(window.innerWidth / HUD_STAGE.width, window.innerHeight / HUD_STAGE.height);
      hud.style.transform = "scale(" + stageScale + ")";
    }
    window.addEventListener("resize", resize);
    resize();

    // MARK: Images

    // Pictures by key: drawn (`images`), on their way (`loading`), and where
    // each can come from: the receiver's own copies (exported from the app),
    // this TV's cache of pictures sent by an earlier cast, or the phone.
    const bundled = new Map();
    const cached = new Set();
    const loading = new Set();

    function addImage(key, source) {
      images.set(key, source);
      needsRedraw = true;
      loading.delete(key);
      wanted.delete(key);
      requested.delete(key);
    }

    function loadImage(url) {
      return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("image " + url));
        image.src = url;
      });
    }

    function loadBundled() {
      return fetch("scene-images/manifest.json").then((response) => response.ok ? response.json() : { images: {} })
        .then((manifest) => {
          Object.entries((manifest && manifest.images) || {}).forEach(([key, file]) => {
            bundled.set(key, file);
            if (/\.jpe?g$/i.test(file)) opaque.add(key);
          });
        }).catch(() => {});
    }

    let database = null;
    function openCache() {
      return new Promise((resolve) => {
        if (!window.indexedDB) { resolve(); return; }
        let request;
        try { request = window.indexedDB.open("rallycade-scene", 1); } catch (error) { resolve(); return; }
        request.onupgradeneeded = () => request.result.createObjectStore("images");
        request.onerror = () => resolve();
        request.onsuccess = () => {
          database = request.result;
          try {
            const keys = database.transaction("images", "readonly").objectStore("images").getAllKeys();
            keys.onsuccess = () => { (keys.result || []).forEach((key) => cached.add(String(key))); resolve(); };
            keys.onerror = () => resolve();
          } catch (error) { resolve(); }
        };
      });
    }

    function cacheImage(key, blob) {
      if (!database) return;
      try {
        database.transaction("images", "readwrite").objectStore("images").put(blob, key);
        cached.add(key);
      } catch (error) { /* full: the phone sends it again next time */ }
    }

    function loadCached(key) {
      return new Promise((resolve, reject) => {
        try {
          const read = database.transaction("images", "readonly").objectStore("images").get(key);
          read.onsuccess = () => read.result ? resolve(URL.createObjectURL(read.result)) : reject(new Error("gone"));
          read.onerror = () => reject(read.error);
        } catch (error) { reject(error); }
      });
    }

    // Starts fetching a picture a frame uses, from wherever it is.
    function ensure(key) {
      if (images.has(key) || loading.has(key) || requested.has(key)) return;
      const ask = () => { loading.delete(key); cached.delete(key); bundled.delete(key); wanted.add(key); };
      if (bundled.has(key)) {
        loading.add(key);
        loadImage("scene-images/" + bundled.get(key)).then((image) => addImage(key, image)).catch(ask);
      } else if (cached.has(key) && database) {
        loading.add(key);
        loadCached(key).then(loadImage).then((image) => addImage(key, image)).catch(ask);
      } else {
        wanted.add(key);
      }
    }

    // A frame arrives before it is due: its pictures can start loading now.
    function prefetch(frame) {
      for (const op of frame.o) if (op[0] === "i") ensure(op[3]);
    }

    function receivePart(message) {
      const key = String(message.k || "");
      if (!key) return;
      let upload = uploads.get(key);
      if (!upload) { upload = { type: message.type, of: message.of, parts: [], count: 0 }; uploads.set(key, upload); }
      if (upload.parts[message.n] == null) { upload.parts[message.n] = message.d; upload.count += 1; }
      if (upload.count < upload.of) return;
      uploads.delete(key);
      const data = upload.parts.join("");
      const bytes = atob(data);
      const array = new Uint8Array(bytes.length);
      for (let index = 0; index < bytes.length; index += 1) array[index] = bytes.charCodeAt(index);
      const blob = new Blob([array], { type: upload.type });
      if (upload.type === "image/jpeg") opaque.add(key);
      const url = URL.createObjectURL(blob);
      loadImage(url).then((image) => {
        addImage(key, image);
        cacheImage(key, blob);
        send({ t: "got", k: key });
      }).catch((error) => report("image", error));
    }

    // A picture with a colour multiplied in (`colorMultiply`), made once.
    function tint(key, image, color) {
      const id = key + ":" + color.join(",");
      let canvasTint = tinted.get(id);
      if (canvasTint) return canvasTint;
      canvasTint = document.createElement("canvas");
      canvasTint.width = image.naturalWidth || image.width;
      canvasTint.height = image.naturalHeight || image.height;
      const t = canvasTint.getContext("2d");
      t.drawImage(image, 0, 0);
      t.globalCompositeOperation = "multiply";
      t.fillStyle = core.cssColor([color[0], color[1], color[2], 1000]);
      t.fillRect(0, 0, canvasTint.width, canvasTint.height);
      t.globalCompositeOperation = "destination-in";
      t.drawImage(image, 0, 0);
      tinted.set(id, canvasTint);
      return canvasTint;
    }

    // MARK: Drawing

    // Pictures with no see-through pixels (JPEGs).
    const opaque = new Set();

    // The last top-level command that paints a whole opaque picture over the
    // stage, plainly: everything before it is hidden.
    function coverIndex(frame) {
      let depth = 0;
      let found = -1;
      for (let index = 0; index < frame.o.length; index += 1) {
        const op = frame.o[index];
        if (op[0] === "L") { depth += 1; continue; }
        if (op[0] === "l") { depth -= 1; continue; }
        if (depth || op[0] !== "i" || op[1] < 1000 || (op[2] && op[2] !== "source-over") || op[5] >= 0 || op[6] >= 0) continue;
        const image = images.get(op[3]);
        if (!image || !opaque.has(op[3])) continue;
        const m = op[4];
        if (m[1] !== 0 || m[2] !== 0 || m[0] <= 0 || m[3] <= 0) continue;
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        const left = m[4] / 10, top = m[5] / 10;
        const right = left + width * m[0] / 10000, bottom = top + height * m[3] / 10000;
        if (left <= 0.5 && top <= 0.5 && right >= STAGE.width - 0.5 && bottom >= STAGE.height - 0.5) found = index;
      }
      return found;
    }

    function showBackdrop(op) {
      if (!backdrop) return false;
      const image = images.get(op[3]);
      if (backdropKey !== op[3]) {
        backdropKey = op[3];
        backdrop.src = image.src;
      }
      // Stage points to the screen's CSS pixels.
      const css = window.innerWidth / STAGE.width;
      const m = op[4];
      const transform = "matrix(" + [m[0] / 10000 * css, 0, 0, m[3] / 10000 * css, m[4] / 10 * css, m[5] / 10 * css]
        .map((v) => v.toFixed(4)).join(",") + ")";
      if (transform !== backdropTransform) {
        backdropTransform = transform;
        backdrop.style.transform = transform;
      }
      backdrop.hidden = false;
      return true;
    }

    function layerCanvas(depth) {
      let layer = layers[depth];
      if (!layer || layer.width !== canvas.width || layer.height !== canvas.height) {
        layer = document.createElement("canvas");
        layer.width = canvas.width;
        layer.height = canvas.height;
        layers[depth] = layer;
      }
      const c = layer.getContext("2d");
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, layer.width, layer.height);
      return layer;
    }

    // Sets up a command's opacity, blending, filters and clip; returns the
    // colour any `colorMultiply` filter asks for.
    function begin(c, frame, alpha, blend, filterRef, clipRef) {
      c.save();
      if (clipRef >= 0 && frame.cl[clipRef]) {
        c.setTransform(scale, 0, 0, scale, 0, 0);
        for (const clip of frame.cl[clipRef]) {
          c.clip(core.tracePath(new Path2D(), clip[0], clip[1]), clip[2] ? "evenodd" : "nonzero");
        }
      }
      c.globalAlpha = Math.max(0, Math.min(1, alpha / 1000));
      c.globalCompositeOperation = blend || "source-over";
      let multiply = null;
      if (filterRef >= 0 && frame.fl[filterRef]) {
        const blurs = [];
        for (const filter of frame.fl[filterRef]) {
          if (filter[0] === "b") blurs.push("blur(" + (filter[1] / 10 * scale).toFixed(2) + "px)");
          if (filter[0] === "m") multiply = filter[1];
        }
        if (blurs.length) c.filter = blurs.join(" ");
      }
      return multiply;
    }

    function shading(c, value, multiply) {
      if (!Array.isArray(value)) return "rgba(0,0,0,0)";
      if (value[0] === "c") return core.cssColor(value[1], multiply);
      const p = value[1];
      const gradient = value[0] === "lg"
        ? c.createLinearGradient(p[0] / 10, p[1] / 10, p[2] / 10, p[3] / 10)
        : c.createRadialGradient(p[0] / 10, p[1] / 10, Math.max(0, p[2] / 10), p[0] / 10, p[1] / 10, Math.max(0.01, p[3] / 10));
      for (const stop of value[2] || []) {
        gradient.addColorStop(Math.max(0, Math.min(1, stop[0] / 1000)), core.cssColor(stop[1], multiply));
      }
      return gradient;
    }

    function drawFrame(frame) {
      const started = performance.now();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.filter = "none";
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = smoothing;
      const cover = coverIndex(frame);
      let from = 0;
      if (cover >= 0 && showBackdrop(frame.o[cover])) {
        from = cover + 1;
      } else if (backdrop) {
        backdrop.hidden = true;
      }
      const stack = [{ c: ctx }];
      let c = ctx;
      for (let index = from; index < frame.o.length; index += 1) {
        const op = frame.o[index];
        switch (op[0]) {
          case "L": {
            const layer = layerCanvas(stack.length);
            stack.push({ c: layer.getContext("2d"), layer, alpha: op[1], blend: op[2], filterRef: op[3], clipRef: op[4] });
            c = stack[stack.length - 1].c;
            break;
          }
          case "l": {
            if (stack.length < 2) break;
            const top = stack.pop();
            c = stack[stack.length - 1].c;
            begin(c, frame, top.alpha, top.blend, top.filterRef, top.clipRef);
            c.setTransform(1, 0, 0, 1, 0, 0);
            c.drawImage(top.layer, 0, 0);
            c.restore();
            break;
          }
          case "f": {
            const multiply = begin(c, frame, op[1], op[2], op[7], op[8]);
            c.setTransform(scale, 0, 0, scale, 0, 0);
            c.fillStyle = shading(c, op[5], multiply);
            c.fill(core.tracePath(new Path2D(), op[3], op[4]), op[6] ? "evenodd" : "nonzero");
            c.restore();
            break;
          }
          case "s": {
            const multiply = begin(c, frame, op[1], op[2], op[9], op[10]);
            c.setTransform(scale, 0, 0, scale, 0, 0);
            const geometry = op[6];
            c.lineWidth = Math.max(0.01, geometry[0] / 10);
            c.lineCap = CAPS[geometry[1]] || "butt";
            c.lineJoin = JOINS[geometry[2]] || "miter";
            c.miterLimit = Math.max(1, geometry[3] / 10);
            c.setLineDash((op[7] || []).map((d) => d / 10));
            c.lineDashOffset = (op[8] || 0) / 10;
            c.strokeStyle = shading(c, op[5], multiply);
            c.stroke(core.tracePath(new Path2D(), op[3], op[4]));
            c.restore();
            break;
          }
          case "i": {
            const key = op[3];
            const image = images.get(key);
            if (!image) { ensure(key); counters.missing += 1; break; }
            const multiply = begin(c, frame, op[1], op[2], op[5], op[6]);
            if (multiply) c.globalAlpha *= Math.max(0, Math.min(1, multiply[3] / 1000));
            const m = op[4];
            c.setTransform(scale * m[0] / 10000, scale * m[1] / 10000, scale * m[2] / 10000, scale * m[3] / 10000,
              scale * m[4] / 10, scale * m[5] / 10);
            c.drawImage(multiply ? tint(key, image, multiply) : image, 0, 0);
            c.restore();
            break;
          }
          case "t": {
            begin(c, frame, op[1], op[2], -1, op[10]);
            c.setTransform(scale, 0, 0, scale, 0, 0);
            c.font = op[5] + " " + (op[4] / 10).toFixed(1) + "px " + (op[6] ? ROUNDED : PLAIN);
            const anchor = op[9] || [500, 500];
            c.textAlign = anchor[0] < 250 ? "left" : anchor[0] > 750 ? "right" : "center";
            c.textBaseline = anchor[1] < 250 ? "top" : anchor[1] > 750 ? "bottom" : "middle";
            c.fillStyle = core.cssColor(op[7]);
            // Lines stack about the anchor as SwiftUI's resolved text does.
            const lines = String(op[3]).split("\n");
            const lineHeight = op[4] / 10 * 1.2;
            const lift = (lines.length - 1) * lineHeight * (anchor[1] / 1000);
            lines.forEach((line, index) => c.fillText(line, op[8][0] / 10, op[8][1] / 10 - lift + index * lineHeight));
            c.restore();
            break;
          }
          default: break;
        }
      }
      counters.drawMs.push(performance.now() - started);
      counters.draws += 1;
    }

    // MARK: HUD

    function el(id) { return hud.querySelector("#" + id); }
    function setText(id, value) { const node = el(id); if (node) node.textContent = value == null ? "" : String(value); }
    function show(id, visible) { const node = el(id); if (node) node.hidden = !visible; }

    const VERDICT = {
      perfect: "perfect", littleEarly: "little", littleLate: "little", early: "far", late: "far", noSwing: "none"
    };

    function renderHUD(h) {
      // Scorebug: runs for wickets and overs, or the timing check's ball.
      show("hud-score", !!h.score);
      show("hud-check", !!h.check);
      if (h.score) {
        setText("hud-runs", h.score.runs + "/" + h.score.wickets);
        setText("hud-overs", h.score.overs + " of " + h.score.of);
      }
      if (h.check) setText("hud-check-ball", "Ball " + h.check.ball + " of " + h.check.of);
      show("hud-friend", !!h.friend);
      setText("hud-friend", h.friend);
      // The status card hides while the pause or lost card is up.
      const status = h.status || {};
      el("hud-status").style.opacity = status.hidden ? "0" : "1";
      setText("hud-status-title", status.title);
      show("hud-status-detail", !!status.detail);
      setText("hud-status-detail", status.detail);
      // This over, or each timing-check ball's verdict.
      show("hud-over", !h.check);
      show("hud-verdicts", !!h.check);
      if (h.check) {
        const row = el("hud-verdict-dots");
        row.textContent = "";
        for (let index = 0; index < h.check.of; index += 1) {
          const dot = document.createElement("i");
          const verdict = h.check.verdicts[index];
          dot.className = "dot " + (verdict ? "verdict-" + (VERDICT[verdict] || "none") : "to-come");
          row.appendChild(dot);
        }
      } else {
        const dots = el("hud-over-dots").children;
        for (let index = 0; index < dots.length; index += 1) dots[index].classList.toggle("is-bowled", index < h.over);
      }
      show("hud-speed", !!h.speed);
      setText("hud-speed", h.speed);
      // Commentary.
      const caption = el("hud-caption");
      if (h.caption) {
        if (caption.dataset.line !== h.caption) {
          caption.dataset.line = h.caption;
          setText("hud-caption-text", h.caption);
          caption.classList.remove("is-in");
          void caption.offsetWidth;
          caption.classList.add("is-in");
        }
        caption.hidden = false;
      } else {
        caption.hidden = true;
        caption.dataset.line = "";
      }
      // The replay's timing card and fielding cue.
      const cards = h.cards;
      show("hud-cards", !!cards);
      if (cards) {
        el("hud-cards").classList.toggle("is-leading", !!cards.leading);
        setText("hud-timing", cards.timing);
        const cue = el("hud-cue");
        cue.hidden = !cards.cue;
        cue.style.opacity = String(cards.cueOpacity || 0);
        if (cards.cue) {
          setText("hud-cue-title", cards.cue.title);
          setText("hud-cue-direction", cards.cue.direction);
          setText("hud-cue-detail", cards.cue.detail);
        }
      }
      show("hud-moves", !!h.moves);
      setText("hud-moves", h.moves);
      // Paused, or the batter lost.
      const interruption = h.interruption;
      show("hud-interruption", !!interruption);
      if (interruption) {
        const card = el("hud-interruption");
        card.dataset.kind = interruption.kind;
        setText("hud-int-title", interruption.title);
        show("hud-int-instruction", !!interruption.instruction);
        setText("hud-int-instruction", interruption.instruction);
        setText("hud-int-detail", interruption.detail);
        show("hud-int-progress", interruption.progress != null);
        if (interruption.progress != null) el("hud-int-bar").style.width = Math.round(interruption.progress * 100) + "%";
      }
    }

    // MARK: Loop

    function frameLoop() {
      window.requestAnimationFrame(frameLoop);
      if (!on) return;
      const local = performance.now();
      if (lastLoop) counters.gaps.push(local - lastLoop);
      lastLoop = local;
      const phoneNow = clock.phoneNow(local);
      if (phoneNow == null) return;
      const result = timeline.at(phoneNow);
      // A frame already on screen is drawn again only while blending.
      if (result && (result.blended || result.stamp !== lastStamp || needsRedraw)) {
        drawFrame(result.frame);
        needsRedraw = false;
        if (result.blended) counters.blended += 1;
        lastStamp = result.stamp;
      }
      const h = timeline.hudAt(phoneNow);
      if (h) renderHUD(h);
      housekeeping(local);
    }

    function housekeeping(local) {
      if (local - lastAck >= 250) {
        lastAck = local;
        send({ t: "ack", s: lastStamp, q: timeline.length });
      }
      if (wanted.size && local - lastNeed >= 300) {
        lastNeed = local;
        const keys = Array.from(wanted).slice(0, 8);
        keys.forEach((key) => { wanted.delete(key); requested.add(key); });
        send({ t: "need", k: keys });
      }
      if (local - lastStats >= 2000) {
        const seconds = lastStats ? (local - lastStats) / 1000 : 2;
        lastStats = local;
        const stats = {
          t: "stats", fps: Math.round(counters.draws / seconds), blended: counters.blended,
          frames: counters.frames, redraws: counters.redraws,
          behind: Math.round(core.percentile(counters.late, 0.9)),
          drawMs: Number(core.percentile(counters.drawMs, 0.5).toFixed(1)),
          drawMax: Number(Math.max(0, ...counters.drawMs).toFixed(1)),
          missing: counters.missing, images: images.size, queue: timeline.length,
          synced: clock.synced ? 1 : 0, w: canvas.width,
          gap: Number(core.percentile(counters.gaps, 0.5).toFixed(1)),
          gap90: Number(core.percentile(counters.gaps, 0.9).toFixed(1))
        };
        send(stats);
        if (debug) setDebug(stats);
        counters.draws = 0; counters.blended = 0; counters.frames = 0; counters.redraws = 0;
        counters.late = []; counters.drawMs = []; counters.missing = 0; counters.gaps = [];
      }
    }

    let debugLine = null;
    function setDebug(stats) {
      if (!debugLine) {
        debugLine = document.createElement("div");
        debugLine.id = "scene-status";
        root.appendChild(debugLine);
      }
      debugLine.textContent = "scene " + stats.fps + " fps · draw " + stats.drawMs + "/" + stats.drawMax + " ms · late "
        + stats.behind + " ms · queue " + stats.queue + " · images " + stats.images + (stats.synced ? "" : " · not synced");
    }

    function noteArrival(frame) {
      prefetch(frame);
      const local = performance.now();
      clock.noteArrival(frame.s, local);
      const due = clock.offset == null ? local : frame.s + clock.offset;
      counters.late.push(Math.max(0, local - due));
      counters.frames += 1;
    }

    function setOn(value) {
      on = !!value;
      root.hidden = !on;
      document.body.dataset.scene = on ? "on" : "off";
      if (!on) timeline.clear();
    }

    function answerHello() {
      const have = Array.from(new Set([...bundled.keys(), ...cached, ...images.keys()]));
      send({ t: "ready", scene: 1, version: VERSION, ua: navigator.userAgent, have });
    }

    function report(where, error) {
      send({ t: "error", where, message: String((error && error.message) || error).slice(0, 300) });
    }

    function snapshot(quality) {
      try {
        const data = canvas.toDataURL("image/jpeg", quality || 0.7).split(",")[1] || "";
        const parts = Math.ceil(data.length / 30000);
        for (let index = 0; index < parts; index += 1) {
          send({ t: "snap", n: index, of: parts, d: data.slice(index * 30000, (index + 1) * 30000) });
        }
      } catch (error) { report("snap", error); }
    }

    // MARK: Messages

    function handle(message) {
      if (!message || typeof message !== "object") return;
      switch (message.t) {
        case "hello":
          debug = message.debug === 1;
          if (Number(message.canvas) >= 320) { maxCanvasWidth = Math.min(1920, Number(message.canvas)); resize(); }
          if (["low", "medium", "high"].indexOf(message.smooth) >= 0) smoothing = message.smooth;
          clock.reset();
          timeline.reset();
          lastStamp = null;
          if (readyToAnswer) answerHello(); else pendingHello = true;
          break;
        case "ping":
          send({ t: "pong", i: message.i, r: performance.now() });
          break;
        case "sync":
          clock.set(message.o);
          break;
        case "scene":
          setOn(message.on === 1);
          break;
        case "f": {
          const frame = timeline.add(message, message.e);
          if (frame) noteArrival(frame);
          break;
        }
        case "fs": {
          const frames = timeline.replace(message.frames, message.e);
          frames.forEach(noteArrival);
          if (frames.length) counters.redraws += 1;
          break;
        }
        case "img":
          receivePart(message);
          break;
        case "snap":
          snapshot(message.q);
          break;
        default: break;
      }
    }

    // Recorded frames played without a phone: `at` >= 0 draws that frame
    // once (for comparing with the phone's own drawing), otherwise they loop
    // at their own pace.
    function playRecording(data, at, base) {
      const entries = Object.entries((data && data.images) || {});
      const resolve = (file) => base ? new URL(file, base).href : file;
      entries.forEach(([key, file]) => { if (/\.jpe?g$/i.test(file)) opaque.add(key); });
      return Promise.all(entries.map(([key, file]) => loadImage(resolve(file)).then((image) => addImage(key, image))))
        .then(() => fontsReady)
        .then(() => {
          const frames = (data.frames || []).map(core.normalizeFrame).filter(Boolean);
          if (!frames.length) return;
          setOn(true);
          if (at >= 0) {
            on = false;
            const frame = frames[Math.min(at, frames.length - 1)];
            drawFrame(frame);
            const h = frame.h || frames.slice(0, at + 1).reverse().map((f) => f.h).find(Boolean);
            if (h) renderHUD(h);
            document.body.dataset.sceneDrawn = "1";
            return;
          }
          const first = frames[0].s;
          const length = frames[frames.length - 1].s - first + 1000 / 30;
          const started = performance.now();
          clock.set(started - first);
          let lap = -1;
          const feed = () => {
            const elapsed = performance.now() - started;
            const current = Math.floor(elapsed / length);
            if (current !== lap) {
              lap = current;
              timeline.replace(frames.map((f) => Object.assign({}, f, { s: f.s + current * length, __shape: undefined })), current + 1);
            }
            window.setTimeout(feed, 200);
          };
          feed();
        });
    }

    // A recording on the receiver's own site (previews only).
    function playRecordingAt(path, at) {
      const base = new URL(path, window.location.href);
      return fetch(base.href).then((response) => response.json()).then((data) => playRecording(data, at, base))
        .catch((error) => { document.body.dataset.sceneError = String(error); });
    }

    // The rounded face the stadium's own text uses, before anything is drawn.
    const fontsReady = document.fonts && document.fonts.load
      ? Promise.all(["900 20px Nunito", "800 20px Nunito", "700 20px Nunito", "700 20px Inter"].map((f) => document.fonts.load(f)))
        .catch(() => null)
      : Promise.resolve();

    Promise.all([loadBundled(), openCache(), fontsReady]).then(() => {
      readyToAnswer = true;
      if (pendingHello) { pendingHello = false; answerHello(); }
    });
    window.requestAnimationFrame(frameLoop);

    return { NAMESPACE, handle, report, setOn, renderHUD, drawFrame, playRecording, playRecordingAt, timeline, clock, images };
  }

  window.RallycadeReceiverScene = { NAMESPACE, createScene };
})();
