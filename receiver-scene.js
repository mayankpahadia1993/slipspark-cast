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
    let canvas = options.canvas;
    const hud = options.hud;
    const send = options.send;
    // The 16:9 box the stadium fills, in CSS pixels.
    const stageBox = options.stage || root;
    // Measured once per resize, not per frame: reading clientWidth in every
    // frame's backdrop placement forced a layout each frame (4% of a slowed
    // Chromecast page's thread, the bench's cpu=3 profile).
    let measuredBox = 0;
    const boxWidth = () => measuredBox || (measuredBox = stageBox.clientWidth || 0) || window.innerWidth;
    // Receiver 67 (build 215): where the TV's canvas holds anything, whole
    // pixels [l, t, r, b] each, so a draw clears only that (drawFrame); null
    // when that can't be told: cleared whole next time.
    let canvasDrawn = null;
    // Oct 19 2026 (iOS 202 on a 32-bit Chromecast: the weak plan's 854
    // canvas drew no faster than the 1280 one, 7–10 a second, each draw under
    // 10 ms of script; the loop's rate was set by what the TV did besides
    // the script). On a weak dongle the canvas is opaque and draws the photo
    // and the shading itself (`WEAK_TUNED`), so the TV composites one opaque
    // layer and the HUD, not the photo's layer, a see-through canvas over it
    // and two shading layers. `opaqueCanvas` is what the canvas was made with.
    let opaqueCanvas = false;
    let ctx = core.isWeakDongle(navigator.userAgent) ? opaqueContext(canvas) : canvas.getContext("2d");
    function opaqueContext(target) {
      const context = target.getContext("2d", { alpha: false });
      opaqueCanvas = true;
      return context;
    }
    // The canvas's alpha is fixed once it has a context: the other kind
    // takes a new canvas element in the same place (the bench's `x.weak` on
    // an Ultra; a weak dongle starts opaque).
    function setOpaque(want) {
      if (want === opaqueCanvas) return;
      const parent = canvas.parentNode;
      if (parent && parent.replaceChild && document.createElement) {
        const fresh = document.createElement("canvas");
        fresh.id = canvas.id;
        fresh.className = canvas.className;
        fresh.width = canvas.width;
        fresh.height = canvas.height;
        parent.replaceChild(fresh, canvas);
        canvas = fresh;
      }
      if (want) ctx = opaqueContext(canvas);
      else { ctx = canvas.getContext("2d"); opaqueCanvas = false; }
      canvasDrawn = null;
      layers.length = 0;
      needsRedraw = true;
    }
    // The opaque photo a frame starts from (the stadium, or the replay's
    // outfield) sits behind the canvas as an image the TV's GPU composites:
    // the Chromecast's canvas is drawn in software and can't fill the screen
    // with a photo thirty times a second. Anything it hides isn't drawn.
    // `options.backdrop` marks where the layers go, under the canvas. Each
    // photo gets its own layer, decoded once: swapping one element's source
    // between the stadium and the replay's outfield re-decoded it each time,
    // and the TV showed black meanwhile (build 121).
    const backdrop = options.backdrop;
    const backdropLayers = new Map();
    let backdropKey = null;
    let backdropTransform = "";
    const timeline = core.createTimeline();
    const clock = core.createClock();
    // The batter, drawn for now and shown as soon as it arrives ("b").
    const live = core.createLiveLayer();
    const images = new Map();
    const tinted = new Map();
    // Pictures the phone draws from commands ("pic": a dyed kit's pieces,
    // the practice net), by key: drawn here once into a canvas of their
    // own and then drawn as any photo, one drawImage a frame.
    const pictures = new Map();
    // Composed pictures in the order they were made: the oldest are let go
    // past `MAX_COMPOSED` (a Chromecast's memory is small) and made again
    // from their commands if a frame wants one.
    const composed = [];
    const MAX_COMPOSED = 36;
    const uploads = new Map();
    const wanted = new Set();
    const requested = new Set();
    const layers = [];
    let on = false;
    let debug = false;
    let scale = 1;
    let lastStamp = null;
    // Production's localStorage and IndexedDB names, or the staging copy's
    // own when it is served from the site's `staging/` folder (core.storageNames).
    const stored = core.storageNames(window.location && window.location.pathname);
    // The canvas's most pixels across (core.canvasPlan): 1920 on devices
    // that keep up, 1280 on the Chromecast dongles, whose software raster
    // can't fill 1920 x 1080 thirty times a second. The phone can set it.
    let plan = core.canvasPlan({ ua: navigator.userAgent, pinned: options.canvasWidth, remembered: rememberedCanvas() });
    let maxCanvasWidth = plan.width;
    const rateWatch = core.createRateWatch({ minFps: core.CANVAS.minFps });
    // The last frame drawn, drawn again at once when the canvas narrows.
    let shownFrame = null;
    let smoothing = "low";
    let lastLoop = 0;
    // A picture arrived or the screen changed size: draw the frame again.
    let needsRedraw = false;
    let lastAck = 0;
    let lastStats = 0;
    let lastNeed = 0;
    let readyToAnswer = false;
    let pendingHello = false;
    let helloKit = null;
    const counters = { draws: 0, blended: 0, frames: 0, late: [], drawMs: [], missing: 0, redraws: 0, gaps: [], live: 0, pose: [], ahead: [], eff: [],
      js: 0, long: 0, lag: [], partly: 0, stale: [] };

    // What the page's thread does besides drawing (Oct 19 2026): `js`, the
    // script's own time in the loop and the messages; `long`, tasks of 50 ms
    // or more (any work: the canvas's raster, layers, garbage); `lag`, how
    // late a 50 ms timer fires. A TV whose loop runs every 105 ms with the
    // thread free (lag near 0) waits on its compositor, not on this page.
    try {
      if (window.PerformanceObserver) {
        new window.PerformanceObserver((list) => { list.getEntries().forEach((entry) => { if (on) counters.long += entry.duration; }); })
          .observe({ entryTypes: ["longtask"] });
      }
    } catch (error) { /* no long tasks here */ }
    function lagTick() {
      const due = performance.now() + 50;
      window.setTimeout(() => {
        if (on) counters.lag.push(Math.max(0, performance.now() - due));
        lagTick();
      }, 50);
    }

    // MARK: Sizing

    // What this TV found last time (a device too slow for 1920), so the next
    // cast starts narrow. Local storage may be missing or blocked.
    function rememberedCanvas() {
      try { return JSON.parse(window.localStorage.getItem(stored.canvas) || "null"); } catch (error) { return null; }
    }

    function rememberCanvas(width) {
      try {
        window.localStorage.setItem(stored.canvas, JSON.stringify({ ua: navigator.userAgent, width }));
      } catch (error) { /* the next cast measures again */ }
    }

    // The wide canvas fell below the frame rate: narrow it for good. The
    // frame on screen is drawn again in the same animation frame, so the TV
    // never shows the cleared canvas.
    function narrowCanvas() {
      plan = { width: core.CANVAS.narrow, adaptive: false, why: "slow", weak: false };
      maxCanvasWidth = plan.width;
      rememberCanvas(plan.width);
      resize();
      if (shownFrame) { drawFrame(shownFrame); needsRedraw = false; }
    }

    function resize() {
      measuredBox = 0;
      const width = core.canvasWidth(boxWidth(), window.devicePixelRatio, maxCanvasWidth);
      const height = Math.round(width * STAGE.height / STAGE.width);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        canvasDrawn = null;
        layers.length = 0;
        needsRedraw = true;
        backdropLayers.forEach((entry) => { entry.transform = ""; });
      }
      scale = canvas.width / STAGE.width;
      const stageScale = boxWidth() / HUD_STAGE.width;
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
    // The size each picture is drawn at, in the phone's pixels: the size in
    // its key, whatever the size of the file (core.pictureSize).
    const sizes = new Map();

    function addImage(key, source) {
      images.set(key, source);
      if (staticLayer) { staticLayer.key = null; staticLayer.keys = null; }
      sizes.set(key, core.pictureSize(key)
        || { width: source.naturalWidth || source.width, height: source.naturalHeight || source.height });
      needsRedraw = true;
      loading.delete(key);
      wanted.delete(key);
      requested.delete(key);
      // A picture waiting for this photo can be made now.
      pictures.forEach((entry, pictureKey) => {
        if (!entry.ready && entry.uses.indexOf(key) >= 0) compose(pictureKey);
      });
    }

    // MARK: Composed pictures

    // A picture from the phone: the commands that draw it in its own pixels.
    function receivePicture(message) {
      const key = String(message.k || "");
      const width = Math.round(Number(message.w));
      const height = Math.round(Number(message.h));
      if (!key || !(width > 0) || !(height > 0) || !Array.isArray(message.o)) return;
      const existing = pictures.get(key);
      if (existing && existing.ready && images.has(key)) { send({ t: "got", k: key }); return; }
      const frame = core.normalizeFrame({ s: 0, o: message.o, fl: message.fl, cl: message.cl });
      if (!frame) return;
      const uses = [];
      for (const op of frame.o) if (op[0] === "i" && uses.indexOf(op[3]) < 0) uses.push(op[3]);
      pictures.set(key, { frame, width, height, opaque: message.op === 1, fallback: message.fb || null, uses, ready: false });
      loading.add(key);
      wanted.delete(key);
      requested.delete(key);
      compose(key);
    }

    // Draws a picture into its canvas once every photo it uses is here.
    function compose(key) {
      const entry = pictures.get(key);
      if (!entry || entry.ready) return;
      const missing = entry.uses.filter((use) => !images.has(use));
      if (missing.length) { missing.forEach(ensure); return; }
      // Made at the size its bitmap would be kept at (receiver 58): a dyed
      // kit's eleven pieces, made as the stadium comes on, cost a quarter.
      // An opaque one (the practice lane) is shown on the GPU layer, sharp.
      const factor = entry.opaque ? 1 : pictureFactor(key, entry.width, entry.height, false);
      const target = document.createElement("canvas");
      target.width = Math.max(1, Math.round(entry.width * factor));
      target.height = Math.max(1, Math.round(entry.height * factor));
      paint(target.getContext("2d"), entry.frame, 0, { s: factor, width: target.width, height: target.height, layers: [] });
      // The tinted copies were for this picture: frames draw the picture.
      tinted.clear();
      entry.ready = true;
      loading.delete(key);
      addImage(key, target);
      composed.push(key);
      while (composed.length > MAX_COMPOSED) {
        const old = composed.shift();
        const gone = pictures.get(old);
        if (gone && old !== key) { gone.ready = false; images.delete(old); opaque.delete(old); }
      }
      send({ t: "got", k: key });
      // An opaque picture (the practice net) goes on the GPU layer as a
      // photo does: an image with a source, not a canvas.
      if (entry.opaque && typeof target.toBlob === "function") {
        target.toBlob((blob) => {
          if (!blob || images.get(key) !== target) return;
          loadImage(URL.createObjectURL(blob)).then((image) => {
            if (images.get(key) !== target) return;
            images.set(key, image);
            opaque.add(key);
            needsRedraw = true;
          }, () => {});
        }, "image/jpeg", 0.92);
      }
    }

    // Decoded before it is first drawn, so a frame never waits on a photo
    // (unless `decode` is false: its bitmap is drawn instead).
    function loadImage(url, decode) {
      return new Promise((resolve, reject) => {
        const image = new Image();
        image.onerror = () => reject(new Error("image " + url));
        image.onload = () => {
          if (image.decode && decode !== false) image.decode().then(() => resolve(image), () => resolve(image));
          else resolve(image);
        };
        image.src = url;
      });
    }

    // Decoded copies of the pictures, drawn in their place (receiver 57).
    // A Chromecast Ultra keeps few pictures decoded: by the time the stadium
    // came on, most of those decoded at hello had been let go, and its first
    // frame decoded ~40 of them again on the spot (30–190 ms each, measured
    // on the TV): iOS 161's stadium opened on one 3.2 s frame. A bitmap is
    // decoded once, off the page's thread, and stays decoded. On a 1280
    // canvas a sprite is kept at half its size (drawn at most ~0.4 of it:
    // the bowler 0.13–0.20, fielders 0.18–0.39, the batter 0.07–0.33) and a
    // photo at the stage's size: about 21 MB for all 65 pictures, not 50.
    const bitmaps = new Map();
    const canBitmap = typeof window.createImageBitmap === "function";

    // How much of its own size a picture is kept at: on a 1280 canvas half
    // for a sprite, the stage's size for a photo; all of it drawing 1920.
    function pictureFactor(key, width, height, isOpaque) {
      if (maxCanvasWidth > core.CANVAS.narrow) return 1;
      if (isOpaque) return Math.min(1, STAGE.width / width);
      return Math.max(width, height) >= 200 ? 0.5 : 1;
    }

    function bitmapOptions(key) {
      const size = core.pictureSize(key);
      if (!size) return null;
      const factor = pictureFactor(key, size.width, size.height, opaque.has(key));
      if (factor >= 1) return null;
      return { resizeWidth: Math.max(1, Math.round(size.width * factor)), resizeHeight: Math.max(1, Math.round(size.height * factor)),
        resizeQuality: "high" };
    }

    // A picture from `url` (its bytes in `blob` if at hand): the image, the
    // GPU layer's source, and its decoded bitmap (null without), both in
    // before a frame draws it.
    function decodePicture(key, url, blob) {
      if (!canBitmap || !tune.bitmaps) return loadImage(url).then((image) => ({ image, bitmap: null }));
      const bytes = blob ? Promise.resolve(blob)
        : fetch(url).then((response) => { if (!response.ok) throw new Error("fetch " + url); return response.blob(); });
      const bitmap = bytes.then((data) => {
        const options = bitmapOptions(key);
        // A browser that can't resize makes it at its own size.
        return options ? window.createImageBitmap(data, options).catch(() => window.createImageBitmap(data)) : window.createImageBitmap(data);
      }).then((made) => (made && made.width > 0 && made.height > 0 ? made : null)).catch(() => null);
      return Promise.all([loadImage(url, false), bitmap]).then(([image, decoded]) => {
        // No bitmap: the image, decoded as before.
        if (!decoded) return (image.decode ? image.decode().catch(() => {}) : Promise.resolve()).then(() => ({ image, bitmap: null }));
        return { image, bitmap: decoded };
      });
    }

    function loadPicture(key, url, blob) {
      return decodePicture(key, url, blob).then(({ image, bitmap }) => {
        if (bitmap) {
          const old = bitmaps.get(key);
          if (old && old.close) old.close();
          bitmaps.set(key, bitmap);
        }
        addImage(key, image);
        return image;
      });
    }

    // MARK: Atlases (Oct 20 2026)
    //
    // Build 207 on the Living Room TV's Chromecast Ultra ("Lag with
    // chromecast"): build 206's bowler's-end inset added 75 pictures, about
    // half the receiver's 141. Three at a time, ~9 a second, they were still
    // loading, and decoding as they were first drawn, through the innings'
    // first 18 s: 1, 6, 18, 11, 14, 20, 20, 18 fps, then 26–28 once all were
    // in. Its batter frames and keeper poses now come in a few atlases
    // (`atlases.json`, scripts/cast-inset-atlas.mjs): three files, loaded and
    // warmed with the first frame's pictures. A picture from an atlas is its
    // rect there, drawn where that rect sits in the picture's own frame
    // (`drawPicture`): the same pixels as its own file, but for the browser's
    // rounding of where it samples (under 1 pixel in 2,000, mostly by a step
    // of one: receiver-inset-atlas.test.cjs). Its key, the `have` in `ready` and what
    // the phone sends are as before; its own file stays the fallback if an
    // atlas won't load.
    const sheets = new Map();
    const cuts = new Map();

    // `atlases.json`: each atlas's file and size, and each picture's atlas,
    // rect there, where that rect sits in its frame, and the frame's size.
    // Anything that doesn't add up is left to its own file.
    function readAtlases(data) {
      if (!data || typeof data !== "object" || !data.sheets || !data.frames) return;
      const whole = (value, low) => Number.isInteger(value) && value >= low;
      Object.entries(data.sheets).forEach(([id, sheet]) => {
        if (!sheet || typeof sheet.file !== "string" || !/^[A-Za-z0-9._-]+\.png$/.test(sheet.file)) return;
        if (!whole(sheet.width, 1) || !whole(sheet.height, 1) || sheet.width > 4096 || sheet.height > 4096) return;
        sheets.set(id, { id, file: sheet.file, width: sheet.width, height: sheet.height, keys: [], image: null, bitmap: null,
          promise: null, failed: false, warmed: false });
      });
      Object.entries(data.frames).forEach(([key, frame]) => {
        const sheet = frame && sheets.get(frame.atlas);
        if (!sheet || !Array.isArray(frame.rect) || !Array.isArray(frame.offset) || !Array.isArray(frame.size)) return;
        const [x, y, w, h] = frame.rect, [ox, oy] = frame.offset, [width, height] = frame.size;
        if (![x, y, ox, oy].every((v) => whole(v, 0)) || ![w, h, width, height].every((v) => whole(v, 1))) return;
        if (x + w > sheet.width || y + h > sheet.height || ox + w > width || oy + h > height) return;
        cuts.set(key, { atlas: sheet.id, x, y, w, h, ox, oy, width, height });
        sheet.keys.push(key);
      });
    }

    function addSprites(sheet) {
      sheet.keys.forEach((key) => {
        const cut = cuts.get(key);
        if (!images.has(key)) addImage(key, { sprite: true, sheet, cut, naturalWidth: cut.width, naturalHeight: cut.height });
      });
    }

    // The atlas a picture comes from, unless that atlas wouldn't load.
    function cutOf(key) {
      const cut = cuts.get(key);
      return cut && !sheets.get(cut.atlas).failed ? cut : null;
    }

    // Loads an atlas once (again after a release): each of its pictures is
    // then in `images` as a sprite, drawn from it. Its pictures already here
    // (a recording's, the phone's) stay as they are.
    function loadSheet(id) {
      const sheet = sheets.get(id);
      if (!sheet || sheet.failed) return Promise.resolve();
      if (sheet.image) addSprites(sheet);
      if (sheet.promise) return sheet.promise;
      const waiting = sheet.keys.filter((key) => !images.has(key));
      waiting.forEach((key) => loading.add(key));
      sheet.promise = decodePicture(id, "scene-images/" + sheet.file).then(({ image, bitmap }) => {
        // A file that isn't the size the manifest says is out of date.
        if ((image.naturalWidth || image.width) !== sheet.width || (image.naturalHeight || image.height) !== sheet.height) {
          throw new Error("atlas " + sheet.file + " is " + (image.naturalWidth || image.width) + "x" + (image.naturalHeight || image.height));
        }
        if (released) { if (bitmap && bitmap.close) bitmap.close(); sheet.promise = null; return; }
        sheet.image = image;
        sheet.bitmap = bitmap;
        addSprites(sheet);
        warmSheet(sheet);
      }).catch((error) => {
        // Each of its pictures from its own file, as before the atlases.
        sheet.failed = true;
        waiting.forEach((key) => loading.delete(key));
        if (!insetOff) {
          preloadQueue.push(...waiting.filter((key) => bundled.has(key) && !images.has(key)));
          while (preloading < 3 && pumpPreload()) { /* three at a time */ }
        }
        report("atlas", error);
      });
      return sheet.promise;
    }

    // The receiver's own pictures, and those earlier casts left in its cache
    // (receiver 53), three at a time: by the first ball every one is ready.
    //
    // Receiver 60: from the moment the page is up, not from the phone's
    // hello, and the innings' first frame's pictures first. The user's iOS
    // 166 (Oct 15 2026) played 1.4 s after the TV answered, the stadium came
    // on 4.8 s after it, and the receiver had loaded 49 of its 87 pictures,
    // in the manifest's order: the stadium photo and the batter last. The
    // first frame waited 0.5 s, the stadium was whole 1.7 s after it came
    // on and drew 11 frames a second with 72 draws missing a picture
    // (scripts/cast-start-bench.py reproduces it: HOME_WAIT=1 SYNC_PINGS=4).
    // A phone's hello can name its kit (`kit`), whose cached pieces then come
    // with the batter's.
    let preloadQueue = [];
    let preloading = 0;
    let preloadKit = null;
    // Receiver 68: no bowler's-end view on any Chromecast dongle (core.drawsInset).
    const insetOff = !core.drawsInset(navigator.userAgent);
    function preloadRank(key) {
      // The bowler's-end inset (Oct 20 2026): its view, the batter at the
      // crease and the keeper down are in the first frame; the strokes later.
      // Its atlases hold all three of those with every stroke: with the
      // first frame's, so all are in and warmed before the first ball.
      if (cutOf(key)) return 2;
      if (/^bowler-end-(inset|batter-stance|keeper-crouch)-/.test(key)) return 2;
      if (/^bowler-end-/.test(key)) return 8;
      if (/^stadium-/.test(key)) return 0;
      if (/^stroke-/.test(key)) return 1;
      if (preloadKit && key.indexOf("kit-" + preloadKit + "-") === 0) return 1;
      if (/^bowler-11-/.test(key)) return 2;
      if (/^bowler-/.test(key)) return 3;
      if (/^fielder-[A-Za-z]+-idle-/.test(key)) return 4;
      if (/^field-outfield-/.test(key)) return 5;
      if (/^fielder-/.test(key)) return 6;
      if (/^kit-/.test(key) && !preloadKit) return 6;
      return 7;
    }
    function preloadBundled(kit) {
      if (typeof kit === "string" && /^[a-z0-9-]{1,40}$/.test(kit)) preloadKit = kit;
      // This TV's own copies of pictures earlier casts sent too (receiver
      // 53): build 158's innings opened with 22–59 draws a second missing a
      // photo the TV had cached but not yet loaded.
      const byRank = (a, b) => preloadRank(a) - preloadRank(b);
      const extra = Array.from(cached).filter((key) => !bundled.has(key)).sort(byRank).slice(0, MAX_CACHED_PRELOAD);
      // A weak dongle draws no bowler's-end inset (the phone leaves it out).
      const wanted = (key) => !(insetOff && /^bowler-end-/.test(key));
      // An atlas once, in its first picture's place.
      const atlases = new Set();
      const once = (key) => {
        const cut = cutOf(key);
        if (!cut) return true;
        if (atlases.has(cut.atlas)) return false;
        atlases.add(cut.atlas);
        return true;
      };
      preloadQueue = Array.from(bundled.keys()).concat(extra).filter(wanted).sort(byRank).filter(once);
      while (preloading < 3 && pumpPreload()) { /* three at a time */ }
    }
    function pumpPreload() {
      while (preloadQueue.length && (images.has(preloadQueue[0]) || loading.has(preloadQueue[0]))) preloadQueue.shift();
      if (!preloadQueue.length) return false;
      const key = preloadQueue.shift();
      preloading += 1;
      const cut = cutOf(key);
      if (cut) {
        loadSheet(cut.atlas).then(() => { preloading -= 1; window.setTimeout(pumpPreload, 20); });
        return true;
      }
      loading.add(key);
      const source = bundled.has(key) ? Promise.resolve("scene-images/" + bundled.get(key))
        : database ? loadCached(key) : Promise.reject(new Error("no cache"));
      source.then((url) => loadPicture(key, url))
        .then(() => {
          // The stadium's photos get their GPU layer now, decoded while the
          // setup shows: made at the first frame, it took the first stadium
          // of a cast 0.7-1 s on a Chromecast Ultra.
          // Receiver 65: the replay's outfield too (made at the first replay,
          // it cost an onn's first replay a 283 ms/s of long tasks).
          if (/^(stadium-(ground|backdrop)|field-outfield)-/.test(key) && opaque.has(key)) backdropLayer(key);
          warmDecode(key);
        }, () => loading.delete(key))
        .then(() => { preloading -= 1; window.setTimeout(pumpPreload, 20); });
      return true;
    }

    // Warm-up v2: each preloaded picture is drawn once, while the stadium is
    // off (home and setup screens), into a 256×256 canvas: big enough to be
    // on the GPU, so the picture is decoded and its texture uploaded before
    // the innings. A Chromecast Ultra with its page slowed threefold (the
    // bench's cpu=3, like a 32-bit Chromecast) opened the stadium at 2 fps
    // with a 1×1 target (decode only) and at 8–10 with this one. Build 198's
    // canvas the stadium's size cost nothing measurable either (Oct 18 2026:
    // its 7–9 fps were a 32-bit Chromecast at a party, not the warm-up). The
    // canvas is let go as the stadium comes on. Photos with their own GPU
    // layer are skipped: the layer uploads them. "tiny" (1×1) and "off" for A/B.
    const WARM_MODE = "gpu";
    const warmed = new Set();
    let warmCanvas = null;
    function warmDecode(key) {
      if (WARM_MODE === "off" || on || warmed.has(key) || released) return;
      if (backdropLayers.has(key)) return;
      const image = images.get(key);
      if (!image) return;
      if (image.sprite) { warmSheet(image.sheet); return; }
      if (warmUpload(bitmaps.get(key) || image)) warmed.add(key);
    }
    // An atlas is warmed once, whole: each of its pictures with it.
    function warmSheet(sheet) {
      if (WARM_MODE === "off" || on || sheet.warmed || released || !sheet.image) return;
      if (!warmUpload(sheet.bitmap || sheet.image)) return;
      sheet.warmed = true;
      sheet.keys.forEach((key) => { const image = images.get(key); if (image && image.sheet === sheet) warmed.add(key); });
    }
    function warmUpload(source) {
      try {
        // "gpu": a 256×256 canvas, big enough to be on the GPU, so each picture's texture is uploaded now.
        const side = WARM_MODE === "gpu" ? 256 : 1;
        if (!warmCanvas) { warmCanvas = document.createElement("canvas"); warmCanvas.width = side; warmCanvas.height = side; }
        warmCanvas.getContext("2d").drawImage(source, 0, 0, side, side);
        return true;
      } catch (error) { return false; /* decoded at the first frame instead */ }
    }
    function dropWarmCanvas() {
      if (!warmCanvas) return;
      try { warmCanvas.width = 0; warmCanvas.height = 0; } catch (error) { /* gone */ }
      warmCanvas = null;
    }

    // MARK: The rehearsal (receiver 65)
    //
    // Oct 21 2026 (the owner: "worse at the start"): with every picture
    // loaded and warmed, an onn still drew the first ball at 17–32 frames a
    // second, its draws taking 6–12 ms of script against 3.5–4.5 by the
    // third ball and its long tasks 160–280 ms a second; the stream replay at
    // CPU/24 opened at 7 frames a second against 28 a ball later. That is the
    // drawing's own first time: its code not yet compiled for speed, each
    // picture decoded and uploaded at the size it is drawn, its layers and
    // gradients made. So while the stadium is off, once the phone has said
    // hello and the pictures are in, the receiver draws a recorded ball
    // (`rehearsal.json`, scripts/cast-rehearsal.mjs: the stadium, the
    // run-up, the delivery, the shot and its replay, each with its live
    // batter) into a canvas of the stadium's size off screen, one moment an
    // animation frame, blended as play is, `REHEARSAL_DRAWS` times. It stops
    // the moment the stadium comes on. `stats.rehearsed` counts its draws and
    // `rehearseMs` says how long its first and last ten took.
    const REHEARSAL_DRAWS = 200;
    // A weak dongle (each draw costs it ~30 ms of its page's thread) draws
    // fewer, about every third animation frame, so its setup screen stays
    // smooth meanwhile.
    const WEAK_REHEARSAL_DRAWS = 60;
    const WEAK_REHEARSAL_GAP = 90;
    let rehearsing = false;
    // A frame older than this when drawn is a pause's held frame, not a stale picture (stats `stale`).
    const STALE_FLOWING = 250;
    const rehearsal = { data: null, wanted: false, timeline: null, canvas: null, ctx: null, moment: 0, end: 0, draws: 0, ms: [], firstMs: 0, lastAt: -Infinity };

    function loadRehearsal() {
      return fetch("rehearsal.json").then((response) => (response && response.ok && typeof response.json === "function" ? response.json() : null))
        .then((data) => {
          if (!data || !Array.isArray(data.frames) || !data.frames.length) return;
          rehearsal.data = data;
          // A hello that came first.
          if (rehearsal.asked && !on) wantRehearsal();
        }).catch(() => {});
    }

    // Due after each hello (the phone's innings is coming) once the
    // pictures are in; the weak plan's own canvas and tune with it.
    function wantRehearsal() {
      rehearsal.asked = true;
      if (!rehearsal.data || options.noRehearsal) return;
      rehearsal.wanted = true;
      rehearsal.draws = 0;
      rehearsal.ms = [];
      rehearsal.firstMs = 0;
    }

    function startRehearsalPass() {
      const step = Number(rehearsal.data.step) || 33;
      rehearsal.timeline = core.createTimeline({ normalize: core.plainFrame });
      rehearsal.data.frames.forEach((frame, index) => rehearsal.timeline.add(Object.assign({ s: index * step }, frame), 1));
      rehearsal.live = rehearsal.data.frames.map((_, index) => {
        const batter = rehearsal.data.live && rehearsal.data.live[index];
        return batter ? core.plainFrame(Object.assign({ s: index * step }, batter)) : null;
      });
      rehearsal.step = step;
      rehearsal.moment = 0;
      rehearsal.end = (rehearsal.data.frames.length - 1) * step;
    }

    function rehearse(local) {
      if (!rehearsal.wanted || on || released || preloadQueue.length || preloading) return;
      if (plan.weak && local - rehearsal.lastAt < WEAK_REHEARSAL_GAP) return;
      if (!rehearsal.canvas || rehearsal.canvas.width !== canvas.width || rehearsal.canvas.height !== canvas.height) {
        rehearsal.canvas = document.createElement("canvas");
        rehearsal.canvas.width = canvas.width;
        rehearsal.canvas.height = canvas.height;
        rehearsal.ctx = rehearsal.canvas.getContext("2d", { alpha: !opaqueCanvas });
      }
      if (!rehearsal.timeline || rehearsal.moment > rehearsal.end) startRehearsalPass();
      const result = rehearsal.timeline.at(rehearsal.moment);
      const batter = rehearsal.live[Math.min(rehearsal.live.length - 1, Math.floor(rehearsal.moment / rehearsal.step))];
      // Half a recorded frame a draw: every other one blended, as a TV
      // drawing twice the phone's rate does.
      rehearsal.moment += rehearsal.step / 2;
      rehearsal.lastAt = local;
      if (!result) return;
      const savedCtx = ctx, savedCanvas = canvas;
      // The static layer's counts are the stadium's (stats `cached`, `rebuilt`).
      const counts = { built: staticLayer.built, hits: staticLayer.hits, ops: staticLayer.ops, draws: staticLayer.draws };
      ctx = rehearsal.ctx;
      canvas = rehearsal.canvas;
      rehearsing = true;
      const began = performance.now();
      try {
        drawFrame(result.frame, batter);
      } catch (error) {
        rehearsal.wanted = false;
        report("rehearsal", error);
      } finally {
        ctx = savedCtx;
        canvas = savedCanvas;
        rehearsing = false;
        Object.assign(staticLayer, counts);
      }
      const ms = performance.now() - began;
      rehearsal.draws += 1;
      rehearsal.ms.push(ms);
      if (rehearsal.ms.length === 10) rehearsal.firstMs = Number(core.percentile(rehearsal.ms, 0.5).toFixed(1));
      if (rehearsal.ms.length > 40) rehearsal.ms.splice(10, rehearsal.ms.length - 40);
      if (rehearsal.draws >= (plan.weak ? WEAK_REHEARSAL_DRAWS : REHEARSAL_DRAWS)) endRehearsal();
    }

    // Done, or the stadium came on: the canvas let go, and the static layer
    // starts afresh from the first real frame.
    function endRehearsal() {
      rehearsal.wanted = false;
      rehearsal.timeline = null;
      if (rehearsal.canvas) { try { rehearsal.canvas.width = 0; rehearsal.canvas.height = 0; } catch (error) { /* gone */ } }
      rehearsal.canvas = null;
      rehearsal.ctx = null;
      staticLayer.key = null;
      staticLayer.keys = null;
      staticLayer.rects = null;
      lastStaticKeys = null;
      lastCandidateKey = null;
    }

    // The first frame after the stadium comes on drawn with every picture
    // it needs: the phone holds the first ball until then (receiver 53).
    let wholeSent = false;
    let wholeAt = 0;
    function noteWhole(missingBefore) {
      if (wholeSent || !on || counters.missing !== missingBefore) return;
      wholeSent = true;
      wholeAt = performance.now();
      send({ t: "whole" });
      // Receiver 65: from the first whole frame, how steadily it draws.
      if (!steadyWatch.started) steadyWatch.start(wholeAt);
      // Receiver 70: the picture no longer stays up while a phone waits for steady (see frameStep).
    }

    // Receiver 65: the TV draws steadily (core.createSteadyWatch), once a
    // stadium-on; a phone that says so in its hello holds the first ball
    // until then and the phone's picture stays over the stadium meanwhile, at
    // most STEADY_COVER_MS (the phone's own cap, CastSceneStreamer.steadyLimit).
    const steadyWatch = core.createSteadyWatch();
    const STEADY_COVER_MS = 8000;
    let phoneWaitsSteady = false;
    let onAt = 0;
    function noteSteady(verdict, local) {
      if (!verdict) return;
      send({ t: "steady", fps: verdict.fps, why: verdict.why, ms: verdict.after, on: Math.round(local - onAt) });
    }

    // The words over the phone's picture while the TV gets ready: the setup's
    // pill and ring (card-hold), filling as the TV draws without a hitch.
    let warmingShown = false;
    let warmingDrawnAt = 0;
    function showWarming(local) {
      const node = document.getElementById ? document.getElementById("card-warming") : null;
      const want = !!root.dataset.warming && phoneWaitsSteady && wholeSent && local - wholeAt >= 400
        && document.body.dataset.card === "picture";
      if (!node) return;
      if (want !== warmingShown) { node.hidden = !want; warmingShown = want; }
      if (want && local - warmingDrawnAt >= 100 && window.RallycadeHold) {
        warmingDrawnAt = local;
        window.RallycadeHold(node, steadyWatch.progress(local), "Getting the TV ready");
      }
    }

    // Receiver 60: as the stadium comes on, the phone's picture (its setup,
    // held as the innings starts) stays over it until a frame has every
    // picture and the stadium photo is on its own layer, at most COVER_MS
    // (the phone holds the first ball as long: CastSceneStreamer.warmLimit),
    // rather than a stadium drawn with holes at a few frames a second. The
    // first stadium of a cast also spent ~0.3 s making the photo's layer
    // (a 0.7 s gap on the Living Room TV's Chromecast Ultra, however long
    // the setup): the stadium is drawn meanwhile, all but transparent, so
    // that work is done under the picture. With no picture up the stadium
    // shows at once (receiver.css).
    const COVER_MS = 3000;
    let coverUntil = 0;
    // The frame's stadium photo is drawn on the canvas, its layer not yet
    // decoded; and when its layer first showed.
    let photoPending = false;
    let layerShownAt = 0;
    let framePhoto = false;
    function uncover() {
      // Receiver 70: the page hears the stadium has drawn over the phone's picture (or gone off).
      if (root.dataset.warming && options.onCover) options.onCover(false);
      if (root.dataset.warming) delete root.dataset.warming;
      if (warmingShown) { const node = document.getElementById("card-warming"); if (node) node.hidden = true; warmingShown = false; }
      settleLayers();
    }

    // Receiver 65: under the phone's picture, each photo layer that hasn't
    // been on screen yet (the replay's outfield) is shown for a few frames so
    // the TV uploads it now, not at the first replay. Only while the picture
    // covers the stadium (the stadium all but transparent under it).
    let layerWarming = null;
    function warmLayers(local) {
      if (document.body.dataset.card !== "picture") return;
      if (layerWarming) {
        if (local - layerWarming.at < 70) return;
        if (backdropKey !== layerWarming.key) layerWarming.entry.element.style.opacity = "0";
        layerWarming = null;
        return;
      }
      for (const [key, entry] of backdropLayers) {
        if (entry.ready && !entry.shown && key !== backdropKey) {
          entry.shown = true;
          entry.element.style.opacity = "1";
          layerWarming = { key, entry, at: local };
          return;
        }
      }
    }
    // Receiver 70: every photo layer loaded has been on screen (the cover now ends once they have, COVER_MS at most).
    function layersWarm() {
      if (layerWarming) return false;
      for (const [key, entry] of backdropLayers) if (entry.ready && !entry.shown && key !== backdropKey) return false;
      return true;
    }
    function settleLayers() {
      if (!layerWarming) return;
      if (backdropKey !== layerWarming.key) layerWarming.entry.element.style.opacity = "0";
      layerWarming = null;
    }

    // Cached pictures loaded at hello, at most.
    const MAX_CACHED_PRELOAD = 48;

    function loadBundled() {
      const pictures = fetch("scene-images/manifest.json").then((response) => response.ok ? response.json() : { images: {} })
        .then((manifest) => {
          Object.entries((manifest && manifest.images) || {}).forEach(([key, file]) => {
            bundled.set(key, file);
            if (/\.jpe?g$/i.test(file)) opaque.add(key);
          });
        }).catch(() => {});
      // The inset's atlases (a receiver folder without them: each picture its own file).
      const atlases = fetch("scene-images/atlases.json")
        .then((response) => (response && response.ok && typeof response.json === "function" ? response.json() : null))
        .then(readAtlases).catch(() => {});
      // Receiver 65: the rehearsal's recorded ball (~26 KB on the wire), never in the hello's way.
      loadRehearsal();
      return Promise.all([pictures, atlases]);
    }

    let database = null;
    function openCache() {
      return new Promise((resolve) => {
        if (!window.indexedDB) { resolve(); return; }
        let request;
        try { request = window.indexedDB.open(stored.pictures, 1); } catch (error) { resolve(); return; }
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
      if (images.has(key) || requested.has(key)) return;
      // A picture let go to save memory is made again from its commands.
      const picture = pictures.get(key);
      if (picture) { compose(key); return; }
      if (loading.has(key)) return;
      // A picture in an atlas comes with the atlas (its own file if that fails).
      const cut = cutOf(key);
      if (cut) { loadSheet(cut.atlas); return; }
      const ask = () => { loading.delete(key); cached.delete(key); bundled.delete(key); wanted.add(key); };
      if (bundled.has(key)) {
        loading.add(key);
        loadPicture(key, "scene-images/" + bundled.get(key)).catch(ask);
      } else if (cached.has(key) && database) {
        loading.add(key);
        loadCached(key).then((url) => loadPicture(key, url)).catch(ask);
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
      const type = upload.type === "image/jpeg" ? "image/jpeg" : "image/png";
      if (type === "image/jpeg") opaque.add(key);
      // Receiver 60: the base64 text into bytes by the browser itself, off
      // the page's thread (a script loop over it held the page up).
      fetch("data:" + type + ";base64," + data).then((response) => response.blob()).then((blob) => {
        const url = URL.createObjectURL(blob);
        return loadPicture(key, url, blob).then(() => {
          cacheImage(key, blob);
          send({ t: "got", k: key });
        });
      }).catch((error) => report("image", error));
    }

    // A picture with a colour multiplied in (`colorMultiply`), made once
    // (`drawn` as pictureFor gives it). One from an atlas is made at its own
    // frame's size, its rect where it sits in the frame.
    function tint(drawn, color) {
      const id = drawn.key + ":" + color.join(",");
      let canvasTint = tinted.get(id);
      if (canvasTint) return canvasTint;
      const image = drawn.image, cut = drawn.cut;
      canvasTint = document.createElement("canvas");
      canvasTint.width = cut ? cut.width : image.naturalWidth || image.width;
      canvasTint.height = cut ? cut.height : image.naturalHeight || image.height;
      const t = canvasTint.getContext("2d");
      const place = () => (cut ? t.drawImage(image, cut.x, cut.y, cut.w, cut.h, cut.ox, cut.oy, cut.w, cut.h) : t.drawImage(image, 0, 0));
      place();
      t.globalCompositeOperation = "multiply";
      t.fillStyle = core.cssColor([color[0], color[1], color[2], 1000]);
      t.fillRect(0, 0, canvasTint.width, canvasTint.height);
      t.globalCompositeOperation = "destination-in";
      place();
      tinted.set(id, canvasTint);
      return canvasTint;
    }

    // MARK: Drawing

    // Pictures with no see-through pixels (JPEGs).
    const opaque = new Set();

    // The last top-level command that paints a whole opaque picture over the
    // stage, plainly: everything before it is hidden. A clip to the stage
    // itself (iOS's stadium photo has one) hides nothing (receiver 57).
    function coverIndex(frame) {
      let depth = 0;
      let found = -1;
      for (let index = 0; index < frame.o.length; index += 1) {
        const op = frame.o[index];
        if (op[0] === "L") { depth += 1; continue; }
        if (op[0] === "l") { depth -= 1; continue; }
        if (depth || op[0] !== "i" || op[1] < 1000 || (op[2] && op[2] !== "source-over") || op[5] >= 0) continue;
        if (op[6] >= 0 && (tune.cover === "strict" || !core.clipsWholeStage(frame.cl[op[6]]))) continue;
        const size = sizes.get(op[3]);
        if (!images.has(op[3]) || !size || !opaque.has(op[3])) continue;
        const m = op[4];
        if (m[1] !== 0 || m[2] !== 0 || m[0] <= 0 || m[3] <= 0) continue;
        const width = size.width;
        const height = size.height;
        const left = m[4] / 10, top = m[5] / 10;
        const right = left + width * m[0] / 10000, bottom = top + height * m[3] / 10000;
        if (left <= 0.5 && top <= 0.5 && right >= STAGE.width - 0.5 && bottom >= STAGE.height - 0.5) found = index;
      }
      return found;
    }

    // The photo's own layer once it is decoded; until then null, and the
    // canvas draws the photo itself.
    function backdropLayer(key) {
      if (!backdrop) return null;
      let entry = backdropLayers.get(key);
      if (!entry) {
        const source = images.get(key);
        if (!source || !source.src) return null;
        const element = document.createElement("img");
        element.className = "scene-backdrop";
        element.alt = "";
        element.style.opacity = "0";
        entry = { element, ready: false, transform: "" };
        backdropLayers.set(key, entry);
        backdrop.parentNode.insertBefore(element, backdrop);
        element.src = source.src;
        const done = () => { entry.ready = true; needsRedraw = true; };
        if (element.decode) element.decode().then(done, () => { if (element.complete) done(); });
        else element.onload = done;
      }
      return entry.ready ? entry : null;
    }

    function showBackdrop(op) {
      if (tune.photo === "canvas") return false;
      const entry = backdropLayer(op[3]);
      if (!entry) return false;
      // Stage points to the screen's CSS pixels. The layer is laid out at
      // the file's own size, so a file sharper than the key's size keeps
      // its pixels until the GPU scales it.
      const css = boxWidth() / STAGE.width;
      const m = op[4];
      const image = images.get(op[3]);
      const size = sizes.get(op[3]);
      const fx = size.width / (image.naturalWidth || image.width || size.width);
      const fy = size.height / (image.naturalHeight || image.height || size.height);
      const transform = "matrix(" + [m[0] / 10000 * css * fx, 0, 0, m[3] / 10000 * css * fy, m[4] / 10 * css, m[5] / 10 * css]
        .map((v) => v.toFixed(4)).join(",") + ")";
      if (transform !== entry.transform) {
        entry.transform = transform;
        entry.element.style.transform = transform;
      }
      if (backdropKey !== op[3]) {
        if (layerWarming && layerWarming.key !== op[3]) settleLayers();
        else layerWarming = null;
        hideBackdrops(op[3]);
        entry.element.style.opacity = "1";
        entry.shown = true;
        backdropKey = op[3];
      }
      backdropTransform = transform;
      return true;
    }

    function hideBackdrops(except) {
      backdropLayers.forEach((entry, key) => { if (key !== except) entry.element.style.opacity = "0"; });
      if (except == null) backdropKey = null;
    }

    // MARK: Cheap drawing on a Chromecast (receiver 57)
    //
    // A Chromecast Ultra (Chrome 90, a Vivante GC2000) takes 370–400 ms for
    // any canvas `filter: blur()` drawn on the screen's canvas or a layer its
    // size, however small the shape: iOS's contact flash (and any glow)
    // froze the stadium for a frame of 0.4 s at every hit. A shadow's blur
    // costs it under a millisecond, so a blurred plain shape is drawn as a
    // shadow, the shape itself off the canvas; anything else blurred is
    // blurred in a small canvas of its own. A layer is cleared and
    // composited only where something was drawn into it, not the whole
    // 1280 x 720 canvas (the bowler's dissolve is a layer every frame of his
    // run-up), and a layer that changes nothing about how its content lands
    // isn't made at all.

    // Composite operations that clear what they don't cover: a layer drawn
    // with one of them is composited whole.
    const UNBOUNDED = new Set(["copy", "source-in", "source-out", "destination-in", "destination-atop"]);
    // How far left of the canvas a shape blurred as its shadow is drawn
    // (canvas pixels); its shadow is cast back into place.
    const OFFSTAGE = 40000;
    // The most pixels a blurred picture is blurred with: the blur costs as
    // many pixels as it covers (~35 ms for 400 x 300 on the Ultra), so a
    // bigger piece is blurred at a lower resolution and drawn back up.
    const SCRATCH_PIXELS = 10000;
    const scratches = new Map();
    // Bench switches (`x` in hello; no phone sends it), for A/B runs on a
    // TV: `blur` "shadow", "scratch" (small canvases only) or "filter"
    // (receiver 56's), `layers` "bounded" or "full", `cover` "clip" (a
    // stage-sized clip still covers) or "strict", `bitmaps` 1 or 0, `shade`
    // "thirds", "full" or "none".
    // Bitmaps are off by default (receiver 59b): with them the Living Room
    // TV refused to start RallyCade again for minutes after a stop.
    // `photo` "layer" (the photo an image the GPU composites) or "canvas";
    // `opaque` 1 for an opaque canvas (it must then draw the photo).
    // `match` 0 blends only frames of the same shapes, as before receiver 65.
    // `dirty` 0 clears the whole canvas and copies the whole static layer each
    // draw, as before receiver 67 (build 215).
    const TUNED = Object.freeze({ blur: "shadow", layers: "bounded", cover: "clip", bitmaps: 0, shade: "thirds", blend: 1, cache: 1, photo: "layer", opaque: 0,
      match: 1, dirty: 1 });
    // A weak dongle (core.isWeakDongle): no redraw only to blend between
    // frames (each draw costs it ~30 ms of its page's thread) and glows
    // drawn plain, never blurred.
    // Oct 19 2026: and one opaque canvas with the photo and the shading drawn
    // in, no CSS animation in the HUD (see `opaqueCanvas`).
    const WEAK_TUNED = Object.freeze(Object.assign({}, TUNED, { blur: "off", blend: 0, photo: "canvas", shade: "canvas", opaque: 1 }));
    const tune = Object.assign({}, TUNED);
    // Each hello starts from the defaults (the weak ones on a weak dongle);
    // the bench's `x` changes them.
    function setTune(x) {
      const base = plan && plan.weak ? WEAK_TUNED : TUNED;
      Object.assign(tune, base);
      if (x && typeof x === "object") Object.keys(base).forEach((name) => { if (x[name] !== undefined) tune[name] = x[name]; });
      // An opaque canvas hides whatever is under it: it draws the photo.
      if (tune.opaque) tune.photo = "canvas";
      document.body.dataset.sceneShade = tune.shade;
      document.body.dataset.sceneWeak = plan && plan.weak ? "1" : "0";
      setOpaque(!!tune.opaque);
      if (tune.photo === "canvas") hideBackdrops(null);
      timeline.blendsMatches = !!tune.match;
    }
    setTune(null);

    function layerCanvas(depth) {
      let layer = layers[depth];
      if (!layer || layer.width !== canvas.width || layer.height !== canvas.height) {
        layer = document.createElement("canvas");
        layer.width = canvas.width;
        layer.height = canvas.height;
        layer.dirty = null;
        layers[depth] = layer;
      }
      const c = layer.getContext("2d");
      c.setTransform(1, 0, 0, 1, 0, 0);
      // Only where the last drawing went (all of it if unknown).
      const dirty = tune.layers === "full" ? undefined : layer.dirty;
      if (dirty === undefined) c.clearRect(0, 0, layer.width, layer.height);
      else if (dirty) c.clearRect(dirty[0], dirty[1], dirty[2] - dirty[0], dirty[3] - dirty[1]);
      // Until it is composited, anything may be in it.
      layer.dirty = undefined;
      return layer;
    }

    // A layer inside a composed picture, made for it and dropped with it.
    function pictureLayer(surface, depth) {
      let layer = surface.layers[depth];
      if (!layer) {
        layer = document.createElement("canvas");
        layer.width = surface.width;
        layer.height = surface.height;
        surface.layers[depth] = layer;
      }
      const c = layer.getContext("2d");
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, layer.width, layer.height);
      return layer;
    }

    function scratchCanvas(width, height) {
      const w = Math.ceil(width / 32) * 32, h = Math.ceil(height / 32) * 32;
      const id = w + "x" + h;
      let scratch = scratches.get(id);
      if (!scratch) {
        if (scratches.size >= 8) scratches.clear();
        scratch = document.createElement("canvas");
        scratch.width = w;
        scratch.height = h;
        scratches.set(id, scratch);
      }
      return scratch;
    }

    function filtersOf(frame, ref) {
      if (!(ref >= 0 && frame.fl[ref])) return { blur: 0, multiply: null };
      const parts = core.filterParts(frame.fl[ref]);
      return tune.blur === "off" ? { blur: 0, multiply: parts.multiply } : parts;
    }

    function clipTo(c, frame, clipRef, scale) {
      if (!(clipRef >= 0) || !frame.cl[clipRef]) return;
      c.setTransform(scale, 0, 0, scale, 0, 0);
      for (const clip of frame.cl[clipRef]) {
        c.beginPath();
        core.tracePath(c, clip[0], clip[1]);
        c.clip(clip[2] ? "evenodd" : "nonzero");
      }
    }

    // Sets up a command's opacity, blending and clip.
    function begin(c, frame, alpha, blend, clipRef, scale) {
      c.save();
      clipTo(c, frame, clipRef, scale);
      c.globalAlpha = Math.max(0, Math.min(1, alpha / 1000));
      c.globalCompositeOperation = blend || "source-over";
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

    function strokeStyle(c, op) {
      const geometry = op[6];
      c.lineWidth = Math.max(0.01, geometry[0] / 10);
      c.lineCap = CAPS[geometry[1]] || "butt";
      c.lineJoin = JOINS[geometry[2]] || "miter";
      c.miterLimit = Math.max(1, geometry[3] / 10);
      c.setLineDash((op[7] || []).map((d) => d / 10));
      c.lineDashOffset = (op[8] || 0) / 10;
    }

    // The picture a command draws, and its size: the rect the phone's matrix
    // is for (the key's size), not the file's, so a sharper file is drawn in
    // the same place. A decoded bitmap is drawn when there is one. Null while
    // nothing can be drawn.
    function pictureFor(key) {
      const image = images.get(key);
      if (image) return drawable(key, image, sizes.get(key));
      // A rehearsal draws what is here and asks for nothing.
      if (rehearsing) return null;
      ensure(key);
      counters.missing += 1;
      // A picture still being made: its undyed photo meanwhile.
      const picture = pictures.get(key);
      const fallback = picture && picture.fallback && images.get(picture.fallback);
      if (!fallback) return null;
      return drawable(picture.fallback, fallback, { width: picture.width, height: picture.height });
    }

    // A sprite is drawn from its atlas (`cut`: its rect there).
    function drawable(key, image, size) {
      if (image.sprite) return { image: image.sheet.bitmap || image.sheet.image, size, key, cut: image.cut };
      return { image: bitmaps.get(key) || image, size, key };
    }

    // A picture into `size` (the rect its key gives) under `c`'s transform.
    // One from an atlas: its rect there, drawn where that rect sits in its
    // frame, at the scale the whole frame would be drawn. A filter reading
    // past the rect reads what it would read in the frame alone (its edges
    // repeated around it in the atlas, scripts/cast-inset-atlas.mjs), so the
    // pixels are the same but for rounding in where they are sampled.
    function drawPicture(c, drawn) {
      const size = drawn.size, cut = drawn.cut;
      if (!cut) { c.drawImage(drawn.image, 0, 0, size.width, size.height); return; }
      const kx = size.width / cut.width, ky = size.height / cut.height;
      c.drawImage(drawn.image, cut.x, cut.y, cut.w, cut.h, cut.ox * kx, cut.oy * ky, cut.w * kx, cut.h * ky);
    }

    function pictureSize(key) {
      const picture = pictures.get(key);
      return sizes.get(key) || (picture ? { width: picture.width, height: picture.height } : core.pictureSize(key));
    }

    // One fill, stroke or picture, plainly (no blur): `o` may override its
    // opacity, blending, clip and colour multiply.
    function drawOp(c, frame, op, scale, o) {
      const kind = op[0];
      const alpha = o && o.alpha != null ? o.alpha : op[1];
      const blend = o && o.blend != null ? o.blend : op[2];
      if (kind === "f" || kind === "s") {
        const multiply = o && o.multiply !== undefined ? o.multiply : filtersOf(frame, kind === "f" ? op[7] : op[9]).multiply;
        begin(c, frame, alpha, blend, o && o.clipRef != null ? o.clipRef : kind === "f" ? op[8] : op[10], scale);
        c.setTransform(scale, 0, 0, scale, 0, 0);
        c.beginPath();
        core.tracePath(c, op[3], op[4]);
        if (kind === "f") {
          c.fillStyle = shading(c, op[5], multiply);
          c.fill(op[6] ? "evenodd" : "nonzero");
        } else {
          strokeStyle(c, op);
          c.strokeStyle = shading(c, op[5], multiply);
          c.stroke();
        }
        c.restore();
        return;
      }
      if (kind === "i") {
        const drawn = pictureFor(op[3]);
        if (!drawn) return;
        const multiply = o && o.multiply !== undefined ? o.multiply : filtersOf(frame, op[5]).multiply;
        begin(c, frame, alpha, blend, o && o.clipRef != null ? o.clipRef : op[6], scale);
        if (multiply) c.globalAlpha *= Math.max(0, Math.min(1, multiply[3] / 1000));
        const m = op[4];
        c.setTransform(scale * m[0] / 10000, scale * m[1] / 10000, scale * m[2] / 10000, scale * m[3] / 10000,
          scale * m[4] / 10, scale * m[5] / 10);
        if (multiply) c.drawImage(tint(drawn, multiply), 0, 0, drawn.size.width, drawn.size.height);
        else drawPicture(c, drawn);
        c.restore();
      }
    }

    // Whether this browser casts the shadow of a shape drawn off its canvas,
    // tried once on a canvas of its own. Where it doesn't, glows are blurred
    // in small canvases instead (`stats.glow` says which).
    let shadowsCast = null;
    function castsOffstageShadows() {
      if (shadowsCast !== null) return shadowsCast;
      shadowsCast = false;
      try {
        const probe = document.createElement("canvas");
        probe.width = 8;
        probe.height = 8;
        const c = probe.getContext("2d");
        c.shadowColor = "rgba(255,0,0,1)";
        c.shadowBlur = 1;
        c.shadowOffsetX = OFFSTAGE;
        c.setTransform(1, 0, 0, 1, -OFFSTAGE, 0);
        c.fillStyle = "#000";
        c.fillRect(-8, -8, 24, 24);
        const pixel = c.getImageData(4, 4, 1, 1).data;
        shadowsCast = pixel[0] > 200 && pixel[1] < 60 && pixel[3] > 200;
      } catch (error) { shadowsCast = false; }
      return shadowsCast;
    }

    // A plain colour shape with a blur, whatever layer it sits in: drawn as
    // its own shadow. `o`: opacity (thousandths), blending, the clips (refs)
    // and the blur (stage points).
    function shadowable(frame, op, blend) {
      if ((op[0] !== "f" && op[0] !== "s") || !Array.isArray(op[5]) || op[5][0] !== "c") return false;
      if (UNBOUNDED.has(blend || "source-over") || (op[2] && op[2] !== "source-over")) return false;
      return tune.blur === "shadow" && castsOffstageShadows();
    }

    function drawShadowed(c, frame, op, o, scale) {
      c.save();
      for (const ref of o.clipRefs) clipTo(c, frame, ref, scale);
      c.globalAlpha = Math.max(0, Math.min(1, o.alpha / 1000));
      c.globalCompositeOperation = o.blend || "source-over";
      // A canvas shadow's blur is twice its standard deviation; CSS's blur
      // radius (the filter's, SwiftUI's) is the deviation itself.
      c.shadowColor = core.cssColor(op[5][1], o.multiply);
      c.shadowBlur = 2 * o.blur * scale;
      c.shadowOffsetX = OFFSTAGE;
      c.shadowOffsetY = 0;
      c.setTransform(scale, 0, 0, scale, -OFFSTAGE, 0);
      c.beginPath();
      core.tracePath(c, op[3], op[4]);
      if (op[0] === "f") {
        c.fillStyle = "#000";
        c.fill(op[6] ? "evenodd" : "nonzero");
      } else {
        strokeStyle(c, op);
        c.strokeStyle = "#000";
        c.stroke();
      }
      c.restore();
    }

    // Blurs `rect` of `source` (a canvas the target's size) by `sigma`
    // canvas pixels in a small canvas of its own, and draws it back into
    // `c` as `c` is set up. Returns where it drew.
    function blurInto(c, source, rect, sigma) {
      const pad = Math.ceil(sigma * 3) + 2;
      const left = Math.max(0, rect[0] - pad), top = Math.max(0, rect[1] - pad);
      const right = Math.min(source.width, rect[2] + pad), bottom = Math.min(source.height, rect[3] + pad);
      const w = right - left, h = bottom - top;
      if (w <= 0 || h <= 0) return null;
      const k = Math.min(1, Math.sqrt(SCRATCH_PIXELS / (w * h)));
      const sw = Math.max(1, Math.ceil(w * k)), sh = Math.max(1, Math.ceil(h * k));
      const scratch = scratchCanvas(sw, sh);
      const s = scratch.getContext("2d");
      s.setTransform(1, 0, 0, 1, 0, 0);
      s.globalAlpha = 1;
      s.globalCompositeOperation = "source-over";
      s.clearRect(0, 0, scratch.width, scratch.height);
      s.filter = "blur(" + Math.max(0.01, sigma * k).toFixed(2) + "px)";
      s.drawImage(source, left, top, w, h, 0, 0, sw, sh);
      s.filter = "none";
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.drawImage(scratch, 0, 0, sw, sh, left, top, w, h);
      return [left, top, right, bottom];
    }

    // Bounds in canvas pixels, grown as a layer is drawn into: null for the
    // canvas itself (nothing to track), `full` when something could land
    // anywhere.
    function newBounds() { return { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity, full: false }; }

    function grow(bounds, box, scale, pad) {
      if (!bounds) return;
      if (!box) { bounds.full = true; return; }
      const p = (pad || 0) + 2;
      bounds.left = Math.min(bounds.left, box[0] * scale - p);
      bounds.top = Math.min(bounds.top, box[1] * scale - p);
      bounds.right = Math.max(bounds.right, box[2] * scale + p);
      bounds.bottom = Math.max(bounds.bottom, box[3] * scale + p);
      // Receiver 67: the TV's canvas and the static layer keep each one (drawnInto).
      if (bounds.rects) bounds.rects.push(box[0] * scale - p, box[1] * scale - p, box[2] * scale + p, box[3] * scale + p);
    }

    // Receiver 67 (build 215): bounds that keep each command's box, for where
    // a canvas was drawn into (core.mergeRects; `canvasDrawn` above).
    function drawnInto() { const bounds = newBounds(); bounds.rects = []; return bounds; }

    // The whole pixels `bounds` covers in a `width` x `height` canvas, or
    // null when nothing was drawn.
    function boundsRect(bounds, width, height) {
      if (bounds.full || tune.layers === "full") return [0, 0, width, height];
      const left = Math.max(0, Math.floor(bounds.left)), top = Math.max(0, Math.floor(bounds.top));
      const right = Math.min(width, Math.ceil(bounds.right)), bottom = Math.min(height, Math.ceil(bounds.bottom));
      return right > left && bottom > top ? [left, top, right, bottom] : null;
    }

    // A layer that changes nothing about how its content lands (opaque,
    // plain blending, no filter or clip, and plain blending inside) is drawn
    // straight into its parent.
    function isFlat(frame, op, index, end) {
      if (tune.layers === "full" || end < 0 || op[1] < 1000 || (op[2] && op[2] !== "source-over") || op[3] >= 0 || op[4] >= 0) return false;
      for (let at = index + 1; at < end; at += 1) {
        const inner = frame.o[at];
        if (inner[0] === "B") return false;
        if (inner[0] !== "l" && inner[2] && inner[2] !== "source-over") return false;
      }
      return true;
    }

    function drawFrame(frame, batter) {
      const started = performance.now();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      // An opaque canvas starts from the stadium's colour (its CSS background is hidden).
      // Receiver 67: a see-through one is cleared only where the last draw drew
      // (all else is already clear); a rehearsal's own canvas whole.
      const bounded = tune.dirty && tune.layers !== "full";
      const drawn = rehearsing || opaqueCanvas || !bounded ? null : drawnInto();
      if (opaqueCanvas) { ctx.fillStyle = "#0c1a17"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      else if (rehearsing || !canvasDrawn || !bounded) ctx.clearRect(0, 0, canvas.width, canvas.height);
      else canvasDrawn.forEach((r) => ctx.clearRect(r[0], r[1], r[2] - r[0], r[3] - r[1]));
      if (!rehearsing) canvasDrawn = null;
      ctx.imageSmoothingQuality = smoothing;
      const cover = coverIndex(frame);
      let from = 0;
      const inCanvas = tune.photo === "canvas";
      // A rehearsal (receiver 65) draws as play does with the photo on its
      // layer, and leaves the layers, the counters and the cover alone.
      const layered = cover >= 0 && (rehearsing ? !inCanvas : showBackdrop(frame.o[cover]));
      if (layered) {
        from = cover + 1;
        if (!rehearsing && (photoPending || !layerShownAt)) layerShownAt = started;
      } else if (cover < 0) {
        if (!rehearsing) hideBackdrops(null);
      } else if (inCanvas) {
        // The photo drawn here: what is under it is never seen.
        from = cover;
        if (!rehearsing && !layerShownAt) layerShownAt = started;
      }
      if (!rehearsing) {
        photoPending = cover >= 0 && !layered && !inCanvas;
        framePhoto = cover >= 0;
      }
      const rest = drawStatic(frame, from, drawn);
      // A photo whose layer isn't decoded yet is drawn on the canvas, over
      // whichever layer was showing: never an empty frame.
      paint(ctx, rest.frame, rest.from, { s: scale, width: canvas.width, height: canvas.height, layers: null,
        live: batter === undefined ? live.current : batter }, 0, drawn);
      if (tune.shade === "canvas") drawShade();
      if (rehearsing) return;
      if (drawn && !drawn.full) canvasDrawn = core.mergeRects(drawn.rects, canvas.width, canvas.height);
      counters.drawMs.push(performance.now() - started);
      counters.draws += 1;
    }

    // The broadcast shading (CSS .scene-shade) drawn on the canvas: the top
    // and bottom thirds darkened, the middle clear.
    let shadeCache = null;
    function drawShade() {
      const h = canvas.height, w = canvas.width, third = Math.ceil(h / 3);
      if (!shadeCache || shadeCache.h !== h || shadeCache.c !== ctx) {
        const top = ctx.createLinearGradient(0, 0, 0, third);
        top.addColorStop(0, "rgba(0,0,0,0.22)");
        top.addColorStop(1, "rgba(0,0,0,0)");
        const bottom = ctx.createLinearGradient(0, h - third, 0, h);
        bottom.addColorStop(0, "rgba(0,0,0,0)");
        bottom.addColorStop(1, "rgba(0,0,0,0.24)");
        shadeCache = { h, c: ctx, top, bottom };
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = shadeCache.top;
      ctx.fillRect(0, 0, w, third);
      ctx.fillStyle = shadeCache.bottom;
      ctx.fillRect(0, h - third, w, third);
    }

    // MARK: Static layer (Oct 19 2026)
    //
    // "Could we reduce the number of pictures and shapes to draw?" Of a
    // frame's ~31 commands about half are the same as the frame before
    // (fielders standing, their shadows, the pitch's marks), and a live
    // batter redraws the same frame again ~30 times a second. Those (see
    // splitStatic) are drawn once into a canvas of the stadium's size and
    // then blitted: one drawImage instead of each command, the picture the
    // same. The layer is rebuilt only when its commands change (a camera
    // move, a fielder moving, a picture arriving).
    //
    // Oct 19 2026 (iOS 201 on the owner's Ultra: ~5–25 rebuilds every 2 s,
    // drawMs 8–11 for the stadium's first ~15 s): the layer was keyed by
    // exactly which commands were unchanged since the draw before, and that
    // set flips every draw. A new frame leaves out what moved; the live
    // batter's redraw of that same frame has everything unchanged; so the
    // layer was rebuilt twice a frame, each rebuild dearer than no layer.
    // Now a layer is kept while it still fits the frame (`layerFits`: each of
    // its commands still there, in order, under nothing that changed), and
    // rebuilt only for a set of commands that held for two draws, or when it
    // no longer fits. And a blended frame (the timeline's scratch, its
    // commands' arrays rewritten each draw) is never keyed from the cache:
    // a stale key made a moving fielder look unchanged and blitted it where
    // it was a draw before.
    const staticLayer = { canvas: null, key: null, keys: null, rects: null, built: 0, hits: 0, ops: 0, draws: 0 };
    let lastStaticKeys = null;
    let lastCandidateKey = null;
    const opKeys = new WeakMap();
    function opKey(op, fresh) {
      if (fresh) return JSON.stringify(op);
      let key = opKeys.get(op);
      if (key === undefined) { key = JSON.stringify(op); opKeys.set(op, key); }
      return key;
    }
    function staticable(op) {
      const kind = op[0];
      if (op[2] && op[2] !== "source-over") return false;
      if (kind === "f") return !(op[7] >= 0);
      if (kind === "s") return !(op[9] >= 0);
      if (kind === "i") return !(op[5] >= 0) && !!images.get(op[3]);
      return false;
    }
    // Which of a frame's commands the layer draws: each plain top-level
    // command that was also in the frame before (a fielder standing, a
    // shadow, the pitch's marks), unless a command before it that changed
    // overlaps it (then it must stay above that one). The rest is drawn
    // over the layer in its own order. Anything without bounds (the live
    // batter's slot, a layer) ends the search, so nothing after it moves.
    const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    function splitStatic(frame, from, previous, keys) {
      const statics = [];
      const changed = [];
      for (let index = from; index < frame.o.length; index += 1) {
        const op = frame.o[index];
        if (op[0] === "L" || op[0] === "B" || op[0] === "l") break;
        const box = core.opBounds(op, pictureSize);
        if (!box) break;
        const padded = [box[0] - 2, box[1] - 2, box[2] + 2, box[3] + 2];
        if (staticable(op) && previous && previous.has(keys[index]) && !changed.some((other) => overlaps(other, padded))) statics.push(index);
        else changed.push(padded);
      }
      return statics;
    }
    // Where the layer's commands are in this frame, or null when it doesn't
    // fit: each must be there in the layer's order, before anything without
    // bounds, with no other command before it overlapping it (that one
    // would be drawn above it now).
    function layerFits(frame, from, keys) {
      const want = staticLayer.keys;
      if (!want || !want.length) return null;
      const at = [];
      const others = [];
      let next = 0;
      for (let index = from; index < frame.o.length && next < want.length; index += 1) {
        const op = frame.o[index];
        if (op[0] === "L" || op[0] === "B" || op[0] === "l") return null;
        const box = core.opBounds(op, pictureSize);
        if (!box) return null;
        const padded = [box[0] - 2, box[1] - 2, box[2] + 2, box[3] + 2];
        if (keys[index] === want[next]) {
          if (others.some((other) => overlaps(other, padded))) return null;
          at.push(index);
          next += 1;
        } else {
          others.push(padded);
        }
      }
      return next === want.length ? at : null;
    }
    function buildLayer(frame, statics, keys) {
      if (!staticLayer.canvas) staticLayer.canvas = document.createElement("canvas");
      const layer = staticLayer.canvas;
      if (layer.width !== canvas.width || layer.height !== canvas.height) { layer.width = canvas.width; layer.height = canvas.height; }
      const c = layer.getContext("2d");
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1;
      c.globalCompositeOperation = "source-over";
      c.clearRect(0, 0, layer.width, layer.height);
      c.imageSmoothingQuality = smoothing;
      // Receiver 67: where its commands drew, as rects that don't overlap: a
      // draw copies those, not the whole layer (the rest is see-through).
      const parts = drawnInto();
      paint(c, { s: frame.s, o: statics.map((index) => frame.o[index]), fl: frame.fl, cl: frame.cl }, 0,
        { s: scale, width: layer.width, height: layer.height, layers: null, live: null }, 0, parts);
      staticLayer.rects = parts.full ? null : core.mergeRects(parts.rects, layer.width, layer.height, { disjoint: true });
      staticLayer.keys = statics.map((index) => keys[index]);
      staticLayer.key = canvas.width + "x" + canvas.height + "|" + staticLayer.keys.join("|");
      staticLayer.built += 1;
    }
    function drawStatic(frame, from, drawn) {
      if (!tune.cache) { lastStaticKeys = null; lastCandidateKey = null; return { frame, from }; }
      staticLayer.draws += 1;
      const fresh = !!frame.scratch;
      const keys = new Array(frame.o.length);
      const keysNow = new Set();
      for (let index = from; index < frame.o.length; index += 1) {
        const op = frame.o[index];
        if (op[0] === "f" || op[0] === "s" || op[0] === "i") { keys[index] = opKey(op, fresh); keysNow.add(keys[index]); }
      }
      const statics = splitStatic(frame, from, lastStaticKeys, keys);
      lastStaticKeys = keysNow;
      const candidateKey = statics.length >= 2 ? statics.map((index) => keys[index]).join("|") : null;
      const steady = candidateKey !== null && candidateKey === lastCandidateKey;
      lastCandidateKey = candidateKey;
      const sized = staticLayer.canvas && staticLayer.canvas.width === canvas.width && staticLayer.canvas.height === canvas.height;
      let used = sized ? layerFits(frame, from, keys) : null;
      // A bigger set of unchanged commands that held for two draws: worth a
      // rebuild. A layer that no longer fits: the set now, if there is one.
      if (used && steady && statics.length >= used.length + 3) used = null;
      if (used) {
        staticLayer.hits += 1;
      } else {
        if (statics.length < 2) return { frame, from };
        buildLayer(frame, statics, keys);
        used = statics;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      if (staticLayer.rects && tune.dirty && tune.layers !== "full") {
        // Receiver 67: its parts, pixel for pixel where they are.
        for (const r of staticLayer.rects) {
          const w = r[2] - r[0], h = r[3] - r[1];
          ctx.drawImage(staticLayer.canvas, r[0], r[1], w, h, r[0], r[1], w, h);
          if (drawn) drawn.rects.push(r[0], r[1], r[2], r[3]);
        }
      } else {
        ctx.drawImage(staticLayer.canvas, 0, 0);
        if (drawn) drawn.full = true;
      }
      staticLayer.ops += used.length;
      const skip = new Set(used);
      const rest = Object.assign({}, frame, { o: frame.o.filter((op, index) => index >= from && !skip.has(index)) });
      return { frame: rest, from: 0 };
    }
    function dropStaticLayer() {
      staticLayer.key = null;
      staticLayer.keys = null;
      staticLayer.rects = null;
      lastStaticKeys = null;
      lastCandidateKey = null;
      if (staticLayer.canvas) { try { staticLayer.canvas.width = 0; staticLayer.canvas.height = 0; } catch (error) { /* gone */ } staticLayer.canvas = null; }
    }

    // Draws a frame's commands from `from` on into `target`: the TV's
    // canvas (`surface.s` canvas pixels a stage point), or a composed
    // picture's own canvas (one pixel a point). `depth` is how many layers
    // are already open below `target` (the live batter drawn inside one),
    // and `sink` the bounds of the layer `target` is, if it is one.
    function paint(target, frame, from, surface, depth, sink) {
      const scale = surface.s;
      const base = depth || 0;
      const stack = [{ c: target, bounds: sink || null }];
      let c = target;
      const newLayer = (at) => surface.layers ? pictureLayer(surface, at) : layerCanvas(at);
      for (let index = from; index < frame.o.length; index += 1) {
        const op = frame.o[index];
        const top = stack[stack.length - 1];
        switch (op[0]) {
          case "L": {
            const end = core.layerEnd(frame.o, index);
            const filters = filtersOf(frame, op[3]);
            const inner = end === index + 2 ? frame.o[index + 1] : null;
            // A glow: one plain shape in a blurred layer, drawn as its shadow.
            if (filters.blur > 0 && tune.blur !== "filter" && inner && shadowable(frame, inner, op[2])
                && !((inner[0] === "f" ? inner[8] : inner[10]) >= 0)) {
              const own = filtersOf(frame, inner[0] === "f" ? inner[7] : inner[9]);
              const blur = Math.sqrt(filters.blur * filters.blur + own.blur * own.blur);
              drawShadowed(c, frame, inner, { alpha: op[1] * inner[1] / 1000, blend: op[2], clipRefs: [op[4]], blur, multiply: own.multiply }, scale);
              grow(top.bounds, core.opBounds(inner, pictureSize), scale, blur * scale * 3);
              index = end;
              break;
            }
            if (isFlat(frame, op, index, end)) {
              stack.push({ c, flat: true, bounds: top.bounds });
              break;
            }
            // A composed picture's layers are its own size (`surface.layers`);
            // the TV's canvas shares `layers`. Build 142 had these swapped,
            // unseen because no stadium frame drew a layer.
            const layer = newLayer(base + stack.length);
            stack.push({ c: layer.getContext("2d"), layer, alpha: op[1], blend: op[2], filterRef: op[3], clipRef: op[4], bounds: newBounds() });
            c = stack[stack.length - 1].c;
            break;
          }
          case "l": {
            if (stack.length < 2) break;
            const closed = stack.pop();
            const parent = stack[stack.length - 1];
            c = parent.c;
            if (closed.flat) break;
            const layer = closed.layer;
            const whole = UNBOUNDED.has(closed.blend || "source-over");
            const rect = boundsRect(closed.bounds, layer.width, layer.height);
            if (!surface.layers) layer.dirty = rect;
            if (!rect && !whole) break;
            const filters = filtersOf(frame, closed.filterRef);
            begin(c, frame, closed.alpha, closed.blend, closed.clipRef, scale);
            c.setTransform(1, 0, 0, 1, 0, 0);
            let drawn = rect;
            if (filters.blur > 0 && tune.blur === "filter") {
              c.filter = "blur(" + (filters.blur * scale).toFixed(2) + "px)";
              c.drawImage(layer, 0, 0);
              drawn = null;
            } else if (filters.blur > 0) {
              drawn = rect && blurInto(c, layer, rect, filters.blur * scale);
            } else if (whole || !rect || tune.layers === "full") {
              c.drawImage(layer, 0, 0);
              drawn = null;
            } else {
              const w = rect[2] - rect[0], h = rect[3] - rect[1];
              c.drawImage(layer, rect[0], rect[1], w, h, rect[0], rect[1], w, h);
            }
            c.restore();
            if (parent.bounds) {
              if (!drawn) parent.bounds.full = true;
              else grow(parent.bounds, [drawn[0] / scale, drawn[1] / scale, drawn[2] / scale, drawn[3] / scale], scale, 0);
            }
            break;
          }
          case "f":
          case "s":
          case "i": {
            const filters = filtersOf(frame, op[0] === "f" ? op[7] : op[0] === "s" ? op[9] : op[5]);
            // Receiver 67: a blend that clears what it doesn't cover reaches the whole canvas.
            const box = top.bounds && !UNBOUNDED.has(op[2]) ? core.opBounds(op, pictureSize) : null;
            if (!(filters.blur > 0)) {
              drawOp(c, frame, op, scale);
              if (top.bounds) grow(top.bounds, box, scale, 0);
              break;
            }
            const clipRef = op[0] === "f" ? op[8] : op[0] === "s" ? op[10] : op[6];
            if (tune.blur === "filter") {
              // Receiver 56: the canvas's own filter (the bench's "before").
              c.save();
              c.filter = "blur(" + (filters.blur * scale).toFixed(2) + "px)";
              drawOp(c, frame, op, scale);
              c.restore();
            } else if (shadowable(frame, op, op[2])) {
              drawShadowed(c, frame, op, { alpha: op[1], blend: op[2], clipRefs: [clipRef], blur: filters.blur, multiply: filters.multiply }, scale);
            } else {
              // A gradient or a picture: drawn plainly into a layer, then
              // blurred in a small canvas on its way into `c`.
              const layer = newLayer(base + stack.length);
              drawOp(layer.getContext("2d"), frame, op, scale, { alpha: 1000, blend: "source-over", clipRef: -1, multiply: filters.multiply });
              const area = core.opBounds(op, pictureSize);
              const rect = area ? boundsRect({ left: area[0] * scale - 2, top: area[1] * scale - 2, right: area[2] * scale + 2, bottom: area[3] * scale + 2, full: false }, layer.width, layer.height)
                : [0, 0, layer.width, layer.height];
              if (!surface.layers) layer.dirty = rect;
              if (rect) {
                begin(c, frame, op[1], op[2], clipRef, scale);
                blurInto(c, layer, rect, filters.blur * scale);
                c.restore();
              }
            }
            if (top.bounds) grow(top.bounds, box, scale, filters.blur * scale * 3);
            break;
          }
          case "B": {
            // The live batter's own commands, filters and clips, where the
            // frame drawn ahead left room for it.
            const batter = surface.live;
            if (batter && batter.o.length) {
              paint(c, batter, 0, Object.assign({}, surface, { live: null }), base + stack.length - 1, top.bounds);
            }
            break;
          }
          case "t": {
            begin(c, frame, op[1], op[2], op[10], scale);
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
            if (top.bounds) grow(top.bounds, UNBOUNDED.has(op[2]) ? null : core.opBounds(op), scale, 0);
            break;
          }
          default: break;
        }
      }
    }

    // MARK: HUD

    // The HUD's elements, found once; and nothing written that is already
    // so: each write made the TV lay out and paint the HUD again (receiver 57).
    const hudNodes = new Map();
    function el(id) {
      let node = hudNodes.get(id);
      if (node === undefined) { node = hud.querySelector("#" + id); hudNodes.set(id, node); }
      return node;
    }
    function setText(id, value) {
      const node = el(id);
      const words = value == null ? "" : String(value);
      if (node && node.textContent !== words) node.textContent = words;
    }
    function show(id, visible) { const node = el(id); if (node && node.hidden !== !visible) node.hidden = !visible; }
    function setStyle(node, name, value) { if (node && node.style[name] !== value) node.style[name] = value; }

    const VERDICT = {
      perfect: "perfect", littleEarly: "little", littleLate: "little", early: "far", late: "far", noSwing: "none"
    };
    // Where the level can show (receiver 71): the scorebug, the Nets / timing check card, its own card.
    const LEVEL_SLOTS = ["hud-level", "hud-check-level", "hud-level-card"];
    // Up to this many chips and rings at full size in THIS OVER's card (6
    // balls and two wides); more and they are drawn smaller (`is-many`).
    const OVER_ROOM = 8;

    // THIS OVER as chips (receiver 71, core.overStrip): only a chip that
    // changed is written, so a ball bowled rewrites one chip (or a wide adds
    // one at the end), not the strip.
    function drawOverChips(row, items) {
      if (!row) return;
      if (row.dataset.strip !== "chips") {
        row.dataset.strip = "chips";
        row.classList.add("is-chips");
        row.textContent = "";
      }
      row.classList.toggle("is-many", items.length > OVER_ROOM);
      for (let index = 0; index < items.length; index += 1) {
        let chip = row.children[index];
        if (!chip) { chip = document.createElement("span"); row.appendChild(chip); }
        const name = "hud-chip tone-" + items[index].tone;
        if (chip.className !== name) chip.className = name;
        if (chip.textContent !== items[index].glyph) chip.textContent = items[index].glyph;
      }
      while (row.children.length > items.length) row.removeChild(row.children[row.children.length - 1]);
    }

    // An older phone's six dots, gold for each ball of the over bowled. After
    // a phone that sent chips, the six dots are put back first.
    function drawOverDots(row, over) {
      if (!row) return;
      if (row.dataset.strip === "chips") {
        row.dataset.strip = "";
        row.classList.remove("is-chips");
        row.classList.remove("is-many");
        row.textContent = "";
        for (let index = 0; index < 6; index += 1) row.appendChild(document.createElement("i"));
      }
      const dots = row.children;
      for (let index = 0; index < dots.length; index += 1) dots[index].classList.toggle("is-bowled", index < over);
    }

    function renderHUD(h) {
      // Scorebug: runs for wickets and overs, or the timing check's ball.
      show("hud-score", !!h.score);
      show("hud-check", !!h.check);
      if (h.score) {
        setText("hud-runs", h.score.runs + "/" + h.score.wickets);
        setText("hud-overs", h.score.overs + " of " + h.score.of);
      }
      // The level (receiver 69, r7ak7c4w): BOWLING Easy, a friend's match's
      // LEVEL, beside the overs. Receiver 71 (Oct 24 2026, the owner: "Let's
      // show the level everywhere including innings, friends, nets, cups
      // etc"): in every game, beside the ball in the Nets and a timing check,
      // and on a card of its own where the scorebug would be in the boundary
      // over (which sends the TV no scorebug; its line goes under the card).
      // Older phones send none: none shows.
      const level = h.level && typeof h.level.title === "string" && typeof h.level.value === "string" ? h.level : null;
      const levelSlot = !level ? null : h.score ? "hud-level" : h.check ? "hud-check-level" : "hud-level-card";
      for (const slot of LEVEL_SLOTS) {
        show(slot, slot === levelSlot);
        if (slot !== levelSlot) continue;
        setText(slot + "-title", level.title);
        setText(slot + "-value", level.value);
      }
      if (h.check) setText("hud-check-ball", "Ball " + h.check.ball + " of " + h.check.of);
      setText("hud-check-title", h.check && h.check.title === "NETS PRACTICE" ? "NETS PRACTICE" : "TIMING CHECK");
      show("hud-friend", !!h.friend);
      setText("hud-friend", h.friend);
      // The status card hides while the pause or lost card is up.
      const status = h.status || {};
      setStyle(el("hud-status"), "opacity", status.hidden ? "0" : "1");
      setText("hud-status-title", status.title);
      show("hud-status-detail", !!status.detail);
      setText("hud-status-detail", status.detail);
      // This over, or each timing-check ball's verdict.
      show("hud-over", !h.check);
      show("hud-verdicts", !!h.check);
      const row = h.check && el("hud-verdict-dots");
      const verdicts = h.check ? h.check.of + ":" + (h.check.verdicts || []).join(",") : "";
      if (h.check && row.dataset.verdicts !== verdicts) {
        row.dataset.verdicts = verdicts;
        row.textContent = "";
        for (let index = 0; index < h.check.of; index += 1) {
          const dot = document.createElement("i");
          const verdict = h.check.verdicts[index];
          dot.className = "dot " + (verdict ? "verdict-" + (VERDICT[verdict] || "none") : "to-come");
          row.appendChild(dot);
        }
      }
      // Receiver 71: the over ball by ball from `overBalls`; an older phone's `over` as six dots. The card is a little
      // tighter round the chips, so the speed gun under it still clears the replay's timing card.
      const strip = h.check ? null : core.overStrip(h.overBalls, h.overLeft);
      const card = el("hud-over-card");
      if (card) card.classList.toggle("is-chips", !!strip);
      if (strip) drawOverChips(el("hud-over-dots"), strip);
      else if (!h.check) drawOverDots(el("hud-over-dots"), h.over);
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
        if (caption.hidden) caption.hidden = false;
        // Build 212: while a ball is bowled the line sits under the top banner, clear of the pitch.
        caption.classList.toggle("is-raised", h.captionRaised === true);
      } else {
        if (!caption.hidden) caption.hidden = true;
        if (caption.dataset.line) caption.dataset.line = "";
      }
      // The replay's timing card and fielding cue.
      const cards = h.cards;
      show("hud-cards", !!cards);
      if (cards) {
        el("hud-cards").classList.toggle("is-leading", !!cards.leading);
        setText("hud-timing", cards.timing);
        const cue = el("hud-cue");
        if (cue.hidden !== !cards.cue) cue.hidden = !cards.cue;
        setStyle(cue, "opacity", String(cards.cueOpacity || 0));
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
        if (card.dataset.kind !== interruption.kind) card.dataset.kind = interruption.kind;
        setText("hud-int-title", interruption.title);
        show("hud-int-instruction", !!interruption.instruction);
        setText("hud-int-instruction", interruption.instruction);
        setText("hud-int-detail", interruption.detail);
        show("hud-int-progress", interruption.progress != null);
        if (interruption.progress != null && window.RallycadeHold) {
          window.RallycadeHold(el("hud-int-progress"), interruption.progress, "");
        }
      }
    }

    // MARK: Loop

    function frameLoop() {
      window.requestAnimationFrame(frameLoop);
      if (!on) { if (rehearsal.wanted) rehearse(performance.now()); return; }
      const began = performance.now();
      frameStep(began);
      counters.js += performance.now() - began;
    }

    function frameStep(began) {
      const local = began;
      // Shown once whole with its photo on its layer for a frame, or at
      // COVER_MS whatever.
      // Receiver 70 (the owner, Oct 23 2026: "getting the tv ready screen takes a long time and the circle keeps on
      // restarting"): not held for steady. Under the picture, the stadium all but transparent over it, the Ultra drew
      // ~20 a second, hitching every second or two, so the ring restarted and the steady verdict came at 20 (plateau)
      // after 3-4 s or past the phone's 8 s cap; the stadium uncovered draws 28-30. Steadiness is now watched on the
      // stadium itself while the phone holds its first ball (CastSceneStreamer.steadyLimit).
      if (root.dataset.warming && (local >= coverUntil
        || (wholeSent && (!framePhoto || (!photoPending && layerShownAt && local - layerShownAt >= 30))
          && (document.body.dataset.card !== "picture" || layersWarm())))) uncover();
      if (root.dataset.warming) { warmLayers(local); showWarming(local); }
      if (lastLoop) counters.gaps.push(local - lastLoop);
      lastLoop = local;
      const phoneNow = clock.phoneNow(local);
      if (phoneNow == null) return;
      const result = timeline.at(phoneNow);
      // A frame already on screen is drawn again only while blending.
      let drew = false;
      if (result && ((result.blended && tune.blend) || result.stamp !== lastStamp || needsRedraw)) {
        const missingBefore = counters.missing;
        drawFrame(result.frame);
        noteWhole(missingBefore);
        shownFrame = result.frame;
        drew = true;
        needsRedraw = false;
        if (result.blended) counters.blended += 1;
        if (result.partly) counters.partly += 1;
        lastStamp = result.stamp;
        if (steadyWatch.started && !steadyWatch.verdict) noteSteady(steadyWatch.draw(local), local);
      }
      // How far behind the clock the stadium on screen is (receiver 65): 0
      // while blending toward the next frame, the time since the frame shown
      // otherwise (more when frames come late). The phone times its sounds
      // to the TV's picture with it (`stale` in stats).
      // Only while frames flow: paused, the phone sends a frame a second and the picture is meant to stand.
      if (result && (result.blended || phoneNow - result.stamp <= STALE_FLOWING)) counters.stale.push(result.blended ? 0 : Math.max(0, phoneNow - result.stamp));
      // How old the batter's pose on screen is: what the live batter is for.
      if (result) {
        const age = core.poseAge(phoneNow, result.frame, live.current);
        if (age != null) {
          counters.pose.push(age);
          // Drawn ahead (receiver 55): the hands shown are that much younger.
          const ahead = core.poseAhead(result.frame, live.current) || 0;
          counters.ahead.push(ahead);
          counters.eff.push(age - ahead);
        }
      }
      // A wide canvas the device can't keep up with narrows to 1280.
      if (plan.adaptive && canvas.width > core.CANVAS.narrow && rateWatch.tick(local, drew)) narrowCanvas();
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
          missing: counters.missing, images: images.size, warmed: warmed.size, cached: staticLayer.hits, rebuilt: staticLayer.built, bitmaps: bitmaps.size, queue: timeline.length,
          // How glows are blurred (receiver 57): as shadows, or in small canvases.
          glow: tune.blur === "filter" ? "filter" : tune.blur === "off" ? "off" : castsOffstageShadows() ? "shadow" : "scratch",
          synced: clock.synced ? 1 : 0, w: canvas.width, canvas: plan.why, weak: plan.weak ? 1 : 0,
          gap: Number(core.percentile(counters.gaps, 0.5).toFixed(1)),
          gap90: Number(core.percentile(counters.gaps, 0.9).toFixed(1)),
          // Live batters received; and how old the pose of the batter on
          // screen was (camera capture to drawn, ms) when the phone says.
          live: counters.live,
          // The page's thread (see lagTick): script ms a second, long-task
          // ms a second, a 50 ms timer's lateness (90th percentile), hidden.
          js: Math.round(counters.js / seconds), long: Math.round(counters.long / seconds),
          lag: Math.round(core.percentile(counters.lag, 0.9)), hidden: document.hidden ? 1 : 0, opaque: opaqueCanvas ? 1 : 0,
          // Receiver 65: draws that blended only what matched; how stale the
          // picture was (p50, p90 ms); the rehearsal's draws and their ms
          // (the first ten's median, the last ten's: the drawing code warming).
          partly: counters.partly, stale: Math.round(core.percentile(counters.stale, 0.5)), stale90: Math.round(core.percentile(counters.stale, 0.9)),
          rehearsed: rehearsal.draws
        };
        if (rehearsal.ms.length >= 20) stats.rehearseMs = [rehearsal.firstMs, Number(core.percentile(rehearsal.ms.slice(-10), 0.5).toFixed(1))];
        if (steadyWatch.verdict) stats.steady = steadyWatch.verdict.fps;
        if (counters.pose.length) {
          stats.pose = Math.round(core.percentile(counters.pose, 0.5));
          stats.pose90 = Math.round(core.percentile(counters.pose, 0.9));
          // How far ahead of their poses the batters were drawn, and what
          // that leaves: camera to the TV's canvas, before its display lag.
          stats.ahead = Math.round(core.percentile(counters.ahead, 0.5));
          stats.eff = Math.round(core.percentile(counters.eff, 0.5));
          stats.eff90 = Math.round(core.percentile(counters.eff, 0.9));
        }
        send(stats);
        if (debug) setDebug(stats);
        counters.draws = 0; counters.blended = 0; counters.frames = 0; counters.redraws = 0;
        counters.late = []; counters.drawMs = []; counters.missing = 0; counters.gaps = [];
        counters.live = 0; counters.pose = []; counters.ahead = []; counters.eff = [];
        counters.js = 0; counters.long = 0; counters.lag = [];
        counters.partly = 0; counters.stale = [];
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
        + stats.behind + " ms" + (stats.pose != null ? " · pose " + stats.pose + "/" + stats.pose90 + " ms" + (stats.ahead ? " − ahead " + stats.ahead + " = " + stats.eff + "/" + stats.eff90 + " ms" : "") : "") + " · queue " + stats.queue + " · images " + stats.images + " · " + stats.w + " wide (" + stats.canvas + ")"
        + (stats.synced ? "" : " · not synced");
    }

    function noteArrival(frame) {
      prefetch(frame);
      const local = performance.now();
      clock.noteArrival(frame.s, local);
      const due = clock.offset == null ? local : frame.s + clock.offset;
      counters.late.push(Math.max(0, local - due));
      counters.frames += 1;
    }

    // Oct 18 2026 (a house party's Chromecast showed the old HTML scoreboard
    // mid-innings, "WATCH THE BALL" over a board with no ball): during play
    // the TV never shows an HTML board. With the stadium off for a moment
    // (the phone reconnecting, its stadium held) the last frame stays up with
    // a small chip; before any frame, receiver.js shows its holding screen.
    let holdChip = null;
    let holding = false;
    function holdLast(text) {
      const want = !!text && !on && !!shownFrame;
      if (want) {
        if (!holdChip) {
          holdChip = document.createElement("div");
          holdChip.className = "scene-chip";
          if (root.appendChild) root.appendChild(holdChip);
        }
        holdChip.textContent = text;
        holdChip.hidden = false;
        root.hidden = false;
        document.body.dataset.scene = "hold";
      } else {
        if (holdChip) holdChip.hidden = true;
        if (holding && !on) { root.hidden = true; document.body.dataset.scene = "off"; }
      }
      holding = want;
      return want;
    }

    function setOn(value) {
      if (value && holdChip) holdChip.hidden = true;
      holding = false;
      if (!!value && !on) {
        dropWarmCanvas();
        if (rehearsal.wanted || rehearsal.canvas) endRehearsal();
        wholeSent = false;
        steadyWatch.reset();
        root.dataset.warming = "1";
        // Receiver 70: the phone's picture covers the stadium until it is drawn (uncover).
        if (options.onCover) options.onCover(true);
        onAt = performance.now();
        // Until its first whole frame as receiver 60; then, for a phone that
        // waits for steady, up to STEADY_COVER_MS (noteWhole).
        coverUntil = onAt + COVER_MS;
        layerShownAt = 0;
      }
      if (!value) uncover();
      on = !!value;
      root.hidden = !on;
      document.body.dataset.scene = on ? "on" : "off";
      // Measured once it is on screen: hidden, the stage has no size.
      if (on) resize();
      if (!on) { timeline.clear(); live.clear(); }
    }

    function screenPixels() {
      const ratio = window.devicePixelRatio || 1;
      const width = Math.round((window.innerWidth || 1280) * ratio);
      const height = Math.round((window.innerHeight || (window.innerWidth || 1280) * 9 / 16) * ratio);
      return [width, height];
    }

    function answerHello() {
      const have = Array.from(new Set([...bundled.keys(), ...cached, ...images.keys()]));
      // `pic`: this receiver composes pictures from commands (receiver 47, build 142).
      // `card`: it shows a result as the phone's scorecard picture, drawn
      // for `screen`, its page in device pixels (receiver 50, build 154).
      // `live`: it draws the batter from live messages into each frame's
      // "B" slot (receiver 51, build 157).
      // `setup`: it shows the stadium setup as the phone's picture too, with
      // the hold ring drawn live where the picture says (receiver 52, build 158).
      // `whole`: it says when the stadium's first frame has every picture
      // (receiver 53, build 159).
      // `predict`: it reports how far ahead of its pose the live batter was
      // drawn (`ph`) and the age that leaves (`ahead`, `eff` in stats), so the
      // phone may draw it ahead (receiver 55).
      // `shared`: one phone owns the TV when a room shares it, by `claim`
      // (receiver 63, receiver-shared.js).
      // `steady`: it says when it draws steadily after the stadium comes on,
      // and how stale its picture is (`stale` in stats; receiver 65).
      // `held` (receiver 67): it keeps this many of the phone's pictures and
      // says which (`cards`, oldest first, [id, width] each; `held` messages
      // after each change), and asks for one it lacks (`want`).
      const ready = { t: "ready", scene: 1, pic: 1, card: 1, live: 1, setup: 1, whole: 1, predict: 1, shared: 1, inset: insetOff ? 0 : 1, steady: 1,
        held: options.heldKeep || 0, cards: options.heldCards ? options.heldCards() : [], screen: screenPixels(), version: VERSION, ua: navigator.userAgent, have };
      // A weak dongle: the phone sends frames and live batters at its pace.
      if (plan.weak) ready.weak = 1;
      send(ready);
      preloadBundled(helloKit);
    }

    function report(where, error) {
      send({ t: "error", where, message: String((error && error.message) || error).slice(0, 300) });
    }

    function snapshot(quality, reply) {
      const answer = reply || send;
      try {
        // The picture as the TV shows it, less the HUD: the backdrop, the
        // canvas and the shading.
        const shot = document.createElement("canvas");
        shot.width = canvas.width;
        shot.height = canvas.height;
        const c = shot.getContext("2d");
        c.fillStyle = "#0c1a17";
        c.fillRect(0, 0, shot.width, shot.height);
        if (backdropKey && images.get(backdropKey)) {
          const m = (backdropTransform.match(/[-0-9.]+/g) || []).map(Number);
          const k = shot.width / boxWidth();
          if (m.length === 6) c.setTransform(m[0] * k, 0, 0, m[3] * k, m[4] * k, m[5] * k);
          c.drawImage(images.get(backdropKey), 0, 0);
          c.setTransform(1, 0, 0, 1, 0, 0);
        }
        c.drawImage(canvas, 0, 0);
        const shade = c.createLinearGradient(0, 0, 0, shot.height);
        shade.addColorStop(0, "rgba(0,0,0,0.22)");
        shade.addColorStop(1 / 3, "rgba(0,0,0,0)");
        shade.addColorStop(2 / 3, "rgba(0,0,0,0)");
        shade.addColorStop(1, "rgba(0,0,0,0.24)");
        c.fillStyle = shade;
        c.fillRect(0, 0, shot.width, shot.height);
        const data = shot.toDataURL("image/jpeg", quality || 0.7).split(",")[1] || "";
        const parts = Math.ceil(data.length / 30000);
        for (let index = 0; index < parts; index += 1) {
          answer({ t: "snap", n: index, of: parts, d: data.slice(index * 30000, (index + 1) * 30000) });
        }
      } catch (error) { report("snap", error); }
    }

    // MARK: Messages

    function handle(message) {
      const began = performance.now();
      try { handleMessage(message); } finally { if (on) counters.js += performance.now() - began; }
    }

    function handleMessage(message) {
      if (!message || typeof message !== "object") return;
      switch (message.t) {
        case "hello":
          debug = message.debug === 1;
          // A width the phone or the bench asks for is kept as asked; else
          // the device's own plan, and a wide canvas is measured afresh.
          // `x.weak` (the bench) draws as a weak dongle does on any TV.
          plan = core.canvasPlan({ ua: navigator.userAgent, pinned: message.canvas || options.canvasWidth,
            wide: message.wide === 1, remembered: rememberedCanvas(), weak: !!(message.x && message.x.weak === 1) });
          maxCanvasWidth = plan.width;
          rateWatch.reset();
          resize();
          if (["low", "medium", "high"].indexOf(message.smooth) >= 0) smoothing = message.smooth;
          setTune(message.x);
          // A hello after a release (the page kept after all) starts afresh.
          released = false;
          clock.reset();
          timeline.reset();
          live.clear();
          lastStamp = null;
          wholeSent = false;
          // Receiver 60: the phone's kit, whose cached pieces load with the batter's.
          helloKit = typeof message.kit === "string" ? message.kit : null;
          // Receiver 65: the phone holds its first ball until the TV draws steadily.
          phoneWaitsSteady = message.steady === 1;
          steadyWatch.reset();
          wantRehearsal();
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
        case "b": {
          const batter = live.set(message);
          if (batter) {
            prefetch(batter);
            counters.live += 1;
            needsRedraw = true;
          }
          break;
        }
        case "img":
          receivePart(message);
          break;
        case "pic":
          receivePicture(message);
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
          // Pictures the phone sent as commands ("pic" messages).
          ((data && data.pictures) || []).forEach(receivePicture);
          const frames = (data.frames || []).map(core.normalizeFrame).filter(Boolean);
          if (!frames.length) return;
          setOn(true);
          if (at === -2) {
            // Film mode: a script draws each moment in turn (scripts/cast-scene-film.mjs).
            on = false;
            const sorted = frames.slice().sort((x, y) => x.s - y.s);
            // Live batters, shown from their moment as the TV would on arrival.
            const liveFrames = ((data && data.live) || []).map(core.normalizeFrame).filter(Boolean).sort((x, y) => x.s - y.s);
            let shownHUD = null;
            window.__sceneFilm = {
              start: sorted[0].s,
              end: sorted[sorted.length - 1].s,
              // The recording's own frame `index`, exactly (the parity check).
              drawIndex(index) {
                drawFrame(frames[index]);
                return null;
              },
              drawAt(t) {
                let low = 0, high = sorted.length - 1;
                while (low < high) { const mid = (low + high + 1) >> 1; if (sorted[mid].s <= t) low = mid; else high = mid - 1; }
                const a = sorted[low], b = sorted[low + 1];
                let frame = a;
                if (b && t > a.s && b.s - a.s <= core.MAX_BLEND_GAP && core.shapeKey(a) === core.shapeKey(b)) {
                  frame = core.blendFrames(a, b, Math.min(1, (t - a.s) / (b.s - a.s)));
                } else if (b && t > a.s && b.s - a.s <= core.MAX_BLEND_GAP && tune.match) {
                  // Receiver 65: what matches, as the timeline draws it.
                  frame = core.blendMatched(a, b, Math.min(1, (t - a.s) / (b.s - a.s)));
                }
                live.clear();
                for (let k = liveFrames.length - 1; k >= 0; k -= 1) {
                  if (liveFrames[k].s <= t) { live.set(liveFrames[k]); break; }
                }
                drawFrame(frame);
                for (let k = low; k >= 0; k -= 1) {
                  if (sorted[k].h) { if (sorted[k].h !== shownHUD) { shownHUD = sorted[k].h; renderHUD(shownHUD); } break; }
                }
                return null;
              }
            };
            document.body.dataset.sceneDrawn = "1";
            return;
          }
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

    // The phone waits 8 s for `ready` (iOS) and then plays without the
    // stadium. A slow TV on a crowded Wi-Fi must not spend that on its fonts
    // or its cache: each gets at most a couple of seconds before the answer.
    const atMost = (promise, ms) => Promise.race([promise, new Promise((ok) => window.setTimeout(ok, ms))]);
    Promise.all([atMost(loadBundled(), 4000), atMost(openCache(), 2000), atMost(fontsReady, 1500)]).then(() => {
      readyToAnswer = true;
      if (pendingHello) { pendingHello = false; answerHello(); }
      // Receiver 60: the pictures start loading as soon as the page is up,
      // before any phone says hello (a cast's launch is 1–2 s before it).
      else if (!options.noPreload) preloadBundled();
    });
    window.requestAnimationFrame(frameLoop);
    // A browser's page (a test's pretend page has no PerformanceObserver and no end).
    if (window.PerformanceObserver) lagTick();

    // The receiver is going away (CAF's SHUTDOWN, the page hidden): every
    // decoded bitmap and canvas let go at once (receiver 59). After a stop,
    // the Living Room TV refused to start RallyCade again for minutes
    // (LAUNCH_ERROR CANCELLED) once a session had held its bitmaps.
    let released = false;
    function release() {
      if (released) return;
      released = true;
      on = false;
      bitmaps.forEach((bitmap) => { try { if (bitmap.close) bitmap.close(); } catch (error) { /* gone */ } });
      bitmaps.clear();
      // The atlases too (loaded again after a hello).
      sheets.forEach((sheet) => {
        try { if (sheet.bitmap && sheet.bitmap.close) sheet.bitmap.close(); } catch (error) { /* gone */ }
        sheet.bitmap = null; sheet.image = null; sheet.promise = null; sheet.warmed = false;
      });
      const empty = (target) => { try { if (target && target.getContext) { target.width = 0; target.height = 0; } } catch (error) { /* gone */ } };
      layers.forEach(empty);
      layers.length = 0;
      scratches.forEach(empty);
      scratches.clear();
      tinted.forEach(empty);
      tinted.clear();
      images.forEach(empty);
      images.clear();
      backdropLayers.forEach((entry) => { try { entry.element.removeAttribute("src"); } catch (error) { /* gone */ } });
      empty(canvas);
      canvasDrawn = null;
      dropWarmCanvas();
      endRehearsal();
      dropStaticLayer();
    }

    return { NAMESPACE, handle, report, setOn, renderHUD, drawFrame, playRecording, playRecordingAt, snapshot, timeline, clock, live, images, bitmaps, release,
      pictures, counters, tune, setTune, warmed, staticLayer, holdLast, get holding() { return holding; }, get hasFrame() { return !!shownFrame; } };
  }

  window.RallycadeReceiverScene = { NAMESPACE, createScene };
})();
