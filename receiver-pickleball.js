(function () {
  "use strict";

  // Pickleball on the TV (receiver 74): the court drawn from the phone's
  // drawing operations (receiver-pickleball-core.js), the phone's HUD in HTML
  // over it, and the ready and result cards. Its own channel, so cricket's
  // stadium (receiver-scene.js) is untouched. Docs: docs/design/CAST_SCENE.md,
  // "Pickleball on the TV".
  //
  // Phone -> TV: hello {v, look, debug?}, ping {i}, sync {o}, view {v: off|ready|match|result, ready?, result?},
  // f {s, o, h?, k?}.  TV -> phone: ready {pickleball, version, looks}, pong {i, r}, loaded {look, ms, missing},
  // stats {fps, gap, frames, drawMs, queue, stale, delay, late, missing}, error {where, message}.
  const NAMESPACE = "urn:x-cast:com.slipspark.pickleball";
  const RECEIVER_VERSION = 75;
  const core = window.RallycadePickleballCore;
  const sceneCore = window.RallycadeSceneCore;

  function createPickleball(options) {
    const root = options.root, stage = options.stage, court = options.court, plateImg = options.plate, canvas = options.canvas;
    const hud = options.hud, readyCard = options.ready, resultCard = options.result, chip = options.chip;
    const send = options.send || (() => {});
    const now = options.now || (() => performance.now());
    const base = options.base || "pickleball/";
    const ctx = canvas.getContext("2d");
    const playout = core.createPlayout();
    let manifest = null, manifestWait = null;
    const pictures = new Map(); // sheet -> {image, scale, loaded}
    let plate = null, plateLoaded = false;
    let look = "man", lookLoadedAt = null, helloAt = null, debug = false;
    let view = "off", readyWords = null, resultWords = null;
    let drawn = false, raf = 0, running = false;
    let canvasPx = 1280;
    let lastDrawn = null; // bounds drawn last frame, stage points
    let pushShown = "";
    const stats = { draws: [], drawMs: [], frames: 0, missing: 0, since: now(), lastDraw: null };

    function el(id) { return document.getElementById(id); }
    function setText(node, value) { const text = value == null ? "" : String(value); if (node && node.textContent !== text) node.textContent = text; }

    // MARK: Pictures

    function loadManifest() {
      if (manifestWait) return manifestWait;
      manifestWait = (options.manifest ? Promise.resolve(options.manifest) : fetch(base + "manifest.json?v=" + RECEIVER_VERSION).then((r) => r.json()))
        .then((json) => { manifest = json; return json; })
        .catch((error) => { report("manifest", error); manifest = { sheets: {} }; return manifest; });
      return manifestWait;
    }

    function loadImage(src) {
      return new Promise((resolve) => {
        const image = new Image();
        image.decoding = "async";
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = src;
      });
    }

    function loadSheet(name) {
      if (pictures.has(name)) return pictures.get(name).wait;
      const spec = manifest && manifest.sheets && manifest.sheets[name];
      const entry = { image: null, scale: spec ? spec.scale : 1, wait: null };
      entry.wait = spec ? loadImage(base + name + ".webp?v=" + RECEIVER_VERSION).then((image) => { entry.image = image; return image; }) : Promise.resolve(null);
      pictures.set(name, entry);
      return entry.wait;
    }

    function loadPlate() {
      if (plate || plateLoaded) return Promise.resolve(plate);
      plateLoaded = true;
      plateImg.src = base + "PickleballCourt.webp?v=" + RECEIVER_VERSION;
      return new Promise((resolve) => {
        const done = () => { plate = plateImg.naturalWidth ? plateImg : null; resolve(plate); };
        if (plateImg.complete && plateImg.naturalWidth) done();
        else { plateImg.onload = done; plateImg.onerror = () => resolve(null); }
      });
    }

    function preload(nextLook) {
      look = nextLook === "woman" ? "woman" : "man";
      const started = now();
      return loadManifest().then(() => Promise.all([loadPlate()].concat(core.sheetsFor(manifest, look).map(loadSheet)))).then((loaded) => {
        lookLoadedAt = now();
        const missing = loaded.filter((x) => !x).length;
        send({ t: "loaded", look, ms: Math.round(lookLoadedAt - started), missing });
      });
    }

    function picture(sheet) {
      const entry = pictures.get(sheet);
      if (!entry) { if (manifest) loadSheet(sheet); return null; }
      return entry.image ? entry : null;
    }

    // MARK: Canvas

    function sizeCanvas() {
      const box = stage.getBoundingClientRect();
      const plan = sceneCore && sceneCore.canvasPlan ? sceneCore.canvasPlan({ ua: navigator.userAgent, wide: true }) : { width: 1280 };
      const width = options.canvasWidth || (sceneCore && sceneCore.canvasWidth ? sceneCore.canvasWidth(box.width || 1280, window.devicePixelRatio, plan.width) : 1280);
      if (width !== canvasPx || canvas.width !== width) {
        canvasPx = width;
        canvas.width = width;
        canvas.height = Math.round(width * 9 / 16);
        lastDrawn = null;
      }
      // The HUD's phone-height stage scaled onto the TV's.
      if (hud) hud.style.transform = "scale(" + ((box.width || 1280) / core.HUD_STAGE.width) + ")";
    }

    function union(boxes) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const b of boxes) { if (!b) continue; x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
      return x0 === Infinity ? null : { x: x0 - 3, y: y0 - 3, w: x1 - x0 + 6, h: y1 - y0 + 6 };
    }

    function placePlate(op) {
      if (!op) return;
      const key = [op.x, op.y, op.w, op.h].map((v) => v.toFixed(1)).join(",");
      if (plateImg.dataset.rect === key) return;
      plateImg.dataset.rect = key;
      const W = core.STAGE.width, H = core.STAGE.height;
      Object.assign(plateImg.style, { left: (op.x / W * 100) + "%", top: (op.y / H * 100) + "%", width: (op.w / W * 100) + "%", height: (op.h / H * 100) + "%" });
    }

    function applyPush(push) {
      // The camera's push toward a good contact: the court (photograph and canvas) scaled about a point, a layer transform.
      const key = push ? push.map((v) => Math.round(v)).join(",") : "";
      if (key === pushShown) return;
      pushShown = key;
      if (!push) { court.style.transform = ""; return; }
      const scale = push[0] / 10000, cx = push[1] / 10 / core.STAGE.width * 100, cy = push[2] / 10 / core.STAGE.height * 100;
      court.style.transformOrigin = cx + "% " + cy + "%";
      court.style.transform = "scale(" + scale.toFixed(4) + ")";
    }

    // Draws the frame for TV time `local`; true when something was drawn.
    function drawAt(local) {
      const shown = playout.at(local);
      if (!shown) return false;
      const started = now();
      const ops = shown.ops.map(core.decodeOp).filter(Boolean);
      const plateOp = ops.find((op) => op.kind === "P");
      placePlate(plateOp);
      applyPush(shown.push);
      const k = canvas.width / core.STAGE.width;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // Clear only where the last frame drew (the photograph is its own layer).
      const clear = lastDrawn;
      if (clear) ctx.clearRect(Math.floor(clear.x * k) - 1, Math.floor(clear.y * k) - 1, Math.ceil(clear.w * k) + 3, Math.ceil(clear.h * k) + 3);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(k, 0, 0, k, 0, 0);
      const missing = core.drawOps(ctx, ops, picture, plate, false);
      lastDrawn = union(ops.filter((op) => op.kind !== "P").map((op) => core.opBounds(op)));
      stats.missing += missing;
      renderHUD(core.hudView(shown.hud, shown.moment));
      stats.drawMs.push(now() - started);
      if (stats.lastDraw !== null) stats.draws.push(local - stats.lastDraw);
      stats.lastDraw = local;
      stats.stale = shown.stale; stats.queue = shown.ahead;
      if (!drawn && missing === 0 && plate) { drawn = true; applyView(); }
      return true;
    }

    // MARK: HUD

    const hudShown = {};
    function renderHUD(h) {
      if (!hud) return;
      hud.hidden = !h;
      if (!h) return;
      const set = (key, value, apply) => { if (hudShown[key] !== value) { hudShown[key] = value; apply(value); } };
      set("you", h.you, (v) => setText(el("pk-you"), v));
      set("cpu", h.cpu, (v) => setText(el("pk-cpu"), v));
      set("srv", h.serving, (v) => { el("pk-you-serve").classList.toggle("on", v === "you"); el("pk-cpu-serve").classList.toggle("on", v === "cpu"); });
      set("band", h.band.join("|"), () => { setText(el("pk-band-title"), h.band[0]); setText(el("pk-band-value"), h.band[1]); });
      const banner = el("pk-banner");
      set("banner", h.banner ? JSON.stringify(h.banner) : "", () => {
        banner.hidden = !h.banner;
        if (!h.banner) return;
        Object.assign(banner.style, { left: h.banner.x + "px", top: h.banner.y + "px", width: h.banner.width + "px", "--tone": h.banner.color });
        banner.style.setProperty("--tone", h.banner.color);
        const words = el("pk-banner-text");
        words.style.fontSize = h.banner.fontSize + "px";
        setText(words, h.banner.text);
        // A new line fades in (the phone's .transition(.opacity)).
        banner.classList.remove("pk-in"); void banner.offsetWidth; banner.classList.add("pk-in");
      });
      const callout = el("pk-callout");
      const c = h.callout;
      callout.hidden = !c;
      if (c) {
        set("callout", c.title + "|" + c.grade + "|" + c.leading, () => {
          setText(el("pk-callout-title"), c.title);
          const grade = el("pk-callout-grade");
          setText(grade, c.grade.toUpperCase()); grade.hidden = !c.grade;
          callout.classList.toggle("good", c.good);
          callout.classList.toggle("leading", c.leading);
        });
        callout.style.opacity = c.alpha.toFixed(3);
        callout.style.transform = "translateY(" + c.lift.toFixed(1) + "px)";
      } else hudShown.callout = "";
    }

    // MARK: Views

    function renderReady() {
      const words = core.readyView(readyWords, view === "match" && !drawn);
      setText(el("pk-ready-eyebrow"), words.eyebrow);
      setText(el("pk-ready-title"), words.title);
      setText(el("pk-ready-detail"), words.detail);
      setText(el("pk-ready-line"), words.line);
      el("pk-ready-line").hidden = !words.line;
    }

    function renderResult() {
      const r = core.resultView(resultWords);
      setText(el("pk-result-eyebrow"), r.eyebrow);
      setText(el("pk-result-headline"), r.headline);
      setText(el("pk-result-you"), r.you);
      setText(el("pk-result-cpu"), r.cpu);
      el("pk-result-you-side").classList.toggle("won", r.won);
      el("pk-result-cpu-side").classList.toggle("won", !r.won && r.cpu > r.you);
      const list = el("pk-result-stats");
      list.textContent = "";
      for (const stat of r.stats) {
        const item = document.createElement("div");
        item.className = "pk-stat";
        const value = document.createElement("strong"); value.textContent = stat.value;
        const title = document.createElement("span"); title.textContent = stat.title.toUpperCase();
        item.append(value, title); list.append(item);
      }
      setText(el("pk-result-story"), r.story);
      setText(el("pk-result-coaching"), r.coaching);
    }

    function applyView() {
      root.hidden = view === "off";
      document.body.dataset.pickleball = view;
      root.dataset.view = view;
      const showReady = view === "ready" || (view === "match" && !drawn);
      readyCard.hidden = !showReady;
      resultCard.hidden = view !== "result";
      if (showReady) renderReady();
      if (view === "result") renderResult();
      canvas.style.visibility = view === "match" && drawn ? "visible" : "hidden";
      if (hud) hud.style.visibility = view === "match" && drawn ? "visible" : "hidden";
      if (view === "match" || view === "result") start(); else stop();
    }

    function setView(message) {
      const next = ["off", "ready", "match", "result"].includes(message.v) ? message.v : "off";
      if (message.ready) readyWords = message.ready;
      if (message.result) resultWords = message.result;
      if (next === "match" && view !== "match") { playout.reset(); if (clockOffset !== null) playout.setOffset(clockOffset); drawn = false; lastDrawn = null; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); }
      view = next;
      if (view !== "off") { loadPlate(); }
      applyView();
    }

    // MARK: Loop and stats

    function frame() {
      raf = 0;
      if (!running) return;
      if (view === "match") drawAt(now());
      playout.settle(playout.target(averageGap()));
      maybeReport();
      raf = requestAnimationFrame(frame);
    }
    function start() { if (running) return; running = true; sizeCanvas(); if (!options.manualClock) raf = requestAnimationFrame(frame); }
    function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }

    let arrivals = [];
    function averageGap() {
      if (arrivals.length < 3) return 33;
      return Math.max(16, Math.min(70, (arrivals[arrivals.length - 1] - arrivals[0]) / (arrivals.length - 1)));
    }

    function maybeReport(force) {
      const t = now();
      if (!force && t - stats.since < 2000) return;
      const seconds = Math.max(0.001, (t - stats.since) / 1000);
      const message = {
        t: "stats", fps: Math.round(stats.draws.length / seconds * 10) / 10,
        gap: Math.round(core.percentile(stats.draws, 0.9)), frames: stats.frames,
        drawMs: Math.round(core.percentile(stats.drawMs, 0.5) * 10) / 10, queue: stats.queue || 0,
        stale: Math.round(stats.stale || 0), delay: Math.round(playout.delay), late: playout.counts.late, missing: stats.missing
      };
      if (view === "match") send(message);
      stats.draws = []; stats.drawMs = []; stats.frames = 0; stats.missing = 0; stats.since = t;
      if (debug && chip) { chip.hidden = false; chip.textContent = "fps " + message.fps + " · stale " + message.stale + " ms · delay " + message.delay + " ms"; }
      return message;
    }

    function report(where, error) {
      send({ t: "error", where, message: String((error && error.message) || error) });
    }

    // MARK: Messages

    let clockOffset = null;
    function handle(message) {
      if (!message || typeof message !== "object") return;
      switch (message.t) {
        case "hello":
          helloAt = now();
          debug = message.debug === 1;
          if (chip) chip.hidden = !debug;
          preload(message.look);
          send({ t: "ready", pickleball: core.VERSION, version: RECEIVER_VERSION, looks: ["man", "woman"] });
          break;
        case "ping":
          send({ t: "pong", i: message.i, r: now() });
          break;
        case "sync":
          if (Number.isFinite(Number(message.o))) { clockOffset = Number(message.o); playout.setOffset(clockOffset); }
          break;
        case "view":
          setView(message);
          if (message.look && message.look !== look) preload(message.look);
          break;
        case "f": {
          const local = now();
          if (playout.add(message, local)) {
            stats.frames += 1;
            arrivals.push(local); if (arrivals.length > 20) arrivals.shift();
          }
          if (view !== "match") return;
          break;
        }
      }
    }

    // The phone left: the last frame stays a while with a chip, then the overlay goes (as the stadium does).
    function senderLeft(graceMs) {
      if (view === "off") return;
      if (chip) { chip.hidden = false; chip.textContent = "Reconnecting…"; }
      return setTimeout(() => { view = "off"; applyView(); }, graceMs || 20000);
    }

    window.addEventListener("resize", () => { if (running) sizeCanvas(); });

    return {
      NAMESPACE, handle, drawAt, senderLeft, report, playout, preload, setView,
      get view() { return view; }, get drawn() { return drawn; }, get look() { return look; },
      stats: () => maybeReport(true), sizeCanvas, picture, loaded: () => lookLoadedAt !== null,
      release() { stop(); pictures.clear(); }
    };
  }

  // ?pickleball=<recording.json>: a phone's recorded messages ({messages: [{at, m}]}, `at` on the phone's clock in
  // ms) played in real time, or with `film` drawn moment by moment by window.__pickleballFilm(ms) (the TV's clock is
  // the phone's, the delay fixed; scripts/pickleball/cast/film.mjs).
  function playRecording(pickleball, url, options) {
    return fetch(url).then((r) => r.json()).then((recording) => {
      const messages = recording.messages || [];
      const first = messages.length ? messages[0].at : 0;
      let next = 0;
      const feed = (phoneNow) => {
        while (next < messages.length && messages[next].at <= phoneNow) {
          const message = messages[next].m;
          next += 1;
          try { pickleball.handle(message); } catch (error) { console.error(error); }
        }
      };
      if (options.film) {
        window.__pickleballFilm = (ms) => {
          const clock = first + ms;
          options.setClock(clock);
          feed(clock);
          pickleball.playout.setOffset(0);
          pickleball.playout.setDelay(options.delay);
          pickleball.sizeCanvas();
          if (pickleball.view === "match") pickleball.drawAt(clock);
          return { view: pickleball.view, drawn: pickleball.drawn, loaded: pickleball.loaded() };
        };
        window.__pickleballFilmReady = true;
        return;
      }
      const startedAt = performance.now();
      const tick = () => {
        feed(first + (performance.now() - startedAt));
        pickleball.playout.setOffset(startedAt - first);
        if (next < messages.length) setTimeout(tick, 5);
      };
      tick();
    });
  }

  window.RallycadePickleball = { NAMESPACE, RECEIVER_VERSION, createPickleball, playRecording };
})();
