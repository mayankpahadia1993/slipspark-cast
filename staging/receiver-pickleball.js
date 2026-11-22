(function () {
  "use strict";

  // Pickleball on the TV (receiver 74): the court drawn from the phone's
  // drawing operations (receiver-pickleball-core.js), the phone's HUD in HTML
  // over it, and the ready and result cards. Its own channel, so cricket's
  // stadium (receiver-scene.js) is untouched. Docs: docs/design/CAST_SCENE.md,
  // "Pickleball on the TV".
  //
  // Phone -> TV: hello {v, look, sheets?, debug?}, ping {i}, sync {o}, view {v: off|ready|match|result, ready?, result?,
  // sheets?}, f {s, o, h?, k?}.  TV -> phone: ready {pickleball, version, looks, friends?, tall?, go?}, pong {i, r},
  // go {ms, why, load, shown} (receiver 97: the match that just came on is drawn and steady), loaded {look, ms, missing}, stats {fps, gap, frames, drawMs, queue, stale, delay, late, missing}, error {where, message}.
  // Receiver 78 (play with friends, docs/design/PICKLEBALL_FRIENDS.md): `sheets` names the pictures beyond the look's own
  // (a friend's look, each player's kit); the HUD's `nm` names the score's rows, `sp` a same-phone split screen with
  // `ban2`/`call2` for its right half; a frame's "V" ops split the court in two; `friends: 1` says this TV draws them.
  const NAMESPACE = "urn:x-cast:com.slipspark.pickleball";
  // Receiver 82 (Nov 10 2026): cricket's grounds in every view (receiver-scene.js preloadViews); pickleball as 81.
  // Receiver 83 (Nov 10 2026, qnkrpct6): warm-up reports and kept files carried across deploys (receiver-scene.js).
  // Receiver 84 (Nov 11 2026, fn6t394j): the batter's look whole or not at all; the TV's own copies before Play.
  // Receiver 85: Android's dyed pieces (named without a size) too.
  // Receiver 86: the hello's `pieces` load with the stadium; the whites while a dyed piece isn't decoded yet.
  // Receiver 87 (hn6ae62a): a stalled dyed piece can't hold the whites; at most 6 s.
  // Receiver 88 (w34kr8dq): no steady verdict while the stadium's pictures still load.
  // Receiver 90: a look's whites start once; never half dressed (a stalled piece keeps the whole batter photographed).
  // Receiver 91: a 2.9.9 look (dyed clothes, photographed forearms, gloves and bat face) is whole, not half dressed.
  // Receiver 96: the tall court plate (a "P" with a sixth value 1): a same-phone split screen's halves filled by their
  // courts; the hello's `tall: 1` says this TV has it.
  // Receiver 97 (Nov 14 2026, xn13cprg and xy026r2m: "the game started really laggy"): a match's start is held until
  // its pictures are loaded and warmed and its first frames draw steadily; `go` tells the phone, which holds its first
  // serve for it (the `ready`'s `go: 1` says this TV sends one). See `beginStart`.
  // Receiver 106 (Nov 22 2026, bzrb3cvj and e754c9zc, iOS 380 on a 32-bit Chromecast: "Delay while playing side by side",
  // "It crashed or froze"): the weak plan (`weakDongle`): one opaque canvas that draws the courts' photographs itself, no
  // photograph layers, a HUD that never animates, the sheets' smaller copies (`pickleball/small/`), no decode() at load,
  // and arrivals just after the TV's own stall kept out of the delay. `ready` and `stats` say `weak: 1`; `stats` add
  // `worst`, the longest gap between draws. The hello's `x.weak` (1 or 0, benches) draws as a weak dongle does, or not.
  const RECEIVER_VERSION = 106;
  const core = window.RallycadePickleballCore;
  const sceneCore = window.RallycadeSceneCore;

  function createPickleball(options) {
    const root = options.root, stage = options.stage, court = options.court, plateImg = options.plate;
    // The match's canvas: a new element in its place when the weak plan's opaque canvas comes or goes (`setWeak`).
    let canvas = options.canvas;
    // A same-phone split screen's right half's photograph (the left half's is `plateImg`).
    const plateImg2 = options.plate2 || null;
    // The tall plate's layers, one for each half (receiver 96).
    const tallImgs = [options.plateTall || null, options.plateTall2 || null];
    let tallPlate = null;
    const hud = options.hud, readyCard = options.ready, resultCard = options.result, chip = options.chip;
    const send = options.send || (() => {});
    const now = options.now || (() => performance.now());
    const base = options.base || "pickleball/";
    // MARK: The weak plan (receiver 106)
    //
    // Nov 22 2026, iOS 380 on a 32-bit Chromecast ("Family room TV", `Linux armv7l`, CrKey 1.56; bzrb3cvj, e754c9zc): a
    // match on one court drew 10–11 a second of the 15 the phone sent, each draw 2–3 ms of script and the loop every
    // ~100 ms (as cricket's stadium on the same class of TV: docs/design/CAST_SCENE.md, "A 32-bit Chromecast at a
    // party"), so the TV's time went on compositing, not on the script: the court's photograph a layer of its own, a
    // see-through canvas over it, the HUD over both. Side by Side drew 4–10 a second with freezes of 1.0–1.5 s every
    // ten or so seconds (fps 1.4–3.2), at a point's end, a new serve or a stroke not drawn for a while: thirty-eight
    // sheets (74 MB decoded at full size) and two tall photographs (6.3 MB each, layers of their own) on a TV with
    // half a gigabyte, which lets decoded pictures go and decodes them again, and (by the logs) stalls as a whole meanwhile.
    //
    // On a weak dongle the canvas is opaque and draws the photographs itself (from the bitmaps the canvas's size,
    // `canvasPlate`/`canvasTall`), so the TV composites one opaque layer and the HUD's few tiles; the photographs'
    // layers are not shown or decoded (`data-weak`, receiver.css); a draw repaints only where the players and the ball
    // were and are (`drawWeak`); the HUD never fades, lifts or casts shadows; the sheets come from `small/` (near 0.45,
    // far 0.2 of the phone's sheet: on an 854 canvas the near player is drawn at most 0.44, the far one 0.14), a third of
    // the decoded bytes; loading decodes nothing ahead (`decode()` fills the compositor's cache, not the canvas's, and on
    // this TV it cost seconds of the start: "the TV loaded the man pictures in 13118 ms").
    const weakDongle = options.weak !== undefined ? !!options.weak
      : !!(sceneCore && sceneCore.isWeakDongle && typeof navigator !== "undefined" && sceneCore.isWeakDongle(navigator.userAgent));
    let weak = weakDongle, opaque = false;
    function opaqueContext(target) {
      const context = target.getContext("2d", { alpha: false });
      opaque = true;
      return context;
    }
    let ctx = weak ? opaqueContext(canvas) : canvas.getContext("2d");
    if (weak && root && root.dataset) root.dataset.weak = "1";
    // Each hello starts from the TV's own plan; the bench's `x.weak` changes it. A canvas's alpha is fixed once it has a
    // context: the other kind takes a new canvas element in the same place.
    function setWeak(want) {
      want = !!want;
      if (want !== weak) { weak = want; canvasPx = 0; lastDrawn = null; weakKey = ""; stillShown = ""; }
      if (root && root.dataset) { if (weak) root.dataset.weak = "1"; else delete root.dataset.weak; }
      if (want === opaque) return;
      const parent = canvas.parentNode;
      if (parent && parent.replaceChild && typeof document !== "undefined" && document.createElement) {
        const fresh = document.createElement("canvas");
        fresh.id = canvas.id;
        fresh.className = canvas.className;
        fresh.width = canvas.width;
        fresh.height = canvas.height;
        fresh.style.cssText = canvas.style.cssText;
        parent.replaceChild(fresh, canvas);
        canvas = fresh;
      }
      if (want) ctx = opaqueContext(canvas);
      else { ctx = canvas.getContext("2d"); opaque = false; }
    }
    const playout = core.createPlayout();
    let manifest = null, manifestWait = null;
    const pictures = new Map(); // sheet -> {image, scale, loaded}
    let plate = null, plateLoaded = false;
    let look = "man", lookLoadedAt = null, helloAt = null, debug = false;
    let named = [];
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

    // Decoded before it is first drawn (receiver 79): a sheet decoded on the
    // spot stalled the match's first frames (fps 10 for its first 2 s on the
    // owner's Ultra), as cricket's stadium did before receiver 57.
    // Receiver 106: not on a weak dongle (the weak plan, above).
    function loadImage(src) {
      return new Promise((resolve) => {
        const image = new Image();
        image.decoding = "async";
        image.onload = () => {
          if (image.decode && !weak) image.decode().then(() => resolve(image), () => resolve(image));
          else resolve(image);
        };
        image.onerror = () => resolve(null);
        image.src = src;
      });
    }

    // The match's pictures warmed while the ready card is up, so its first frames draw nothing for the first time.
    //
    // Receiver 79 drew every loaded sheet whole in the hidden canvas over a few animation frames. Nov 14 2026, traced on
    // the owner's Chromecast Ultra through its debugging port: that warmed nothing. A canvas that is not shown is never
    // flushed, and clearing it drops what was drawn (0 decodes and 0 texture uploads before the match; every sheet was
    // decoded on the page's thread, 30–140 ms each, in the frame that first drew it, and the court photograph too, 135–
    // 145 ms, for the net's band). Drawing all of them in one shown frame is no better: more than the canvas's picture
    // cache holds at once, decoded and dropped again. And when the TV runs short of memory it empties that cache (a
    // "critical" memory pressure notice, seen 1–3 times around a start), so every sheet decoded again on its next use.
    //
    // Receiver 97: the warm-up draws the sheets one or two an animation frame in the shown canvas (under the ready card,
    // all but transparent), so each is decoded and on the GPU before the match: those the first frame draws first, then
    // the strokes a match opens with (`warmOrder`), `WARM_EACH` a frame, twice as many after a frame that came on time
    // (those were on the GPU already). `warmMode` (the hello's `warm`, for benches): "none" skips it.
    //
    // Not decoded bitmaps of the sheets, as cricket's stadium keeps its pictures (receiver-scene.js `decodePicture`):
    // tried on the Ultra the same day, a look's fifteen (27 MB) started a match at full rate, but a same-phone match's
    // thirty-eight (61 MB, which the TV cannot let go when it runs short) stalled the whole TV for 6 to 51 s. The sheets
    // stay images, which the TV drops and decodes again as its memory allows; only the court's two canvas copies are
    // bitmaps (`canvasPlate`).
    // Receiver 106: on a weak dongle, whose loop runs every ~100 ms whatever it draws, a frame is on time within 150 ms.
    const WARM_EACH = 1, WARM_MOST = 6, WARM_ALPHA = 0.02, WARM_ON_TIME = 45, WEAK_WARM_ON_TIME = 150, WARM_PATCH = 24;
    // How many sheets a pass warms: about what the TV keeps at once. A same-phone match's thirty-eight took over 2 s to go
    // round on the Ultra, each one decoded again because the earlier ones had pushed it out; a look has fifteen.
    const WARM_SET = 16;
    // The strokes a match opens with, in the order their sheets are warmed after the first frame's.
    const WARM_FIRST = ["Serve", "Forehand", "Backhand", "Shuffle", "Move", "Dink", "Volley", "Overhead"];
    const NEAR_SCALE = 0.62, FAR_SCALE = 0.17;
    let warmMode = "frames", warmRaf = 0, warmStarted = 0;
    // What is still to warm (sheet names, "plate", "tall"), how many this frame, and when the last frame ran.
    let warmQueue = [], warmEach = WARM_EACH, warmLast = null;
    // Whether the pictures loaded now have been warmed since they loaded and since this setup opened (`warmPass`: each
    // setup warms them again, as a Chromecast lets decoded pictures go; a sheet's `warmed` is the pass that drew it).
    let warmDone = false, warmPass = 1;
    // The order to warm in: the court's photographs and the sheets `ops` (a match's first frame) draws, then the rest.
    function warmOrder(ops) {
      const first = [];
      if (ops) for (const op of ops) if (op.kind === "p" && !first.includes(op.sheet)) first.push(op.sheet);
      const tall = !!ops && ops.some((op) => op.kind === "P" && op.tall);
      const rank = (name) => { const at = WARM_FIRST.findIndex((stroke) => name.includes(stroke)); return at < 0 ? WARM_FIRST.length : at; };
      const rest = [...pictures.keys()].filter((name) => !first.includes(name)).sort((a, b) => rank(a) - rank(b));
      return (tall ? ["tall"] : ["plate"]).concat(first.filter((name) => pictures.has(name)).concat(rest).slice(0, WARM_SET));
    }
    // One warm frame: the next few of `warmQueue` drawn at the size the match draws them. True while more remain.
    function warmSome(t) {
      sizeCanvas();
      const k = canvas.width / core.STAGE.width;
      // On time since the last frame: those were cheap (already on the GPU), so one more goes in this one.
      warmEach = warmLast !== null && t - warmLast <= (weak ? WEAK_WARM_ON_TIME : WARM_ON_TIME) ? Math.min(WARM_MOST, warmEach + 1) : WARM_EACH;
      warmLast = t;
      canvas.style.visibility = "visible";
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // Receiver 106: an opaque canvas keeps the photograph it shows under the card; only the patch is painted again.
      if (weak) paintStill(warmPatch());
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(k, 0, 0, k, 0, 0);
      // Through a small patch in the corner: the whole picture is decoded and uploaded at the match's size all the same,
      // and almost nothing of it is painted.
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, WARM_PATCH, WARM_PATCH); ctx.clip();
      ctx.globalAlpha = WARM_ALPHA;
      for (let n = 0; n < warmEach && warmQueue.length; n += 1) {
        const name = warmQueue.shift();
        try {
          if (name === "plate" || name === "tall") {
            const image = name === "tall" ? canvasTall : canvasPlate;
            if (image) ctx.drawImage(image, 0, 0, core.STAGE.width, core.STAGE.height);
          } else {
            const entry = pictures.get(name);
            if (!entry || !entry.image) continue;
            const scale = (/Opponent/.test(name) ? FAR_SCALE : NEAR_SCALE) / (entry.scale || 1);
            ctx.drawImage(entry.image, 0, 0, entry.image.width * scale, entry.image.height * scale);
            entry.warmed = warmPass;
          }
        } catch (error) { /* a picture the canvas can't draw */ }
      }
      ctx.restore();
      stats.warmed = [...pictures.values()].filter((entry) => entry.warmed === warmPass).length;
      return warmQueue.length > 0;
    }
    function clearWarm() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // Receiver 106: an opaque canvas is never cleared (black); its patch shows the photograph again.
      if (weak) paintStill(warmPatch());
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
      lastDrawn = null;
    }
    // The warm-up's corner patch in stage points, a pixel round it.
    function warmPatch() { return { x: -1, y: -1, w: WARM_PATCH + 2, h: WARM_PATCH + 2 }; }
    // The setup screen's warm-up, once the look is loaded and each time a setup opens.
    function warm() {
      // Only under the ready card: a canvas that is not shown warms nothing (a match's start has its own, `stepStart`).
      if (view !== "ready" || warmMode === "none") return;
      warmDone = false;
      warmPass += 1;
      warmQueue = warmOrder(null);
      warmLast = null;
      warmStarted = now();
      if (!warmRaf && !options.manualClock) warmRaf = requestAnimationFrame(warmFrame);
    }
    function warmFrame(t) {
      warmRaf = 0;
      if (view !== "ready") { endWarm(); return; }
      if (warmSome(t === undefined ? now() : t)) { warmRaf = requestAnimationFrame(warmFrame); return; }
      if (loading === 0) warmDone = true;
      // One more frame so the last ones are flushed before the canvas is cleared and hidden again.
      warmRaf = requestAnimationFrame(() => { warmRaf = 0; endWarm(); });
    }
    function endWarm() {
      if (warmRaf) cancelAnimationFrame(warmRaf);
      warmRaf = 0;
      warmQueue = [];
      stats.warmMs = Math.round(now() - warmStarted);
      // The canvas as the view has it (a match's start clears it itself). Receiver 106: a weak dongle's stays, the
      // photograph under the card.
      if (view !== "match") { clearWarm(); if (weak) showStill(); else canvas.style.visibility = "hidden"; }
    }

    // The court's canvas copies as decoded bitmaps the canvas's size (`loadPlate`): 3.7 MB and 2 MB.
    const canBitmap = typeof window.createImageBitmap === "function" && typeof window.fetch === "function" && options.bitmaps !== false;
    const BITMAP_BUDGET = 12e6;
    let bitmapBytes = 0;
    function plannedCanvasWidth() {
      const box = stage.getBoundingClientRect();
      const plan = sceneCore && sceneCore.canvasPlan ? sceneCore.canvasPlan({ ua: navigator.userAgent, wide: true, weak }) : { width: weak ? 854 : 1280 };
      return options.canvasWidth || (sceneCore && sceneCore.canvasWidth ? sceneCore.canvasWidth(box.width || 1280, window.devicePixelRatio, plan.width) : 1280);
    }
    // `size`: the bitmap's size when it is kept smaller than the file ([width, height]).
    function loadBitmap(url, size) {
      if (!canBitmap || bitmapBytes >= BITMAP_BUDGET) return Promise.resolve(null);
      return fetch(url).then((response) => { if (!response.ok) throw new Error("fetch " + url); return response.blob(); })
        .then((blob) => (size ? window.createImageBitmap(blob, { resizeWidth: size[0], resizeHeight: size[1], resizeQuality: "high" }).catch(() => window.createImageBitmap(blob))
          : window.createImageBitmap(blob)))
        .then((bitmap) => { if (!bitmap || !(bitmap.width > 0)) return null; bitmapBytes += bitmap.width * bitmap.height * 4; return bitmap; })
        .catch(() => null);
    }

    function loadSheet(name) {
      if (pictures.has(name)) return pictures.get(name).wait;
      const spec = manifest && manifest.sheets && manifest.sheets[name];
      // Receiver 106: a weak dongle's copy from small/ (the weak plan), the full one if that never comes.
      const file = core.sheetFile(spec, weak);
      const entry = { image: null, scale: file ? file.scale : 1, wait: null, warmed: 0 };
      // A sheet that did not come is asked for once more (Nov 14 2026, the Ultra just after a deploy: "loaded, missing 1";
      // a frame that draws a sheet the TV lacks is never shown).
      const url = base + (file ? file.folder : "") + name + ".webp?v=" + RECEIVER_VERSION;
      const full = base + name + ".webp?v=" + RECEIVER_VERSION;
      entry.wait = spec ? loadImage(url).then((image) => image || new Promise((resolve) => setTimeout(resolve, 700)).then(() => loadImage(url + "&again=1")))
        .then((image) => (image || !file.folder ? image : loadImage(full).then((fallback) => { if (fallback) entry.scale = spec.scale; return fallback; })))
        .then((image) => { entry.image = image; return image; }) : Promise.resolve(null);
      pictures.set(name, entry);
      return entry.wait;
    }

    // One load of the court however many ask (receiver 83: a view can ask before the look's preload does).
    // The court photographs as the canvas draws them (the net's band over the players): decoded bitmaps the canvas's
    // size (receiver 97; the image was decoded on the page's thread, ~140 ms, in the first frame that drew the net).
    let canvasPlate = null, canvasTall = null;
    let plateWait = null, tallSettled = false;
    // Receiver 106: whether the bitmaps have come (or failed): the weak plan draws them, so a match's start waits for them.
    let canvasPlateSettled = false, canvasTallSettled = false;
    function loadPlate() {
      if (plate) return Promise.resolve(plate);
      if (plateWait) return plateWait;
      plateLoaded = true;
      plateImg.src = base + "PickleballCourt.webp?v=" + RECEIVER_VERSION;
      const high = Math.round(plannedCanvasWidth() * 9 / 16);
      const sized = (size) => (Array.isArray(size) && size[1] > high ? [Math.round(size[0] * high / size[1]), high] : null);
      loadManifest().then(() => {
        loadBitmap(plateImg.src, sized(manifest.plate && manifest.plate.size)).then((bitmap) => { canvasPlate = bitmap; canvasPlateSettled = true; showStill(); });
        if (tallImgs[0]) loadBitmap(base + "PickleballCourtTall.webp?v=" + RECEIVER_VERSION, sized(manifest.plateTall && manifest.plateTall.size)).then((bitmap) => { canvasTall = bitmap; canvasTallSettled = true; showStill(); });
        else canvasTallSettled = true;
      });
      if (tallImgs[0] && !tallImgs[0].src) {
        tallImgs[0].onload = () => { tallPlate = tallImgs[0]; tallSettled = true; showStill(); };
        tallImgs[0].onerror = () => { tallSettled = true; };
        for (const image of tallImgs) {
          if (!image) continue;
          image.src = base + "PickleballCourtTall.webp?v=" + RECEIVER_VERSION;
          // Decoded ahead of its first showing (receiver 97: 6.3 MB each, first shown on a split match's first frame).
          // Receiver 106: not on a weak dongle, where the layers never show (the canvas draws its bitmap).
          if (image.decode && !weak) image.decode().catch(() => {});
        }
      } else if (!tallImgs[0]) tallSettled = true;
      plateWait = new Promise((resolve) => {
        const done = () => { plate = plateImg.naturalWidth ? plateImg : null; resolve(plate); showStill(); };
        if (plateImg.complete && plateImg.naturalWidth) done();
        else { plateImg.onload = done; plateImg.onerror = () => resolve(null); }
      });
      return plateWait;
    }

    // Receiver 83 (Nov 10 2026, the owner: "If cricket is selected, we should only download cricket. If pickleball is
    // selected, we should only download pickleball."): a 3.0 phone says hello here on every cast, cricket ones too, and
    // the hello loaded the look's 15 sheets and the court (~1.4 MB fetched each cast, ~39 MB decoded; 3.4 s on the
    // Living Room TV's Ultra beside iOS 293's cricket setup, qnkrpct6). With `options.waitForGame` (the receiver page
    // on a TV) the hello's look waits until the phone starts or asks for pickleball (`selectGame`, from receiver.js:
    // a view other than off, a frame), as any pickleball phone does; cricket's screens never load it.
    let pickleballWanted = !options.waitForGame;
    let pending = null;
    function selectGame(game) {
      pickleballWanted = game === "pickleball";
      if (!pickleballWanted) { if (warmRaf) endWarm(); return; }
      if (pending) { const next = pending; pending = null; preload(next.look, next.sheets); }
    }
    function preloadWhenWanted(nextLook, sheets) {
      if (pickleballWanted) return preload(nextLook, sheets);
      pending = { look: nextLook, sheets };
      return Promise.resolve();
    }

    function preload(nextLook, sheets) {
      look = nextLook === "woman" ? "woman" : "man";
      if (Array.isArray(sheets)) named = sheets.filter((s) => typeof s === "string").slice(0, 64);
      const started = now();
      loading += 1;
      warmDone = false;
      return loadManifest().then(() => Promise.all([loadPlate()].concat(core.sheetsFor(manifest, look, named).map(loadSheet)))).then((loaded) => {
        loading -= 1;
        lookLoadedAt = now();
        const missing = loaded.filter((x) => !x).length;
        warm();
        send({ t: "loaded", look, ms: Math.round(lookLoadedAt - started), missing, warm: warmMode });
      }, (error) => { loading -= 1; throw error; });
    }

    // MARK: The match's start (receiver 97)

    // Nov 14 2026 (xn13cprg, iOS 311, and xy026r2m, Android 27461, on a Chromecast: "the game started really laggy"):
    // since receiver 83 the look's ~15 sheets and the court load only once pickleball is chosen, the setup screen's
    // ready card, and a match that began 1–3 s later began before they were loaded (2.1–3.6 s) and never warmed them
    // (`warm` is for the ready card): "drawMs 114.2, fps 0, missing 2, warmed 0", then 12, 25, 29 frames a second, and
    // the phone's pace governor slowed for what it heard (up to 18 s to 29). A split screen's tall plates were first
    // shown on the match's first frame.
    //
    // Now a match that comes on is held under the ready card ("Getting the court ready"): until its pictures are loaded
    // (`loading`) and its first frame is here; then the warm-up (`warmSome`: every sheet not warmed through the setup,
    // the first frame's first) with the court's photographs (a split screen's tall or wide pair) where that frame has them;
    // then the match is shown, and once `START.steadyFrames` of its frames have followed each other within
    // `START.steadyGap` ms (or `START.steadyCap` after it showed) the phone hears `go`. A phone that waits for it (iOS
    // and Android from the builds after 311 and 27461; the `ready`'s `go: 1` tells them this TV says it) holds its
    // first serve until then, so what stutters is a court where nobody moves yet. An older phone plays on underneath, as
    // it did while a sheet was missing. Never longer than `START.cap` from the match coming on (the phones' own cap is
    // 4 s). The hello's `hold: 0` (benches) starts as receiver 96 did. Not on a manual clock (the film, tests' own draws).
    const START = { cap: 3500, firstFrame: 600, warm: 1500, flushFrames: 2, steadyFrames: 8, steadyGap: 45, steadyCap: 1200 };
    let loading = 0, holdOn = !options.manualClock, starting = null, matchAt = null, statsEvery = 2000;
    function beginStart() {
      matchAt = now();
      starting = holdOn ? { at: matchAt, phase: "load", flush: 0, load: 0, shown: 0, steady: 0, last: null } : null;
    }
    function firstFrameOps() {
      const first = playout.frames[0];
      return first ? first.o.map(core.decodeOp).filter(Boolean) : null;
    }
    // One animation frame of the start at `t`; true once the match's own frames draw.
    function stepStart(t) {
      const s = starting;
      if (!s) return true;
      const since = t - s.at;
      if (s.phase === "load") {
        const ops = firstFrameOps();
        const tall = !!ops && ops.some((op) => op.kind === "P" && op.tall);
        // Receiver 106: the weak plan draws the photographs' bitmaps, so it waits for those too.
        const waitsTall = tall && (!tallSettled || (weak && !canvasTallSettled));
        const waitsPlate = weak && !canvasPlateSettled;
        if (since < START.cap && (loading > 0 || waitsTall || waitsPlate || (!ops && since < START.firstFrame))) return false;
        s.phase = "warm"; s.load = since;
        // What the first frame draws, always (the TV may have let its copies go since the setup warmed them), then the
        // sheets the setup's warm-up had not reached.
        const firstSheets = new Set(ops ? ops.filter((op) => op.kind === "p").map((op) => op.sheet) : []);
        warmQueue = warmMode === "none" ? [] : warmOrder(ops).filter((name) => name === "plate" || name === "tall" || firstSheets.has(name)
          || !pictures.get(name) || pictures.get(name).warmed !== warmPass);
        warmLast = null; s.flush = warmQueue.length ? START.flushFrames : 0;
        placeFirst(ops);
      }
      if (s.phase === "warm") {
        if (since < START.cap) {
          // At most `START.warm` of it: the strokes later in the order are decoded as they are first played, as before.
          if (warmQueue.length && since - s.load < START.warm) { warmSome(t); return false; }
          warmQueue = [];
          // A frame or two more: the last ones flushed, and the photographs' layers drawn where the match has them.
          if (s.flush > 0) { s.flush -= 1; return false; }
        }
        warmQueue = [];
        stats.warmMs = Math.round(since - s.load);
        clearWarm();
        // Receiver 106: a weak dongle's canvas stays, its photograph under the card until the match's first whole frame.
        if (!weak) canvas.style.visibility = "hidden";
        playout.forgetLateness();
        s.phase = "steady"; s.shown = since; s.last = null; s.steady = 0;
        resetStats(t);
        return true;
      }
      // Steady: the frames just drawn followed each other closely.
      if (s.last !== null) s.steady = t - s.last <= START.steadyGap ? s.steady + 1 : 0;
      s.last = t;
      if (s.steady >= START.steadyFrames || since - s.shown >= START.steadyCap || since >= START.cap) {
        starting = null;
        send({ t: "go", ms: Math.round(since), why: s.steady >= START.steadyFrames ? "steady" : "cap", load: Math.round(s.load), shown: Math.round(s.shown), warmed: stats.warmed || 0 });
      }
      return true;
    }
    // The photographs' layers where the match's first frame has them, under the ready card: shown there on the match's
    // first frame, a split screen's tall pair was first drawn (6.3 MB each) in it.
    function placeFirst(ops) {
      // Receiver 106: a weak dongle paints the first frame's photographs on its canvas instead (no layers).
      if (weak) {
        stillOps = ops ? ops.filter((op) => op.kind === "P" || op.kind === "V") : null;
        paintStill(null);
        canvas.style.visibility = "visible";
        return;
      }
      if (ops) {
        const halves = core.halves(ops);
        showSplit(!!halves);
        if (halves) halves.forEach(placeHalf); else placePlate(ops.find((op) => op.kind === "P"));
      } else if (plate && plate.naturalWidth) placePlate(core.plateLayout([plate.naturalWidth, plate.naturalHeight], core.STAGE.width, core.STAGE.height));
    }
    function resetStats(t) { stats.draws = []; stats.drawMs = []; stats.frames = 0; stats.missing = 0; stats.since = t; stats.lastDraw = null; }

    function picture(sheet) {
      const entry = pictures.get(sheet);
      if (!entry) { if (manifest) loadSheet(sheet); return null; }
      return entry.image ? entry : null;
    }

    // MARK: Canvas

    function sizeCanvas() {
      const box = stage.getBoundingClientRect();
      const plan = sceneCore && sceneCore.canvasPlan ? sceneCore.canvasPlan({ ua: navigator.userAgent, wide: true, weak }) : { width: weak ? 854 : 1280 };
      const width = options.canvasWidth || (sceneCore && sceneCore.canvasWidth ? sceneCore.canvasWidth(box.width || 1280, window.devicePixelRatio, plan.width) : 1280);
      if (width !== canvasPx || canvas.width !== width) {
        canvasPx = width;
        canvas.width = width;
        canvas.height = Math.round(width * 9 / 16);
        lastDrawn = null;
        // Receiver 106: a resized canvas is empty (an opaque one black): the weak plan draws it whole again.
        weakKey = ""; stillShown = ""; splitFill = null;
      }
      // The HUD's phone-height stage scaled onto the TV's.
      if (hud) hud.style.transform = "scale(" + ((box.width || 1280) / core.HUD_STAGE.width) + ")";
    }

    function union(boxes) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const b of boxes) { if (!b) continue; x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
      return x0 === Infinity ? null : { x: x0 - 3, y: y0 - 3, w: x1 - x0 + 6, h: y1 - y0 + 6 };
    }

    // A photograph layer where its op puts it, clipped to its half of a split screen (`clip`: that half's "V").
    // Receiver 97: the half is the photograph's box (`.pk-half`, overflow hidden), which takes the half's rectangle. Until
    // then each photograph carried a clip-path, and a clip-path on a layer of its own (`will-change`) is a mask the
    // Chromecast Ultra pays for every frame: a same-phone match drew 23 frames a second all match with the tall plates
    // (28 with the wide pair), 30 with the same pictures in boxes that clip (measured on the owner's Ultra, Nov 14 2026).
    function placePlate(op, image, clip) {
      image = image || plateImg;
      if (!op || !image) return;
      const key = [op.x, op.y, op.w, op.h].concat(clip ? [clip.x, clip.y, clip.w, clip.h] : []).map((v) => v.toFixed(1)).join(",");
      if (image.dataset.rect === key) return;
      image.dataset.rect = key;
      const W = core.STAGE.width, H = core.STAGE.height;
      const half = image.parentElement && image.parentElement.classList.contains("pk-half") ? image.parentElement : null;
      if (half) {
        const box = clip || { x: 0, y: 0, w: W, h: H };
        const boxKey = [box.x, box.y, box.w, box.h].map((v) => v.toFixed(1)).join(",");
        if (half.dataset.rect !== boxKey) {
          half.dataset.rect = boxKey;
          Object.assign(half.style, { left: (box.x / W * 100) + "%", top: (box.y / H * 100) + "%", width: (box.w / W * 100) + "%", height: (box.h / H * 100) + "%" });
          // The box moved: its other photograph is placed again when next shown.
          for (const other of half.children) if (other !== image) delete other.dataset.rect;
        }
        Object.assign(image.style, { left: ((op.x - box.x) / box.w * 100) + "%", top: ((op.y - box.y) / box.h * 100) + "%",
          width: (op.w / box.w * 100) + "%", height: (op.h / box.h * 100) + "%", clipPath: "" });
        return;
      }
      // A page without the boxes (an older index.html): the clip-path, as before.
      Object.assign(image.style, { left: (op.x / W * 100) + "%", top: (op.y / H * 100) + "%", width: (op.w / W * 100) + "%", height: (op.h / H * 100) + "%" });
      // The half's rectangle in the photograph's own box.
      image.style.clipPath = clip ? "inset(" + [Math.max(0, clip.y - op.y) / op.h * 100, Math.max(0, op.x + op.w - clip.x - clip.w) / op.w * 100,
        Math.max(0, op.y + op.h - clip.y - clip.h) / op.h * 100, Math.max(0, clip.x - op.x) / op.w * 100].map((v) => v.toFixed(3) + "%").join(" ") + ")" : "";
    }

    let splitShown = null;
    function showSplit(split) {
      if (splitShown === split) return;
      splitShown = split;
      root.classList.toggle("pk-split", split);
      if (plateImg2) {
        plateImg2.hidden = !split;
        if (split && !plateImg2.src && plateImg.src) plateImg2.src = plateImg.src;
      }
      if (!split) {
        plateImg.style.clipPath = ""; delete plateImg.dataset.rect; plateImg.style.visibility = "";
        for (const image of tallImgs) if (image) image.hidden = true;
      }
    }
    // A half's photograph where its "P" puts it: the tall plate's layer when the op names it, else the wide one's.
    function placeHalf(half, i) {
      const op = half.ops.find((o) => o.kind === "P");
      const wide = i === 0 ? plateImg : plateImg2, tall = op && op.tall ? tallImgs[i] : null;
      if (tallImgs[i]) tallImgs[i].hidden = !tall;
      if (wide) wide.style.visibility = tall ? "hidden" : "";
      placePlate(op, tall || wide, half.rect);
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

    // MARK: The weak plan's drawing (receiver 106)

    // The photographs as the weak plan draws them: the canvas's bitmaps, else the images.
    const wideSource = () => canvasPlate || (plate && plate.naturalWidth ? plate : null);
    const tallSource = () => canvasTall || tallPlate;
    // What a draw's photographs depend on: their ops and which pictures there are to draw them with.
    function plateKey(plateOps) {
      return plateOps.map((op) => [op.kind, op.x, op.y, op.w, op.h, op.tall ? 1 : 0].join(",")).join(";")
        + "|" + (canvasPlate ? "b" : plate ? "i" : "-") + (canvasTall ? "b" : tallPlate ? "i" : "-") + "|" + canvas.width;
    }
    // Under the photographs, where they don't reach: the page's own background (`.pk-stage`, a split screen's
    // `.pk-split .pk-court` gradient), in canvas pixels.
    let splitFill = null;
    function paintBackground(split) {
      if (split && !splitFill) {
        splitFill = ctx.createLinearGradient(0, 0, 0, canvas.height);
        splitFill.addColorStop(0, "#060e0c"); splitFill.addColorStop(0.55, "#0c1a17"); splitFill.addColorStop(1, "#0c1a17");
      }
      ctx.fillStyle = split ? splitFill : "#0c1a17";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    // A stage-point rectangle as the canvas pixels it touches, a pixel round it.
    function clipTo(box, k) {
      ctx.beginPath();
      ctx.rect(Math.floor(box.x * k) - 1, Math.floor(box.y * k) - 1, Math.ceil(box.w * k) + 3, Math.ceil(box.h * k) + 3);
      ctx.clip();
    }
    // The match's frame on the opaque canvas: whole when its photographs changed (or the canvas showed something else),
    // else only where the players, the ball and the rest were last time and are now.
    let weakKey = "";
    function drawWeak(ops, split) {
      const k = canvas.width / core.STAGE.width;
      const key = plateKey(ops.filter((op) => op.kind === "P" || op.kind === "V"));
      const bounds = union(ops.filter((op) => op.kind !== "P" && op.kind !== "V").map((op) => core.opBounds(op)));
      let dirty = null;
      if (key === weakKey) {
        dirty = union([lastDrawn, bounds]);
        // Nothing moves and nothing was drawn over the photographs: the canvas shows this frame already.
        if (!dirty) return 0;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.save();
      if (dirty) clipTo(dirty, k);
      paintBackground(split);
      ctx.setTransform(k, 0, 0, k, 0, 0);
      const missing = core.drawOps(ctx, ops, picture, wideSource(), true, tallSource());
      ctx.restore();
      weakKey = key; lastDrawn = bounds; stillShown = "";
      return missing;
    }
    // What a weak dongle's canvas shows when no match is drawn on it (under the ready and result cards, and while a
    // match's start warms its pictures): the photographs where they last were, with nobody on the court, as the layers
    // show them on other TVs. `rect` (stage points) paints only there. `stillOps`: the last frame's "P" and "V" ops (or
    // the match's first frame's), none for the wide photograph filling the stage.
    let stillOps = null, stillShown = "";
    function stillLayout() {
      if (stillOps && stillOps.length) return stillOps;
      const size = (plate && plate.naturalWidth && [plate.naturalWidth, plate.naturalHeight]) || (manifest && manifest.plate && manifest.plate.size) || [1672, 941];
      return [Object.assign({ kind: "P", tall: false }, core.plateLayout(size, core.STAGE.width, core.STAGE.height))];
    }
    function paintStill(rect) {
      if (!weak) return;
      sizeCanvas();
      const k = canvas.width / core.STAGE.width;
      const ops = stillLayout();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.save();
      if (rect) clipTo(rect, k);
      paintBackground(ops.some((op) => op.kind === "V"));
      ctx.setTransform(k, 0, 0, k, 0, 0);
      // A photograph still loading is left out (drawOps would fill its place with the court's blue): the page's
      // background shows there, as round a layer still loading on other TVs.
      core.drawOps(ctx, ops.filter((op) => op.kind !== "P" || (op.tall ? tallSource() : wideSource())), picture, wideSource(), true, tallSource());
      ctx.restore();
      if (!rect) { stillShown = plateKey(ops); weakKey = ""; lastDrawn = null; }
    }
    // The still painted whole where the view wants it and it is not up already; never over a match being drawn, or over
    // the warm-up's patch while it runs (it paints its own patch, `warmSome`).
    function showStill() {
      if (!weak || view === "off" || (view === "match" && drawn) || warmRaf || (starting && starting.phase === "warm")) return;
      canvas.style.visibility = "visible";
      if (stillShown === plateKey(stillLayout())) return;
      paintStill(null);
    }

    // Draws the frame for TV time `local`; true when something was drawn.
    function drawAt(local) {
      const shown = playout.at(local);
      if (!shown) return false;
      const started = now();
      const ops = shown.ops.map(core.decodeOp).filter(Boolean);
      const halves = core.halves(ops);
      showSplit(!!halves);
      // Receiver 106: a weak dongle's photographs are on its canvas, not layers.
      if (weak) {
        // Nothing to place.
      } else if (halves) {
        halves.forEach(placeHalf);
      } else {
        placePlate(ops.find((op) => op.kind === "P"));
      }
      applyPush(halves ? null : shown.push);
      let missing;
      if (weak) {
        stillOps = ops.filter((op) => op.kind === "P" || op.kind === "V");
        missing = drawWeak(ops, !!halves);
      } else {
        const k = canvas.width / core.STAGE.width;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        // Clear only where the last frame drew (the photograph is its own layer).
        const clear = lastDrawn;
        if (clear) ctx.clearRect(Math.floor(clear.x * k) - 1, Math.floor(clear.y * k) - 1, Math.ceil(clear.w * k) + 3, Math.ceil(clear.h * k) + 3);
        else ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(k, 0, 0, k, 0, 0);
        missing = core.drawOps(ctx, ops, picture, plate && (canvasPlate || plate), false, tallPlate && (canvasTall || tallPlate));
        lastDrawn = union(ops.filter((op) => op.kind !== "P" && op.kind !== "V").map((op) => core.opBounds(op)));
      }
      stats.missing += missing;
      renderHUD(core.hudView(shown.hud, shown.moment));
      stats.drawMs.push(now() - started);
      if (stats.lastDraw !== null) stats.draws.push(local - stats.lastDraw);
      stats.lastDraw = local;
      stats.stale = shown.stale; stats.queue = shown.ahead;
      if (!drawn && missing === 0 && plate) {
        drawn = true; applyView();
        if (debug && matchAt !== null) send({ t: "shown", ms: Math.round(now() - matchAt) });
      }
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
      set("names", h.names.join("|"), () => { setText(el("pk-you-name"), h.names[0]); setText(el("pk-cpu-name"), h.names[1]); });
      set("split", h.split, (v) => { if (hud) hud.classList.toggle("pk-split", v); });
      set("srv", h.serving, (v) => { el("pk-you-serve").classList.toggle("on", v === "you"); el("pk-cpu-serve").classList.toggle("on", v === "cpu"); });
      set("band", h.band.join("|"), () => { setText(el("pk-band-title"), h.band[0]); setText(el("pk-band-value"), h.band[1]); });
      // The banner and the shot callout; a split screen's right half has its own pair (`2`).
      for (const [suffix, b] of [["", h.banner], ["2", h.banner2]]) {
        const banner = el("pk-banner" + suffix);
        if (!banner) continue;
        set("banner" + suffix, b ? JSON.stringify(b) : "", () => {
          banner.hidden = !b;
          if (!b) return;
          Object.assign(banner.style, { left: b.x + "px", top: b.y + "px", width: b.width + "px" });
          banner.style.setProperty("--tone", b.color);
          const words = el("pk-banner" + suffix + "-text");
          words.style.fontSize = b.fontSize + "px";
          setText(words, b.text);
          // A new line fades in (the phone's .transition(.opacity)). Receiver 106: not on a weak dongle, where the fade
          // repaints the HUD every frame for its 0.2 s and the restart forces a layout.
          if (!weak) { banner.classList.remove("pk-in"); void banner.offsetWidth; banner.classList.add("pk-in"); }
        });
      }
      for (const [suffix, c, leading] of [["", h.callout, null], ["2", h.callout2, false]]) {
        const callout = el("pk-callout" + suffix);
        if (!callout) continue;
        callout.hidden = !c;
        if (c) {
          // In a split screen the left half's callout takes the left corner, the right half's the right.
          const lead = h.split ? suffix === "" : (leading === null ? c.leading : leading);
          set("callout" + suffix, c.title + "|" + c.grade + "|" + lead, () => {
            setText(el("pk-callout" + suffix + "-title"), c.title);
            const grade = el("pk-callout" + suffix + "-grade");
            setText(grade, c.grade.toUpperCase()); grade.hidden = !c.grade;
            callout.classList.toggle("good", c.good);
            callout.classList.toggle("leading", lead);
          });
          // Receiver 106: a weak dongle shows the callout whole for its 1.2 s, without the fade and lift that repaint the
          // HUD every frame.
          const alpha = weak ? "" : c.alpha.toFixed(3), lift = weak ? "" : "translateY(" + c.lift.toFixed(1) + "px)";
          if (callout.style.opacity !== alpha) callout.style.opacity = alpha;
          if (callout.style.transform !== lift) callout.style.transform = lift;
        } else hudShown["callout" + suffix] = "";
      }
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
      setText(el("pk-result-you-name"), r.names[0]);
      setText(el("pk-result-cpu-name"), r.names[1]);
      el("pk-result-you-side").classList.toggle("won", r.crowned === "you");
      el("pk-result-cpu-side").classList.toggle("won", r.crowned === "cpu");
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
      // Receiver 106: a weak dongle's canvas is up whenever the overlay is, the photographs under the cards on it.
      canvas.style.visibility = view === "match" && drawn ? "visible" : weak && view !== "off" ? canvas.style.visibility : "hidden";
      if (hud) hud.style.visibility = view === "match" && drawn ? "visible" : "hidden";
      if (view === "match" || view === "result") start(); else stop();
      showStill();
    }

    function setView(message) {
      const next = ["off", "ready", "match", "result"].includes(message.v) ? message.v : "off";
      if (message.ready) readyWords = message.ready;
      if (message.result) resultWords = message.result;
      if (next === "match" && view !== "match") {
        playout.reset(); if (clockOffset !== null) playout.setOffset(clockOffset); drawn = false; lastDrawn = null;
        // Receiver 106: an opaque canvas keeps its photograph (cleared, it would be black under the card).
        if (!weak) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); }
        weakKey = "";
      }
      const began = next === "match" && view !== "match";
      view = next;
      if (began) beginStart(); else if (view !== "match") starting = null;
      if (view !== "off") { loadPlate(); }
      // Each setup warms the pictures again: a Chromecast lets decoded pictures go (receiver 79).
      if (view === "ready") warm();
      applyView();
    }

    // MARK: Loop and stats

    // When the last animation frame ran: an arrival handled long after it was held up by the page, not the trip.
    let lastTick = null;
    // Receiver 106, the weak plan: frames handled just after the animation frame that ended one of the TV's own stalls
    // are kept out of the delay too (core.arrivalStalled). In e754c9zc and bzrb3cvj each freeze of the 32-bit TV (gap
    // 1000–1505) was followed by "late" arrivals that took the delay from ~130 to 205–220 ms for ~10 s (the TV's picture
    // and the phone's sounds that much further behind): frames held up by the TV itself, handled after its first
    // animation frame back, which receiver 79's rule (60 ms since the last animation frame) did not catch.
    let lastTickGap = 0;
    function frame() {
      raf = 0;
      if (!running) return;
      const t = now();
      if (view === "match" && stepStart(t)) drawAt(t);
      playout.settle(playout.target(averageGap()), lastTick === null ? 33 : t - lastTick);
      lastTickGap = lastTick === null ? 0 : t - lastTick;
      lastTick = t;
      maybeReport();
      raf = requestAnimationFrame(frame);
    }
    function start() { if (running) return; running = true; lastTick = null; sizeCanvas(); if (!options.manualClock) raf = requestAnimationFrame(frame); }
    function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }

    let arrivals = [];
    function averageGap() {
      if (arrivals.length < 3) return 33;
      return Math.max(16, Math.min(70, (arrivals[arrivals.length - 1] - arrivals[0]) / (arrivals.length - 1)));
    }

    function maybeReport(force) {
      const t = now();
      if (!force && t - stats.since < statsEvery) return;
      // Nothing of the match is drawn yet (receiver 97): no report of a picture that isn't there.
      if (!force && starting && starting.phase !== "steady") { stats.since = t; return; }
      const seconds = Math.max(0.001, (t - stats.since) / 1000);
      const message = {
        t: "stats", fps: Math.round(stats.draws.length / seconds * 10) / 10,
        gap: Math.round(core.percentile(stats.draws, 0.9)), frames: stats.frames,
        drawMs: Math.round(core.percentile(stats.drawMs, 0.5) * 10) / 10, queue: stats.queue || 0,
        stale: Math.round(stats.stale || 0), delay: Math.round(playout.delay), late: playout.counts.late, missing: stats.missing,
        warmed: stats.warmed || 0, warmMs: stats.warmMs || 0,
        // Receiver 106: the longest gap between draws (`gap` is the 90th percentile: one freeze in a report hides there).
        worst: Math.round(stats.draws.length ? Math.max(...stats.draws) : 0)
      };
      if (weak) message.weak = 1;
      if (view === "match") send(message);
      stats.draws = []; stats.drawMs = []; stats.frames = 0; stats.missing = 0; stats.since = t;
      if (debug && chip) { chip.hidden = false; chip.textContent = "fps " + message.fps + " · stale " + message.stale + " ms · delay " + message.delay + " ms"; }
      return message;
    }

    function report(where, error) {
      const receiverCore = typeof globalThis !== "undefined" ? globalThis.SlipSparkReceiverCore : null;
      send(Object.assign({ t: "error", where, message: String((error && error.message) || error) }, receiverCore ? receiverCore.failureReport(where, error) : {}));
    }

    // MARK: Messages

    let clockOffset = null;
    function handle(message) {
      if (!message || typeof message !== "object") return;
      switch (message.t) {
        case "hello":
          helloAt = now();
          debug = message.debug === 1;
          if (["frames", "visible", "hud", "none"].includes(message.warm)) warmMode = message.warm;
          // Benches: `hold: 0` starts a match as receiver 96 did; `stats` is the ms between reports (2000).
          holdOn = !options.manualClock && message.hold !== 0;
          statsEvery = Number(message.stats) >= 500 ? Number(message.stats) : 2000;
          if (chip) chip.hidden = !debug;
          // Receiver 106: the TV's own plan, or the bench's `x.weak` (1: draw as a 32-bit Chromecast does; 0: not).
          setWeak(message.x && typeof message.x === "object" && (message.x.weak === 0 || message.x.weak === 1) ? message.x.weak === 1 : weakDongle);
          preloadWhenWanted(message.look, message.sheets);
          {
            const ready = { t: "ready", pickleball: core.VERSION, version: RECEIVER_VERSION, looks: ["man", "woman"], friends: 1, tall: tallImgs[0] && tallImgs[1] ? 1 : 0, go: holdOn ? 1 : 0 };
            if (weak) ready.weak = 1;
            send(ready);
          }
          break;
        case "ping":
          send({ t: "pong", i: message.i, r: now() });
          break;
        case "sync":
          if (Number.isFinite(Number(message.o))) { clockOffset = Number(message.o); playout.setOffset(clockOffset); }
          break;
        case "view":
          setView(message);
          if ((message.look && message.look !== look) || (Array.isArray(message.sheets) && message.sheets.join() !== named.join())) {
            preloadWhenWanted(message.look || look, message.sheets);
          }
          break;
        case "f": {
          const local = now();
          const stalled = running && lastTick !== null && core.arrivalStalled(local - lastTick, lastTickGap, weak);
          if (playout.add(message, local, stalled)) {
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
      NAMESPACE, handle, drawAt, senderLeft, report, playout, preload, setView, selectGame,
      get pickleballWanted() { return pickleballWanted; },
      get view() { return view; }, get drawn() { return drawn; }, get look() { return look; },
      get starting() { return starting ? starting.phase : null; },
      get weak() { return weak; }, get canvas() { return canvas; },
      // Tests: the next draw is whole (receiver 106's weak plan otherwise paints only where things moved).
      drawWhole() { weakKey = ""; lastDrawn = null; },
      stats: () => maybeReport(true), sizeCanvas, picture, loaded: () => lookLoadedAt !== null,
      release() { stop(); pictures.clear(); },
      get bitmapBytes() { return bitmapBytes; }
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
