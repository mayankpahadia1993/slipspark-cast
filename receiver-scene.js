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
    // Receiver 115: frames' commands by stamp, for frames that send theirs as references (core.createRefBook).
    const refs = core.createRefBook();
    let lastRefMissAt = -Infinity;
    // Whether this phone's hello said it sends references (`refs: 1`): only then are its whole frames kept as bases.
    let helloRefs = false;
    // A frame whose references can't be put back isn't drawn; the phone sends its next frame whole.
    function refMissed(raw) {
      counters.refMiss += 1;
      const local = performance.now();
      if (local - lastRefMissAt < 250) return;
      lastRefMissAt = local;
      send({ t: "refs", miss: Number(raw && raw.r) || 0 });
    }
    const images = new Map();
    const tinted = new Map();
    // Receiver 89 (Nov 11 2026): the Living Room TV's Chromecast Ultra drew 5-8 frames a second after 7.8 h and many
    // casts tonight, 30 again after a power-cycle. Whatever the page made holds the dongle's memory until it is let go:
    // a canvas dropped from a map is zeroed (its backing store goes now, not at the next collection), and the blob URLs
    // the receiver made are revoked as it stops (a backdrop layer's <img> shows one while it runs).
    const objectURLs = new Set();
    function objectURL(blob) { const url = URL.createObjectURL(blob); objectURLs.add(url); return url; }
    function zeroCanvas(target) { try { if (target && target.getContext) { target.width = 0; target.height = 0; } } catch (error) { /* gone */ } }
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
    let lastAcknowledgedStamp = null;
    let lastStats = 0;
    let lastNeed = 0;
    let readyToAnswer = false;
    let pendingHello = false;
    let hasHello = false;
    let helloKit = null;
    // The grounds (docs/grounds.md): the plate the phone's hello names ("ground-<id>-1672x941"; nil the classic
    // stadium). Only that ground's picture loads with the stadium; the other grounds' load only if a frame draws them.
    let helloGround = null;
    // Receiver 82 (Nov 10 2026, grounds in every view): the hello's `views`, the ground's own pictures the phone draws
    // this game in place of the classic whole-ground photo and bowler's-end view (groundViews).
    let helloViews = null;
    // Receiver 86 (Nov 11 2026): the hello's `pieces` (Android: the coming look's dressed pieces, its install's dressing
    // in their keys): those this TV keeps load with the stadium's first pictures, so a re-cast's look is here at once.
    let helloPieces = new Set();
    // `received` (receiver 83): the phone's pictures decoded since the last report (core.warmReport).
    const counters = { draws: 0, blended: 0, frames: 0, late: [], drawMs: [], dressMax: 0, dressReadMax: 0, dressDyeMax: 0, dressed: 0, missing: 0, redraws: 0, gaps: [], live: 0, pose: [], ahead: [], eff: [],
      js: 0, long: 0, lag: [], partly: 0, stale: [], received: 0, coldHeld: 0, warmedLate: 0, coldHeldTotal: 0, warmedLateTotal: 0,
      refFrames: 0, refMiss: 0 };

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
    // Receiver 105: counts every change to which picture a key draws (a picture in, a look chosen, the whites on or
    // off): the live batter's layer (liveLayer) is kept only while it holds.
    let artEpoch = 0;

    function addImage(key, source) {
      images.set(key, source);
      artEpoch += 1;
      if (missingPieces.delete(key)) dressingLast = performance.now();
      piecesStalled.delete(key);
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
      tinted.forEach(zeroCanvas);
      tinted.clear();
      entry.ready = true;
      loading.delete(key);
      addImage(key, target);
      composed.push(key);
      while (composed.length > MAX_COMPOSED) {
        const old = composed.shift();
        const gone = pictures.get(old);
        if (gone && old !== key) {
          gone.ready = false;
          // Receiver 89: its canvas (and any bitmap of it) goes now.
          zeroCanvas(images.get(old));
          const bitmap = bitmaps.get(old);
          if (bitmap) { try { if (bitmap.close) bitmap.close(); } catch (error) { /* gone */ } bitmaps.delete(old); }
          images.delete(old);
          opaque.delete(old);
        }
      }
      send({ t: "got", k: key });
      // An opaque picture (the practice net) goes on the GPU layer as a
      // photo does: an image with a source, not a canvas.
      if (entry.opaque && typeof target.toBlob === "function") {
        target.toBlob((blob) => {
          if (!blob || images.get(key) !== target) return;
          loadImage(objectURL(blob)).then((image) => {
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
      // Receiver 77: from the TV's own copy when it has one.
      sheet.promise = keptURL("scene-images/" + sheet.file).then((url) => decodePicture(id, url)).then(({ image, bitmap }) => {
        // A file that isn't the size the manifest says is out of date.
        if ((image.naturalWidth || image.width) !== sheet.width || (image.naturalHeight || image.height) !== sheet.height) {
          throw new Error("atlas " + sheet.file + " is " + (image.naturalWidth || image.width) + "x" + (image.naturalHeight || image.height));
        }
        if (released) { if (bitmap && bitmap.close) bitmap.close(); sheet.promise = null; return; }
        sheet.image = image;
        sheet.bitmap = bitmap;
        addSprites(sheet);
        warmSheet(sheet);
        // Its kit masks with it when the phone's hello named a dyed kit (receiver 73), before his first ball.
        prepareDressingSheet(id);
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
    let preloadGround = null;
    // A hello's ground as its picture key: "ground-hilltop-1672x941" (or the id "ground-hilltop"), else null.
    function groundKey(ground) {
      if (typeof ground !== "string" || !/^ground-[a-z0-9-]{1,40}$/.test(ground)) return null;
      return /-\d+x\d+$/.test(ground) ? ground : ground + "-1672x941";
    }
    // Receiver 82 (Nov 10 2026, docs/grounds.md): a phone that draws the ground's own whole-ground photo and
    // bowler's-end view names them in its hello (`views`): "ground-<id>-outfield-1672x941" stands in for
    // field-outfield-1672x941 and "ground-<id>-inset-660x372" for bowler-end-inset-660x372 this game. They preload
    // as the classic pictures would (the outfield with the fielders, the inset with the first frame's) and the
    // classic ones they stand in for don't: a Chromecast holds one whole-ground photo, as before. An older phone
    // sends no `views` and draws the classic two at every ground, so they preload as ever. One of each kind, from the
    // list's first few entries; anything else is ignored.
    //
    // The real-size ground (Nov 19 2026, docs/PLATFORMS.md "Real-size ground"): a phone from then draws the whole ground on
    // field-real-outfield-1672x941 (and each ground's "ground-<id>-real-outfield-1672x941"), the pitch at real size, and
    // names it in `views` even at the classic ground. It preloads in field-outfield-1672x941's place, which an older phone
    // still draws (and is then the only one preloaded: an unnamed field-real-outfield waits for a frame that draws it).
    let preloadViews = { outfield: null, inset: null };
    function groundViews(views) {
      const found = { outfield: null, inset: null };
      if (!Array.isArray(views)) return found;
      for (const key of views.slice(0, 4)) {
        if (key === "field-real-outfield-1672x941") { if (!found.outfield) found.outfield = key; continue; }
        if (typeof key !== "string" || !/^ground-[a-z0-9-]{1,60}-\d+x\d+$/.test(key)) continue;
        const kind = /-outfield-\d+x\d+$/.test(key) ? "outfield" : /-inset-\d+x\d+$/.test(key) ? "inset" : null;
        if (kind && !found[kind]) found[kind] = key;
      }
      return found;
    }
    // The classic picture one of the hello's views stands in for ("outfield", "inset"), else null.
    function viewKind(key) {
      if (key === preloadViews.outfield) return "outfield";
      if (key === preloadViews.inset) return "inset";
      return null;
    }
    // Receiver 83 (Nov 10 2026, the owner: "If cricket is selected, we should only download cricket. If pickleball is
    // selected, we should only download pickleball."): with `options.waitForGame` (the receiver page on a TV) the
    // stadium's pictures and its rehearsal wait until the phone starts or asks for cricket (`selectGame`, from
    // receiver.js: a cricket screen in the game state, the stadium on, its frames), and pause while pickleball is on.
    // A phone of any age sends those for cricket; a frame drawing a picture still loads it at once (`ensure`).
    //
    // Receiver 84 (Nov 11 2026, fn6t394j: Android 27431 pressed Play 0.8 s into the setup and the Ultra had 2 of its
    // pictures as the stadium came on, every one 8.7 s later): before either game is chosen the stadium's pictures this
    // TV already keeps (receiver 77's copies, its picture cache) load from the TV itself, so nothing is downloaded
    // before cricket is chosen and nothing waits for Play; the rest come from the site once it is. Pickleball chosen:
    // none of them.
    //
    // Receiver 111 (Nov 23 2026, hpk8jqqg, af3vk9bt: "a little bit lag at the start for Cricket in both Android and
    // iOS"): no game chosen is a game too. When the player leaves pickleball (its view goes off, receiver.js) the TV is
    // back to no game chosen, so the stadium's pictures it keeps load from its own copies again (iOS 394 left
    // pickleball for a full match and the Ultra loaded nothing of cricket until the bowling's stadium came on, 12 s
    // later; `preloadMs` 115748), and the rehearsal draws as soon as they are all in (`rehearse`).
    let cricketWanted = !options.waitForGame;
    let selectedGame = options.waitForGame ? null : "cricket";
    // When cricket was last chosen (performance.now()): the rehearsal's REHEARSAL_WAIT counts from then at the earliest.
    let cricketAt = 0;
    // The receiver's own pictures a phone's picture asked for before cricket was (a 3.0 phone composes its grip at the
    // cast's start): fetched once it is.
    const deferredEnsure = new Set();
    function keptHere(path) { return !!keptDb && (keptFiles.has(path) || carried.has(path)); }
    // Whether `key` would load from the TV's own copy, not the site.
    function onThisTV(key) {
      const cut = cutOf(key);
      if (cut) { const sheet = sheets.get(cut.atlas); return !!sheet && keptHere("scene-images/" + sheet.file); }
      if (bundled.has(key)) return keptHere("scene-images/" + bundled.get(key));
      return cached.has(key) && !!database;
    }
    // Before a game is chosen, only the TV's own copies; once cricket is, everything; pickleball, nothing.
    function mayLoad(key) { return cricketWanted || (selectedGame === null && onThisTV(key)); }
    function selectGame(game) {
      const before = selectedGame;
      selectedGame = game === "cricket" || game === "pickleball" ? game : null;
      const wanted = selectedGame === "cricket";
      const changed = wanted !== cricketWanted;
      cricketWanted = wanted;
      // Receiver 111: back to no game chosen (pickleball left): the TV's own copies load again.
      if (selectedGame === null && before !== null) pumpSome();
      if (!changed || !wanted) return;
      cricketAt = performance.now();
      const waiting = Array.from(deferredEnsure);
      deferredEnsure.clear();
      waiting.forEach(ensure);
      pumpSome();
    }
    // Receiver 77: when the preload last ran dry (stats `preloadMs`, from the
    // hello), and how many of the start's pictures are on their way.
    let preloadDoneAt = null;
    let startLoading = 0;
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
      // The ground the hello named is the stadium photo; its views (receiver 82) come where the classic inset (2) and
      // outfield (5) would; another ground's pictures wait for a frame that draws them.
      if (/^ground-/.test(key)) {
        if (key === preloadGround) return 0;
        const kind = viewKind(key);
        return kind === "inset" ? 2 : kind === "outfield" ? 5 : 9;
      }
      if (/^stadium-/.test(key)) return 0;
      if (/^stroke-/.test(key)) return 1;
      if (preloadKit && key.indexOf("kit-" + preloadKit + "-") === 0) return 1;
      if (helloPieces.has(key)) return 1;
      if (/^bowler-11-/.test(key)) return 2;
      if (/^bowler-/.test(key)) return 3;
      if (/^fielder-[A-Za-z]+-idle-/.test(key)) return 4;
      if (/^field-(real-)?outfield-/.test(key)) return 5;
      if (/^fielder-/.test(key)) return 6;
      // A hello that names no kit (Android): any kit's cached pieces may be the batter's.
      if (/^kit-/.test(key) && !preloadKit) return 6;
      return 7;
    }
    // Receiver 77 (d6ne64t0): the start's pictures, every one the stadium
    // and the rehearsal draw (ranks 0-6: the stadium, the batter and his
    // kit, the inset's atlases, the bowlers, the fielders, the outfield).
    // The rest (the practice lane, and pictures earlier casts left in the
    // TV's cache: other kits' pieces) waits while the rehearsal draws and
    // while the stadium is on (`restWaits`: loaded during play on the
    // Ultra, they took its fourth to sixth seconds from 30 draws a second to
    // 8-17); a frame that wants one has it at once (`ensure`).
    const START_RANK = 6;
    function isStart(key) { return preloadRank(key) <= START_RANK; }
    function preloadBundled(kit, ground, views) {
      preloadKit = typeof kit === "string" && /^[a-z0-9-]{1,40}$/.test(kit) ? kit : null;
      preloadGround = groundKey(ground);
      preloadViews = groundViews(views);
      // A dyed kit's batter on the inset: the atlases' kit masks now (receiver 73).
      if (!insetOff) sheets.forEach((sheet, id) => { if (sheet.image) prepareDressingSheet(id); });
      // This TV's own copies of pictures earlier casts sent too (receiver
      // 53): build 158's innings opened with 22–59 draws a second missing a
      // photo the TV had cached but not yet loaded.
      const byRank = (a, b) => preloadRank(a) - preloadRank(b);
      // Before hello there is no known wardrobe. A current phone names its
      // exact pieces: older casts' kits must not occupy startup decode slots.
      // Legacy phones without pieces retain their kit-based ordering.
      const relevant = (key) => !isDressedPiece(key) || (hasHello && (!helloPieces.size || helloPieces.has(key)));
      const extra = Array.from(cached).filter((key) => !bundled.has(key) && relevant(key)).sort(byRank).slice(0, MAX_CACHED_PRELOAD);
      // A weak dongle draws no bowler's-end inset (the phone leaves it out): neither the classic view nor a ground's.
      // Grounds: only the named one and its views, and then not the classic stadium's photos (a weak Chromecast keeps
      // one plate), nor the classic pictures its views stand in for (receiver 82).
      const wanted = (key) => {
        // Receiver 88 (Nov 12 2026): the bowler's-end view's whole plate is a full match's bowling only (the phone draws
        // its bowling view as the stadium's frames, docs/design/FULL_MATCH.md "TV v2"): loaded when a frame draws it,
        // never with an innings' pictures. A ground's own (ground-<id>-bowler-end-*) is another ground's picture already.
        if (/^bowler-end-plate-/.test(key)) return false;
        if (insetOff && (/^bowler-end-/.test(key) || viewKind(key) === "inset")) return false;
        if (/^ground-/.test(key)) return key === preloadGround || viewKind(key) !== null;
        if (preloadGround && /^stadium-(ground|backdrop)-/.test(key)) return false;
        if (preloadViews.outfield && /^field-outfield-/.test(key)) return false;
        if (/^field-real-outfield-/.test(key)) return key === preloadViews.outfield;
        return !(preloadViews.inset && /^bowler-end-inset-/.test(key));
      };
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
      preloadDoneAt = null;
      pumpSome();
    }
    // The next picture the preload would load (those already here or on
    // their way dropped), or null.
    function nextPreload() {
      while (preloadQueue.length && (images.has(preloadQueue[0]) || loading.has(preloadQueue[0]))) preloadQueue.shift();
      return preloadQueue.length ? preloadQueue[0] : null;
    }
    function pumpPreload() {
      if (!cricketWanted && selectedGame !== null) return false;
      let next = nextPreload();
      if (next === null) {
        if (!preloading && preloadDoneAt === null) { preloadDoneAt = performance.now(); pruneKept(); }
        return false;
      }
      // Receiver 84: no game chosen yet: the next of the TV's own copies, the rest left queued for cricket.
      let at = 0;
      if (!cricketWanted) {
        at = preloadQueue.findIndex((key) => !images.has(key) && !loading.has(key) && onThisTV(key));
        if (at < 0) return false;
        next = preloadQueue[at];
      }
      // Receiver 77: the rest waits while a rehearsal is due and while the stadium is on.
      if (!isStart(next) && restWaits()) return false;
      preloadDoneAt = null;
      const key = preloadQueue.splice(at, 1)[0];
      const start = isStart(key);
      preloading += 1;
      if (start) startLoading += 1;
      const done = () => { preloading -= 1; if (start) startLoading -= 1; window.setTimeout(pumpPreload, 20); };
      const cut = cutOf(key);
      if (cut) {
        loadSheet(cut.atlas).then(done);
        return true;
      }
      loading.add(key);
      const source = bundled.has(key) ? keptURL("scene-images/" + bundled.get(key))
        : database ? loadCached(key) : Promise.reject(new Error("no cache"));
      source.then((url) => loadPicture(key, url))
        .then(() => {
          // The stadium's photos get their GPU layer now, decoded while the
          // setup shows: made at the first frame, it took the first stadium
          // of a cast 0.7-1 s on a Chromecast Ultra.
          // Receiver 65: the replay's outfield too (made at the first replay,
          // it cost an onn's first replay a 283 ms/s of long tasks).
          // Receiver 82: a ground's plate and outfield, never its inset (drawn small on the canvas, as the classic one).
          if (/^(stadium-(ground|backdrop)|field-(real-)?outfield|ground)-/.test(key) && !/-inset-\d+x\d+$/.test(key) && opaque.has(key)) backdropLayer(key);
          warmDecode(key);
        }, () => loading.delete(key))
        .then(done, done);
      return true;
    }
    function pumpSome() { while (preloading < 3 && pumpPreload()) { /* three at a time */ } }
    // The start's pictures are all in (or wouldn't load): none queued, none on its way.
    function startPicturesIn() {
      if (startLoading) return false;
      const next = nextPreload();
      return next === null || !isStart(next);
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
      // Receiver 113: with the stadium on, warmed a frame at a time in the frame's spare time (warmLate).
      if (on && WARM_MODE !== "off" && !released && tune.cold) { queueLateWarm(key); return; }
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
        hotSources.add(source);
        return true;
      } catch (error) { return false; /* decoded at the first frame instead */ }
    }
    function dropWarmCanvas() {
      if (!warmCanvas) return;
      try { warmCanvas.width = 0; warmCanvas.height = 0; } catch (error) { /* gone */ }
      warmCanvas = null;
    }

    // MARK: Cold pictures in play (receiver 113, Nov 27 2026)
    //
    // fgqcsp7e (the owner on Android 27580, staging 112, a match's chase on the Living Room TV's Chromecast Ultra): one
    // stadium draw took 673 ms and the frame loop stopped for 1404 ms, frames came 2317 ms late and the phone read that as
    // a Wi-Fi that can't carry the stream (15 a second for the next 30 s). The chase's pictures had come in with the
    // stadium on (images 74 -> 141), where nothing warmed them (warmDecode runs with the stadium off), so the first draw
    // that showed them decoded and uploaded them all at once, on the page's thread. On that TV (Nov 27): 26 fresh
    // fielder pictures drawn in one frame held it 267 ms with 2 ms of script; drawn first one an animation frame into the
    // warm-up's 256 x 256 canvas, no frame was late and the frame with all 26 took 33 ms. So with the stadium on:
    //  - a picture that comes in is warmed so in a later animation frame, one a frame, only while that frame's own
    //    script has been short (LATE_WARM_IDLE_MS): most come ahead of the frame that shows them;
    //  - a frame that would still draw more than COLD_DRAW_MAX pictures never drawn before keeps the picture on screen
    //    while they are warmed COLD_WARM_PER_FRAME a frame, COLD_HOLD_MS at most (then it draws, as before).
    // A picture is hot once drawn on any canvas (drawPicture) or warmed. `coldHeld` and `warmedLate` in stats; `cold: 0`
    // (a bench switch) draws as receiver 112 did; `cold: 2` only holds (nothing warmed ahead). receiver-cold-pictures.test.cjs.
    const COLD_WARM_PER_FRAME = 2, COLD_DRAW_MAX = 2, COLD_HOLD_MS = 600, LATE_WARM_IDLE_MS = 12, LATE_WARM_SIDE = 256;
    const hotSources = new WeakSet();
    const lateWarm = [];
    const lateQueued = new Set();
    let lateWarmCanvas = null;
    let coldHoldSince = null;
    function queueLateWarm(key) {
      if (lateQueued.has(key) || backdropLayers.has(key)) return;
      lateQueued.add(key);
      lateWarm.push(key);
    }
    // What a key draws from: a picture's own image or bitmap, or a sprite's atlas; null for a canvas (nothing to decode)
    // or a picture not here.
    function warmSource(key) {
      const image = images.get(key);
      if (!image) return null;
      const source = image.sprite ? (image.sheet ? image.sheet.bitmap || image.sheet.image : null) : bitmaps.get(key) || image;
      if (!source || (typeof HTMLCanvasElement !== "undefined" && source instanceof HTMLCanvasElement)) return null;
      return source;
    }
    function warmLate(source) {
      try {
        if (!lateWarmCanvas) { lateWarmCanvas = document.createElement("canvas"); lateWarmCanvas.width = LATE_WARM_SIDE; lateWarmCanvas.height = LATE_WARM_SIDE; }
        lateWarmCanvas.getContext("2d").drawImage(source, 0, 0, LATE_WARM_SIDE, LATE_WARM_SIDE);
      } catch (error) { /* drawn cold at its first frame instead */ }
      hotSources.add(source);
      counters.warmedLate += 1;
      counters.warmedLateTotal += 1;
    }
    function dropLateWarm() {
      lateWarm.length = 0;
      lateQueued.clear();
      coldHoldSince = null;
      zeroCanvas(lateWarmCanvas);
      lateWarmCanvas = null;
    }
    // One queued picture a frame, while this frame's script has been short.
    function warmQueued(began) {
      while (lateWarm.length && performance.now() - began < LATE_WARM_IDLE_MS) {
        const key = lateWarm.shift();
        lateQueued.delete(key);
        const source = warmSource(key);
        if (source && !hotSources.has(source)) { warmLate(source); return; }
      }
    }
    // The pictures a draw of `frame` (and the live batter) would decode for the first time. A received frame or batter
    // found all hot isn't looked at again until a picture comes in (`artEpoch`): a blended draw looks at the two frames
    // it blends between.
    const hotSeen = new WeakMap();
    function coldSources(frame, batter) {
      const cold = [];
      const look = (owner) => {
        if (!owner || !owner.o || hotSeen.get(owner) === artEpoch) return;
        const before = cold.length;
        for (const op of owner.o) {
          if (op[0] !== "i") continue;
          const source = warmSource(op[3]);
          if (source && !hotSources.has(source) && cold.indexOf(source) < 0) cold.push(source);
        }
        if (cold.length === before) hotSeen.set(owner, artEpoch);
      };
      if (frame.scratch && frame.__from) { look(frame.__from); look(frame.__to); } else look(frame);
      if (batter && hasLiveSlot(frame)) look(batter);
      return cold;
    }
    function hasLiveSlot(frame) {
      if (frame.__slot === undefined) frame.__slot = frame.o.some((op) => op[0] === "B");
      return frame.__slot;
    }
    // Whether this animation frame keeps the picture on screen while cold pictures are warmed (see above).
    function holdsForCold(frame, local) {
      if (!tune.cold || !shownFrame || rehearsing) { coldHoldSince = null; return false; }
      const cold = coldSources(frame, live.current);
      if (!cold.length) { coldHoldSince = null; return false; }
      for (let index = 0; index < COLD_WARM_PER_FRAME && cold.length; index += 1) warmLate(cold.shift());
      if (cold.length <= COLD_DRAW_MAX) { coldHoldSince = null; return false; }
      if (coldHoldSince === null) coldHoldSince = local;
      if (local - coldHoldSince >= COLD_HOLD_MS) { coldHoldSince = null; return false; }
      counters.coldHeld += 1;
      counters.coldHeldTotal += 1;
      return true;
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
    //
    // Receiver 77 (d6ne64t0, Oct 29 2026, the owner on an onn 4K: "it lagged a
    // bit when I started the game with chromecast, became better
    // afterwards"): the stadium's first draw took 801 ms and the TV drew ~19 a
    // second for 5 s, steady only then; innings 2, its drawing warm from
    // innings 1, was steady in 2.1 s. The rehearsal had drawn 6 of its 200:
    // it waited for every picture the preload had queued, the inset's, every
    // fielder's pose and up to 48 pictures earlier casts left in the TV's
    // cache, and on a real TV that outlasts a setup (the owner's Ultra logs
    // of Oct 23 say `rehearsed 0` in every innings; the bench, its cache
    // empty, rehearsed all 200). Now it starts once the start's pictures are
    // in (`startPicturesIn`; REHEARSAL_WAIT after the hello at the latest)
    // and draws alone: the rest of the preload waits for it (drawing beside
    // the preload, the Ultra's preload ran into the stadium's first second).
    // Before the page's first stadium it draws into the stadium's own canvas
    // (hidden, nothing on it to keep), so the stadium's first frame is not
    // that canvas's first draw either; once a stadium has been shown, off
    // screen as before. `stats.rehearseAt` says when it began, `preloadMs`
    // when the preload ran dry (ms from the hello).
    const REHEARSAL_DRAWS = 200;
    const REHEARSAL_WAIT = 6000;
    // A weak dongle (each draw costs it ~30 ms of its page's thread) draws
    // fewer, about every third animation frame, so its setup screen stays
    // smooth meanwhile.
    const WEAK_REHEARSAL_DRAWS = 60;
    const WEAK_REHEARSAL_GAP = 90;
    let rehearsing = false;
    // A frame older than this when drawn is a pause's held frame, not a stale picture (stats `stale`).
    const STALE_FLOWING = 250;
    const rehearsal = { data: null, wanted: false, timeline: null, canvas: null, ctx: null, moment: 0, end: 0, draws: 0, ms: [], firstMs: 0, lastAt: -Infinity,
      askedAt: 0, startedAt: 0, own: false, waitFrom: 0, resumed: false };

    // MARK: How warm the stadium's drawing is (receiver 111)
    //
    // Nov 23 2026 (the owner on build L, iOS 394 and Android 27560 on the Living Room TV's Chromecast Ultra: "There was a
    // little bit lag at the start for Cricket in both Android and iOS"): the TV drew the stadium unsteadily for 7.5 s
    // (iOS: every picture in 107 ms after it came on, 4-17 draws a second, `gap90` 752, the picture 954 ms behind) and
    // 3.8 s (Android: 7 a second), the walk-out waiting meanwhile. Neither TV had drawn its rehearsal: iOS `rehearsed 0`,
    // Android 55 of 200. iOS came from pickleball, so cricket stayed unchosen until a full match's bowling stadium came
    // on, for 0.6 s while the bowling was skipped, and that ended the rehearsal for good (nothing asked for it again until
    // the next hello). Android cast from cricket's home; its pictures were in from the TV's own copies at the hello, but
    // the rehearsal waited for cricket to be chosen, at the setup, 2.8 s before the stadium.
    //
    // Now: the rehearsal draws before any game is chosen once every one of the start's pictures is in from the TV's own
    // copies (nothing downloaded: receiver 83's rule); a stadium that goes off before the drawing is warm (the bowling's)
    // asks for the rest of it again, its draws so far kept; REHEARSAL_WAIT counts from when cricket was chosen or the
    // rehearsal asked for again, not from a hello long before. And a stadium that still comes on cold keeps the phone's
    // picture over it ("You're ready") while it draws beneath, until a rehearsal's worth of draws is done, COVER_MS at
    // most; the steady watch then starts on the stadium itself, as receiver 70 has it.
    // Warm: a rehearsal drew all its draws on this page, or a stadium drew steadily, or the rehearsal's and the stadium's
    // own draws come to a rehearsal's worth. A page stays warm across hellos (a reconnect is not a cold start).
    let rehearsedFully = false;
    let drewSteadily = false;
    let stadiumDraws = 0;
    function rehearsalTarget() { return plan && plan.weak ? WEAK_REHEARSAL_DRAWS : REHEARSAL_DRAWS; }
    function drawingWarm() { return rehearsedFully || drewSteadily || rehearsal.draws + stadiumDraws >= rehearsalTarget(); }
    // The receiver judges warmth by its rehearsal (a preview or a test page with none keeps receiver 70's cover).
    function judgesWarmth() { return !!tune.warm && !!tune.early && !!rehearsal.data && !options.noRehearsal; }

    function loadRehearsal() {
      return fetch("rehearsal.json").then((response) => (response && response.ok && typeof response.json === "function" ? response.json() : null))
        .then((data) => {
          if (!data || !Array.isArray(data.frames) || !data.frames.length) return;
          rehearsal.data = data;
          // A hello that came first.
          if (rehearsal.asked && !on) wantRehearsal(rehearsal.askedAt);
        }).catch(() => {});
    }

    // Due after each hello (the phone's innings is coming) once the
    // pictures are in; the weak plan's own canvas and tune with it.
    // Receiver 111: `resume`, a stadium went off before the drawing was warm: the rest of the rehearsal, its draws so far
    // kept, REHEARSAL_WAIT from now.
    function wantRehearsal(askedAt, resume) {
      const at = askedAt == null ? performance.now() : askedAt;
      if (!resume) {
        rehearsal.asked = true;
        rehearsal.askedAt = at;
      }
      rehearsal.waitFrom = at;
      if (!rehearsal.data || options.noRehearsal) return;
      rehearsal.wanted = true;
      rehearsal.resumed = !!resume;
      if (resume) return;
      rehearsal.draws = 0;
      rehearsal.ms = [];
      rehearsal.firstMs = 0;
      rehearsal.startedAt = 0;
    }

    // Receiver 77: due once the start's pictures are in, or REHEARSAL_WAIT
    // after the hello whatever is in (a load that never ends waits on no
    // rehearsal). `x.early: 0`: once the whole preload is done, as before.
    // Receiver 111: with no game chosen, only once the start's pictures are all in (from the TV's own copies: nothing
    // else loads then); REHEARSAL_WAIT from cricket chosen or the rehearsal asked for again, whichever came last.
    function rehearsalReady(local) {
      if (!tune.early) return !preloadQueue.length && !preloading;
      if (startPicturesIn()) return true;
      return cricketWanted && local - Math.max(rehearsal.waitFrom, cricketAt) >= REHEARSAL_WAIT;
    }

    // The rest of the preload waits while a rehearsal is due and while the stadium is on.
    function restWaits() {
      if (!tune.early) return false;
      return on || (rehearsal.wanted && !released);
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
      // Receiver 111: with cricket chosen, or no game yet (`rehearsalReady`); never while pickleball is on.
      if (!rehearsal.wanted || (!cricketWanted && selectedGame !== null) || on || released || !rehearsalReady(local)) return;
      if (plan.weak && local - rehearsal.lastAt < WEAK_REHEARSAL_GAP) return;
      // Receiver 77: the stadium's own canvas while no stadium has been shown
      // on this page (hidden: nothing on it to keep, no held frame); else one
      // of its size off screen, so a held frame is never drawn over.
      const own = !!tune.own && !shownFrame && !!root.hidden;
      if (!own && (!rehearsal.canvas || rehearsal.canvas.width !== canvas.width || rehearsal.canvas.height !== canvas.height)) {
        rehearsal.canvas = document.createElement("canvas");
        rehearsal.canvas.width = canvas.width;
        rehearsal.canvas.height = canvas.height;
        rehearsal.ctx = rehearsal.canvas.getContext("2d", { alpha: !opaqueCanvas });
      }
      if (own) rehearsal.own = true;
      if (!rehearsal.startedAt) rehearsal.startedAt = local;
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
      if (!own) {
        ctx = rehearsal.ctx;
        canvas = rehearsal.canvas;
      }
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
      // Receiver 111: asked for again after a stadium, it is done once its draws and the stadium's make a rehearsal's worth.
      if (rehearsal.draws >= rehearsalTarget()) { rehearsedFully = true; endRehearsal(); } else if (rehearsal.resumed && drawingWarm()) endRehearsal();
    }

    // Done, or the stadium came on: the canvas let go, and the static layer
    // starts afresh from the first real frame. Receiver 77: the stadium's own
    // canvas, if it rehearsed there, is cleared (its first frame clears it
    // whole too: nothing it drew is known).
    function endRehearsal() {
      rehearsal.wanted = false;
      rehearsal.timeline = null;
      if (rehearsal.canvas) { try { rehearsal.canvas.width = 0; rehearsal.canvas.height = 0; } catch (error) { /* gone */ } }
      rehearsal.canvas = null;
      rehearsal.ctx = null;
      const own = rehearsal.own;
      rehearsal.own = false;
      if (own && !released) {
        try {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = "source-over";
          if (opaqueCanvas) { ctx.fillStyle = "#0c1a17"; ctx.fillRect(0, 0, canvas.width, canvas.height); } else ctx.clearRect(0, 0, canvas.width, canvas.height);
        } catch (error) { /* gone */ }
        canvasDrawn = null;
      }
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
    // Receiver 87: when a draw last lacked a picture (no plateau verdict while the stadium is still loading).
    let lastMissingAt = -Infinity;
    const STEADY_COVER_MS = 8000;
    let phoneWaitsSteady = false;
    let onAt = 0;
    function noteSteady(verdict, local) {
      if (!verdict) return;
      // Receiver 111: a stadium that drew steadily has warm drawing (no rehearsal asked for when it goes off).
      drewSteadily = true;
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
        window.RallycadeHold(node, coldOn ? warmProgress(local) : steadyWatch.progress(local), "Getting the TV ready");
      }
    }

    // Receiver 111: the stadium came on cold (`judgesWarmth`, a phone that holds its first ball for steady, the drawing
    // not warm): the phone's picture stays over it while it draws beneath until the drawing is warm, COVER_MS at most
    // (frameStep). Its ring fills with the warming and the time, never going back (receiver 70: "the circle keeps on
    // restarting"). `wasCold` and `uncoveredAt` for the stats (`cold`, `cover`).
    let coldOn = false;
    let wasCold = false;
    let coldProgress = 0;
    let uncoveredAt = 0;
    function warmProgress(local) {
      const drawn = Math.min(1, (rehearsal.draws + stadiumDraws) / rehearsalTarget());
      coldProgress = Math.max(coldProgress, drawn, Math.min(1, Math.max(0, local - onAt) / COVER_MS));
      return coldProgress;
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
      if (root.dataset.warming && on) uncoveredAt = performance.now();
      coldOn = false;
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
      return Promise.all([pictures, atlases, openKept()]);
    }

    // MARK: The receiver's own pictures kept on the TV (receiver 77)
    //
    // d6ne64t0 (Oct 29 2026): a Chromecast keeps no HTTP cache from one cast
    // to the next. The Living Room TV's Ultra downloaded all 63 of the
    // pictures it preloads again three minutes after its last cast (resource
    // timing: each transfer the file's whole size), so every cast fetched
    // the stadium's ~12 MB of pictures anew, three at a time, while the
    // phone's home and setup screens showed; the owner's onn spent most of
    // the 7.7 s from its hello to the stadium on that, and its rehearsal drew
    // 6 of its 200 draws. Each file is now kept in IndexedDB
    // (`stored.kept`) the first time it comes, under the deploy's receiver
    // tree (`DEPLOYED.json`, scripts/deploy-cast-receiver.sh: any change to
    // the receiver's files is a new tree), and read from there by later
    // casts; files of any other tree are dropped once the preload is done.
    // Served without a DEPLOYED.json (a preview, a test) nothing is kept.
    // `stats.kept` and `stats.fetched` say how many files came from the TV and from the network.
    //
    // Receiver 83 (Nov 10 2026): a deploy keeps the files it didn't change. Each deploy is a new tree, so every TV
    // fetched all ~13 MB of the receiver's pictures again on its first cast after one (iOS 293's first cast to
    // staging 82 drew 7-12 a second while it did, qnkrpct6). DEPLOYED.json's `previous` names the tree deployed
    // before this one and the files this one changed or added (scripts/deploy-cast-receiver.sh); the TV's copies of
    // that tree's other files are this one's: read where they are (`stats.carried`), and moved under this tree once
    // the preload is done, before the other trees' files go.
    let keptDb = null;
    let keptTree = null;
    const keptFiles = new Set();
    const carried = new Map(); // path -> the key its copy is kept under (the previous tree's)
    const keptCounts = { read: 0, fetched: 0, carried: 0 };
    // DEPLOYED.json's `previous` and (receiver 89) `earlier`, the ones that make sense, newest first:
    // [{ tree, changed: Set of paths }]. Receiver 89 (Nov 11 2026): a TV that skipped a deploy or two carries its
    // copies from the newest tree it holds (the owner's TV cast staging 84, then 86: 86 named only 85, kept 0).
    function previousDeploys(deployed, tree) {
      const listed = deployed ? [deployed.previous].concat(Array.isArray(deployed.earlier) ? deployed.earlier.slice(0, 8) : []) : [];
      const seen = new Set([tree]);
      const found = [];
      listed.forEach((previous) => {
        if (!previous || typeof previous.tree !== "string" || !/^[0-9a-f]{7,64}$/.test(previous.tree) || seen.has(previous.tree)) return;
        if (!Array.isArray(previous.changed) || previous.changed.length > 5000 || !previous.changed.every((path) => typeof path === "string")) return;
        seen.add(previous.tree);
        found.push({ tree: previous.tree, changed: new Set(previous.changed) });
      });
      return found;
    }
    function openKept() {
      if (!window.indexedDB || options.noKept) return Promise.resolve();
      let previous = [];
      const tree = fetch("DEPLOYED.json").then((response) => (response && response.ok && typeof response.json === "function" ? response.json() : null))
        .then((deployed) => {
          const found = deployed && typeof deployed.receiverTree === "string" && /^[0-9a-f]{7,64}$/.test(deployed.receiverTree) ? deployed.receiverTree : null;
          if (found) previous = previousDeploys(deployed, found);
          return found;
        })
        .catch(() => null);
      return tree.then((found) => new Promise((resolve) => {
        if (!found) { resolve(); return; }
        let request;
        try { request = window.indexedDB.open(stored.kept, 1); } catch (error) { resolve(); return; }
        request.onupgradeneeded = () => request.result.createObjectStore("files");
        request.onerror = () => resolve();
        request.onsuccess = () => {
          const db = request.result;
          try {
            const keys = db.transaction("files", "readonly").objectStore("files").getAllKeys();
            keys.onsuccess = () => {
              const rank = new Map(); // path -> the index in `previous` of the tree it's carried from (newest wins)
              (keys.result || []).forEach((key) => {
                const text = String(key);
                if (text.indexOf(found + "/") === 0) { keptFiles.add(text.slice(found.length + 1)); return; }
                const slash = text.indexOf("/");
                const at = slash > 0 ? previous.findIndex((entry) => entry.tree === text.slice(0, slash)) : -1;
                if (at < 0) return;
                const path = text.slice(slash + 1);
                if (previous[at].changed.has(path) || (rank.has(path) && rank.get(path) <= at)) return;
                rank.set(path, at);
                carried.set(path, text);
              });
              keptFiles.forEach((path) => carried.delete(path));
              keptDb = db;
              keptTree = found;
              resolve();
            };
            keys.onerror = () => resolve();
          } catch (error) { resolve(); }
        };
      }));
    }

    // Where the receiver's file `path` loads from: the TV's own copy, or the
    // network (then kept); the plain path whenever either fails.
    function keptURL(path) {
      if (!keptDb) return Promise.resolve(path);
      const key = keptTree + "/" + path;
      const fetched = () => fetch(path).then((response) => {
        if (!response.ok) throw new Error("fetch " + path);
        return response.blob();
      }).then((blob) => {
        keptCounts.fetched += 1;
        try {
          const write = keptDb.transaction("files", "readwrite");
          write.objectStore("files").put(blob, key);
          write.oncomplete = () => keptFiles.add(path);
        } catch (error) { /* full: fetched again next time */ }
        return objectURL(blob);
      }).catch(() => path);
      // Receiver 83: this tree's copy, else the previous tree's of a file this deploy didn't change.
      const from = keptFiles.has(path) ? key : carried.get(path);
      if (!from) return fetched();
      return new Promise((resolve) => {
        const gone = () => { keptFiles.delete(path); carried.delete(path); resolve(fetched()); };
        try {
          const read = keptDb.transaction("files", "readonly").objectStore("files").get(from);
          read.onsuccess = () => {
            if (!read.result) { gone(); return; }
            keptCounts.read += 1;
            if (from !== key) keptCounts.carried += 1;
            resolve(objectURL(read.result));
          };
          read.onerror = () => resolve(fetched());
        } catch (error) { resolve(fetched()); }
      });
    }

    // Once the preload is done: the previous tree's files this deploy carried move under this tree (receiver 83),
    // then files kept by any other tree go.
    let keptPruned = false;
    function pruneKept() {
      if (!keptDb || keptPruned) return;
      keptPruned = true;
      try {
        const write = keptDb.transaction("files", "readwrite");
        const store = write.objectStore("files");
        const dropOthers = () => {
          const keys = store.getAllKeys();
          keys.onsuccess = () => (keys.result || []).forEach((key) => { if (String(key).indexOf(keptTree + "/") !== 0) store.delete(key); });
        };
        const moving = Array.from(carried.entries());
        let left = moving.length;
        if (!left) { dropOthers(); return; }
        moving.forEach(([path, from]) => {
          const read = store.get(from);
          const next = () => { left -= 1; if (!left) dropOthers(); };
          read.onsuccess = () => {
            if (read.result) { store.put(read.result, keptTree + "/" + path); keptFiles.add(path); }
            carried.delete(path);
            next();
          };
          read.onerror = next;
        });
      } catch (error) { /* next time */ }
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
          read.onsuccess = () => read.result ? resolve(objectURL(read.result)) : reject(new Error("gone"));
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
      // Receiver 83: none of the receiver's own pictures before cricket is selected.
      if ((bundled.has(key) || cached.has(key)) && !mayLoad(key)) { deferredEnsure.add(key); return; }
      if (bundled.has(key)) {
        loading.add(key);
        keptURL("scene-images/" + bundled.get(key)).then((url) => loadPicture(key, url)).catch(ask);
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

    // MARK: The batter's look, whole or not at all (receiver 84, Nov 11 2026)
    //
    // fn6t394j (Android 27431 on the Living Room TV's Chromecast Ultra, receiver 83, a Crimson kit just bought): "It
    // was white at the start and then the legs became red. Then the hands … and then finally the torso … it took like
    // three balls". The phone sends the player's dyed pieces (`kit-…`, the bat's face `stroke-blade-face-bat-…`) one
    // after another and, until the TV holds one, draws the photographed piece (`stroke-…`) in its place (iOS heldKit,
    // Android sendPictures), so the batter turned piece by piece. Now while a new look's pieces come in (one on its
    // way, or one arrived within DRESSING_QUIET_MS) every dyed piece is drawn as its photographed one, the batter in the
    // whites, and the look goes on whole once they stop coming: the next draw, since the phone draws each piece the TV
    // holds dyed. At most DRESSING_LONGEST_MS, so a piece that never comes can't keep the batter white. A piece sent again
    // to the same phone's connection (after the TV let it go) is no new look: the batter stays dressed. After a hello
    // every piece counts again: Android sends its pieces anew on every cast whatever the TV keeps (core CastImageLedger),
    // drawing the photographed one until each `got`.
    const DRESSING_QUIET_MS = 1500;
    // Receiver 87 (hn6ae62a, Android 27433: "Still completely white"): a piece whose parts stopped coming, or a dyed piece
    // that never decodes, held the whites for 15 s. Each now counts only while it moves (a part or a try within
    // DRESSING_STALL_MS), and the whites last at most DRESSING_LONGEST_MS (6 s) whatever comes.
    const DRESSING_LONGEST_MS = 6000;
    const DRESSING_STALL_MS = 2000;
    // Receiver 90 (Nov 11 2026, the owner's final test, Android 27437 on the restarted Ultra: "started in whites, then showed
    // bits of the kit, and was the full kit only after 2-3 balls"; the TV drew 18 frames dyed but for a plain torso, and
    // the whites ran ~15 s): a look's window starts once, at its first piece; a piece within DRESSING_NEW_LOOK_MS of the
    // last is the same look and never starts the 6 s again. And a draw that asks for a dyed piece the TV can't draw, or
    // for dyed and photographed pieces of the batter together, draws the whole batter in the photographed pieces (and the
    // next LOOK_WHITES_MS of draws): never half dressed, whether the window is on or not.
    const DRESSING_NEW_LOOK_MS = 3000;
    const LOOK_WHITES_MS = 400;
    let lookWhitesUntil = -Infinity;
    let drawDyed = null; // this draw's dyed pieces asked for (null outside a draw)
    let drawPlainLook = null; // and the photographed pieces of the batter it asked for (their names: "torso", "gloves")
    function isPlainLookPiece(key) { return /^stroke-(torso|pelvis|near(?!Elbow)[A-Za-z]+|far(?!Elbow)[A-Za-z]+|gloves|blade-face)-\d+x\d+$/.test(key); }
    // Receiver 91 (Nov 11 2026: 2.9.9 iPhones on production 90, the batter's kit drawn in the whites throughout): a look
    // dyes the clothes (torso, pelvis, sleeves, thighs, shins, feet, head), and the forearms and gloves only with pads,
    // the bat's face only with a bat. A 2.9.9 look (iOS "kit-club-blue-torso-…", no gear) dyes the clothes and keeps the
    // photographed forearms, gloves and bat's face: that draw is the whole look, not half dressed. Half dressed is a
    // photographed piece this draw's look itself dyes.
    function plainLookPieceName(key) { const match = /^stroke-(.+)-\d+x\d+$/.exec(key); return match ? match[1] : null; }
    function isGearOnlyPiece(name) { return name === "nearFore" || name === "farFore" || name === "gloves" || name === "blade-face"; }
    function dyesGearPiece(dyed, name) {
      for (const key of dyed) {
        if (name === "blade-face") { if (/^(android-)?stroke-blade-face-bat-./.test(key) || /[.-]bat-/.test(key)) return true; }
        else if (/^(android-)?kit-.*[.-]pads-/.test(key)) return true;
      }
      return false;
    }
    function lookDyesPiece(dyed, name) { return !isGearOnlyPiece(name) || dyesGearPiece(dyed, name); }
    function startsLook(local) { return !dressingOn(local) && local - dressingLast >= DRESSING_NEW_LOOK_MS; }
    const pieceMoved = new Map(); // key -> when a part of it last came (or a draw last asked for it)
    const piecesStalled = new Set(); // given up on until they decode: never the whites again for them
    function stillMoving(set, local) {
      for (const key of set) if (local - (pieceMoved.get(key) || 0) >= DRESSING_STALL_MS) { set.delete(key); piecesStalled.add(key); }
      return set.size > 0;
    }
    const incomingPieces = new Set();
    // Receiver 86: dyed pieces a draw asked for that aren't decoded yet (a re-cast's, loading from the TV's own copy).
    const missingPieces = new Set();
    const piecesHeld = new Set();
    let dressingSince = null, dressingLast = -Infinity, dressingWasOn = false;
    // iOS keys a dyed piece "kit-<look>-<piece>-<size>" and a bat's face "stroke-blade-face-bat-<bat>-<size>"; Android
    // "android-kit-<look>-<piece>" and "android-stroke-blade-face-<bat>" (core CookedKits), drawn at their own size.
    function isDressedPiece(key) { return /^(android-)?kit-./.test(key) || /^(android-)?stroke-blade-face-bat-./.test(key); }
    // The photographed piece a dyed one stands in for: "kit-crimson.pads-navy-nearShin-306x519" and
    // "android-kit-crimson-pads-navy-nearShin" → "stroke-nearShin-306x519"; a bat's face → "stroke-blade-face-928x186".
    const plainPieces = new Map();
    function plainPiece(key) {
      if (plainPieces.has(key)) return plainPieces.get(key);
      let found = null;
      let match = /^stroke-blade-face-bat-.+-(\d+x\d+)$/.exec(key);
      if (match) found = "stroke-blade-face-" + match[1];
      else if ((match = /^kit-.+-([A-Za-z]+)-(\d+x\d+)$/.exec(key))) found = "stroke-" + match[1] + "-" + match[2];
      else {
        // Android's carry no size: the receiver's own photographed piece by its name.
        const face = /^android-stroke-blade-face-bat-/.test(key);
        const piece = face ? null : (/^android-kit-.+-([A-Za-z]+)$/.exec(key) || [])[1];
        const wanted = face ? /^stroke-blade-face-\d+x\d+$/ : piece ? new RegExp("^stroke-" + piece + "-\\d+x\\d+$") : null;
        if (wanted) for (const name of bundled.keys()) if (wanted.test(name)) { found = name; break; }
      }
      if (found || bundled.size) plainPieces.set(key, found);
      return found;
    }
    // The phone declares only the pieces this batter actually wears, per stadium.
    // Once the whole look is decoded, use it even for a late pre-warm pose in
    // photographed whites. Another innings (including bowling) starts afresh.
    let selectedKeys = [], selectedPictures = null;
    function selectStadiumLook(keys) {
      selectedKeys = Array.isArray(keys) && keys.length <= 40
        ? [...new Set(keys.filter((key) => typeof key === "string" && key.length <= 120 && isDressedPiece(key)))] : [];
      selectedPictures = null;
      artEpoch += 1;
      if (staticLayer) { staticLayer.key = null; staticLayer.keys = null; }
      needsRedraw = true;
    }
    function readySelectedLook() {
      if (!selectedPictures && selectedKeys.length && selectedKeys.every((key) => images.has(key))) {
        const next = new Map();
        for (const key of selectedKeys) {
          const photo = plainPiece(key);
          if (!photo) return;
          next.set(photo, key); next.set(key, key);
        }
        selectedPictures = next;
        artEpoch += 1;
      }
    }
    function dressingOn(local) {
      if (dressingSince === null) return false;
      if (local - dressingSince >= DRESSING_LONGEST_MS) return false;
      return stillMoving(incomingPieces, local) || stillMoving(missingPieces, local) || local - dressingLast < DRESSING_QUIET_MS;
    }
    // A dyed piece's first part (`arrived` false) or the piece decoded (true).
    function noteIncomingPiece(key, arrived) {
      if (!isDressedPiece(key)) return;
      const local = performance.now();
      if (!arrived) {
        // Sent again after the TV let it go: no new look.
        if (piecesHeld.has(key)) return;
        if (startsLook(local)) dressingSince = local;
        dressingLast = local;
        incomingPieces.add(key);
        return;
      }
      if (!incomingPieces.delete(key)) return;
      dressingLast = local;
    }
    // Each frame: the swap to the whole look draws at once (the frame on screen drawn again).
    function noteDressing(local) {
      // Receiver 87: pieces that stopped moving are given up on every frame, the whites on or off.
      stillMoving(incomingPieces, local);
      stillMoving(missingPieces, local);
      const onNow = dressingOn(local) || local < lookWhitesUntil;
      if (dressingWasOn && !onNow) { needsRedraw = true; if (staticLayer) { staticLayer.key = null; staticLayer.keys = null; } }
      if (dressingWasOn !== onNow) artEpoch += 1;
      dressingWasOn = onNow;
    }

    function receivePart(message) {
      const key = String(message.k || "");
      if (!key) return;
      if (!uploads.has(key)) noteIncomingPiece(key, false);
      if (isDressedPiece(key)) pieceMoved.set(key, performance.now());
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
        const url = objectURL(blob);
        return loadPicture(key, url, blob).then(() => {
          noteIncomingPiece(key, true);
          if (isDressedPiece(key)) piecesHeld.add(key);
          counters.received += 1;
          cacheImage(key, blob);
          // Receiver 77: a picture the phone sends during the setup (a dyed
          // kit's piece) is warmed as the receiver's own are, not decoded at
          // the stadium's first frame.
          warmDecode(key);
          send({ t: "got", k: key });
        });
      }).catch((error) => { incomingPieces.delete(key); report("image", error); });
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

    // MARK: The batter's kit (receiver 73, Oct 25 2026)
    //
    // Whether the phone's hello named a dyed kit: the masks load before the
    // first ball then; otherwise with the first look a command carries.
    function dressedKit() { return !!preloadKit && preloadKit !== "starter-whites"; }
    function dressedGear() { return Array.from(helloPieces).some((key) => /(?:helmet-|pads-|bat-)/.test(key)); }
    let requestedKitSources = false, requestedGearSources = false;
    function prepareDressingSheet(id) {
      if (dressedKit() || requestedKitSources) maskSheet(id);
      if (dressedGear() || requestedGearSources) gearSheet(id);
    }
    // Read each atlas once during loading. Older Chromecast browsers ignore
    // willReadFrequently; retaining a canvas still makes every new pose read
    // pixels back from the GPU. Keep only its RGBA bytes and release the canvas
    // immediately. The three photographs and six masks remain under 70 MiB.
    function readbackSource(image) {
      const source = document.createElement("canvas");
      source.width = image.naturalWidth || image.width;
      source.height = image.naturalHeight || image.height;
      try {
        const c = source.getContext("2d", { willReadFrequently: true });
        c.drawImage(image, 0, 0);
        const pixels = c.getImageData(0, 0, source.width, source.height);
        return { width: source.width, height: source.height, data: pixels.data };
      } finally { zeroCanvas(source); }
    }
    function releasePixels(source) {
      if (source) { source.data = null; source.width = 0; source.height = 0; }
    }
    const dressingSheets = new Map();
    function dressingSheet(id) {
      if (!dressingSheets.has(id)) dressingSheets.set(id, readbackSource(sheets.get(id).image));
      return dressingSheets.get(id);
    }
    //
    // The bowler's-end inset's batter in the batting player's kit and grip
    // (core.readLook): each frame dyed once per look from its atlas and its
    // masks (kit-masks-bowler-end-N, the picture atlas's twin: red the shirt
    // and trousers, green the trim, blue the grip) by core.dyeFrame, as the
    // phones dye theirs, and kept for the newest MAX_DRESSED frames. The
    // masks load with the atlases when the hello names a dyed kit, else with
    // the first look; until they are in (or if they won't load) the frame is
    // drawn in the whites, as every receiver did before.
    const dressed = new Map();
    const MAX_DRESSED = 96;
    const maskSheets = new Map();
    function maskSheet(id) {
      const known = maskSheets.get(id);
      if (known) return known.image;
      const sheet = sheets.get(id);
      if (!sheet) return null;
      const entry = { image: null, failed: false };
      maskSheets.set(id, entry);
      const file = sheet.file.replace(/^atlas-bowler-end-/, "kit-masks-bowler-end-");
      keptURL("scene-images/" + file).then((url) => loadImage(url)).then((image) => {
        if ((image.naturalWidth || image.width) !== sheet.width || (image.naturalHeight || image.height) !== sheet.height) {
          throw new Error("kit masks " + file + " are " + (image.naturalWidth || image.width) + "x" + (image.naturalHeight || image.height));
        }
        if (!released && maskSheets.get(id) === entry) { dressingSheet(id); entry.image = readbackSource(image); }
      }).catch((error) => { entry.failed = true; report("kit", error); });
      return null;
    }
    // The gear's masks (receiver 81): gear-masks-bowler-end-N, loaded as the kit's are, the first time a frame wears gear.
    const gearSheets = new Map();
    function gearSheet(id) {
      const known = gearSheets.get(id);
      if (known) return known.image;
      const sheet = sheets.get(id);
      if (!sheet) return null;
      const entry = { image: null, failed: false };
      gearSheets.set(id, entry);
      const file = sheet.file.replace(/^atlas-bowler-end-/, "gear-masks-bowler-end-");
      keptURL("scene-images/" + file).then((url) => loadImage(url)).then((image) => {
        if ((image.naturalWidth || image.width) !== sheet.width || (image.naturalHeight || image.height) !== sheet.height) {
          throw new Error("gear masks " + file + " are " + (image.naturalWidth || image.width) + "x" + (image.naturalHeight || image.height));
        }
        if (!released && gearSheets.get(id) === entry) { dressingSheet(id); entry.image = readbackSource(image); }
      }).catch((error) => { entry.failed = true; report("gear", error); });
      return null;
    }
    function dress(drawn, wantedLook, wantedGear) {
      if ((wantedLook && !requestedKitSources) || (wantedGear && !requestedGearSources)) {
        requestedKitSources = requestedKitSources || !!wantedLook;
        requestedGearSources = requestedGearSources || !!wantedGear;
        // Older hellos omit the coming look. Once its first pose arrives, load
        // every source so a later stroke does not decode another atlas mid-ball.
        sheets.forEach((sheet, id) => { if (sheet.image) prepareDressingSheet(id); });
      }
      // What can be worn now: the look once its masks are in, the gear once its are (each drawn as soon as it can be).
      const cut = drawn.cut, sheet = sheets.get(cut.atlas);
      const mask = wantedLook ? maskSheet(cut.atlas) : null;
      const gearMask = wantedGear ? gearSheet(cut.atlas) : null;
      const look = mask ? wantedLook : "", gear = gearMask ? wantedGear : "";
      if ((!look && !gear) || !sheet || !sheet.image) return null;
      const id = drawn.key + "|" + look + (gear ? "|" + gear : "");
      let made = dressed.get(id);
      if (made) {
        dressed.delete(id);
        dressed.set(id, made);
        return { image: made, size: drawn.size, key: id };
      }
      try {
        const started = performance.now();
        made = document.createElement("canvas");
        made.width = cut.width;
        made.height = cut.height;
        // Crop the retained RGBA bytes without any canvas pixel reads. This
        // also works on older TV browsers that ignore context readback hints.
        // The stadium and its layers retain their existing drawing settings.
        const c = made.getContext("2d", { willReadFrequently: true });
        const pixels = c.createImageData(cut.width, cut.height);
        const shares = mask ? core.copyAtlasFrame(mask, cut, new Uint8ClampedArray(pixels.data.length)) : null;
        const gearShares = gearMask ? core.copyAtlasFrame(gearMask, cut, new Uint8ClampedArray(pixels.data.length)) : null;
        core.copyAtlasFrame(dressingSheet(cut.atlas), cut, pixels.data);
        const readAt = performance.now();
        // The tiny CPU kernel avoids long JS pixel loops on older TV browsers.
        // Unsupported/blocked WebAssembly keeps the identical JS recipe. The
        // Creator kit (its polish, and the helmet's stripes, which need the
        // frame's width) is always the JS recipe's: the kernel says no to it.
        const fast = window.RallycadeDye && window.RallycadeDye.dyeFrame(pixels.data, shares, look || null, gearShares, gearShares ? gear : null);
        if (!fast) core.dyeFrame(pixels.data, shares, look || null, gearShares, gearShares ? gear : null, cut.width);
        const dyedAt = performance.now();
        c.putImageData(pixels, 0, 0);
        counters.dressMax = Math.max(counters.dressMax, performance.now() - started);
        counters.dressReadMax = Math.max(counters.dressReadMax, readAt - started);
        counters.dressDyeMax = Math.max(counters.dressDyeMax, dyedAt - readAt);
        counters.dressed += 1;
      } catch (error) {
        report("kit", error);
        return null;
      }
      dressed.set(id, made);
      while (dressed.size > MAX_DRESSED) {
        const oldest = dressed.keys().next().value;
        const gone = dressed.get(oldest);
        dressed.delete(oldest);
        try { gone.width = 0; gone.height = 0; } catch (error) { /* gone */ }
      }
      return { image: made, size: drawn.size, key: id };
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
        // Receiver 105: the frame's first command, an opaque photo that doesn't reach every edge (the bowled hold's camera
        // pushed in on the stumps, 11 points short of the foot: Android 27527's TV drew the whole photo on its canvas
        // every draw of the hold, ~2 ms a draw at the Mac's speed, ~5 ms at a Chromecast's). Nothing is under it, so its
        // GPU layer, placed as it is, shows what the canvas showed: the photo, and the stage's own colour past its edge.
        else if (index === 0 && tune.edge && right > left && bottom > top) found = index;
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
        entry = { element, ready: false, transform: "", session: layerSession, shownIn: -1 };
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
      entry.shownIn = layerSession;
      entry.shownAt = performance.now();
      backdropTransform = transform;
      return true;
    }

    function hideBackdrops(except) {
      backdropLayers.forEach((entry, key) => { if (key !== except) entry.element.style.opacity = "0"; });
      if (except == null) backdropKey = null;
    }

    // MARK: Photo layers the TV lets go (receiver 112, Nov 27 2026)
    //
    // Traced on the Living Room TV's Ultra while it drew the AA app's recorded stream: a memory-pressure notice every 5 s
    // (V8.MemoryPressureNotification level 1, each followed by a 28-40 ms garbage collection to give memory back), and
    // now and then a critical one (level 2): the TV emptied its picture caches and the stadium decoded its pictures again
    // on the page's thread, 65 in 12 s at 10.6 ms each (up to 51 ms), 319 a minute, each a hitch. The page held five photo
    // layers: stadium-ground and field-real-outfield (what the app draws), and stadium-backdrop, field-outfield and a
    // phone's 1280 x 720 photo, made for earlier casts and never shown again: each a 1672 x 941 GPU texture and its decoded
    // copy, ~12 MB, for the page's life (a page lives all evening, across phones, grounds and games). Now a layer goes
    // (its element and its texture with it; made again if a frame draws it) when its picture has gone, or when it hasn't
    // been shown since the phone's hello (a new cast, a reconnect) and the stadium has been on LAYER_GRACE_MS since. A
    // layer this cast has shown stays, as before: the batting view's and the field view's photos swap every ball.
    // `evict: 0` (a bench switch) keeps them all, as receiver 111 did; `grace: <ms>` (benches) waits that long instead.
    // `stats.layers` counts the layers held.
    const LAYER_GRACE_MS = 120000;
    let layerSession = 0, sessionOnMs = 0, lastLayerCheck = 0;
    function evictLayer(key, entry) {
      if (layerWarming && layerWarming.key === key) layerWarming = null;
      try { entry.element.removeAttribute("src"); } catch (error) { /* gone */ }
      if (entry.element.parentNode) entry.element.parentNode.removeChild(entry.element);
      backdropLayers.delete(key);
    }
    function evictLayers(local) {
      if (!tune.evict || !on) return;
      if (lastLayerCheck) sessionOnMs += Math.min(1000, local - lastLayerCheck);
      lastLayerCheck = local;
      for (const [key, entry] of Array.from(backdropLayers)) {
        if (key === backdropKey) continue;
        const gone = !images.has(key);
        const stale = entry.shownIn !== layerSession && sessionOnMs >= (Number(tune.grace) > 0 ? Number(tune.grace) : LAYER_GRACE_MS);
        if (gone || stale) evictLayer(key, entry);
      }
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
    // Receiver 77: `early` 0 rehearses only once the whole preload is done and
    // `own` 0 always rehearses off screen, as receivers 65-76 did.
    // Receiver 105: `live` 0 draws a standing batter's pieces every draw (no liveLayer), `edge` 0 draws on the canvas a
    // first photo that doesn't reach every edge (the bowled hold's pushed-in camera), as receiver 104 did.
    // `warm` (receiver 111): a cold stadium held under the phone's picture and the rehearsal resumed after a cold one;
    // `warm: 0` draws as receiver 110 did.
    // Receiver 112: `runs: 0` draws a batter whose hands follow the player's every piece every draw (no liveRuns), as
    // receiver 111 did. `layers: ...` is taken; `evict: 0` keeps every photo's GPU layer for the page's life (receiver 111).
    const TUNED = Object.freeze({ blur: "shadow", layers: "bounded", cover: "clip", bitmaps: 0, shade: "thirds", blend: 1, cache: 1, photo: "layer", opaque: 0,
      match: 1, dirty: 1, early: 1, own: 1, live: 1, edge: 1, warm: 1, runs: 1, evict: 1, grace: 0, cold: 1 });
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
        zeroCanvas(layer);
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
        if (scratches.size >= 8) { scratches.forEach(zeroCanvas); scratches.clear(); }
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
      if (!rehearsing && selectedPictures && selectedPictures.has(key)) {
        const chosen = selectedPictures.get(key), image = images.get(chosen);
        if (image) return drawable(chosen, image, sizes.get(chosen));
        selectedPictures = null;
      }
      // Receiver 90: what this draw asks of the batter.
      if (drawDyed) { if (isDressedPiece(key)) drawDyed.add(key); else if (isPlainLookPiece(key)) drawPlainLook.add(plainLookPieceName(key)); }
      // Receiver 86: a dyed piece not decoded yet is a look still coming in: the whites until it is (and the rest).
      if (isDressedPiece(key) && !images.has(key) && !missingPieces.has(key) && !piecesStalled.has(key)) {
        const local = performance.now();
        if (startsLook(local)) dressingSince = local;
        dressingLast = local;
        missingPieces.add(key);
        pieceMoved.set(key, local);
        dressingWasOn = true;
        artEpoch += 1;
        // Fetched as any missing picture is: from the TV's own copy, else asked of the phone.
        ensure(key);
      }
      // Receiver 84: a new look's pieces still coming in: the batter in the photographed pieces, never half dressed.
      if (dressingWasOn && isDressedPiece(key)) {
        const plain = plainPiece(key);
        if (plain && (images.has(plain) || bundled.has(plain) || cutOf(plain))) key = plain;
      }
      const image = images.get(key);
      if (image) return drawable(key, image, sizes.get(key));
      // A rehearsal draws what is here and asks for nothing.
      if (rehearsing) return null;
      ensure(key);
      counters.missing += 1;
      lastMissingAt = performance.now();
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
      // Receiver 113: decoded and on the GPU from here on (coldSources).
      hotSources.add(drawn.image);
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
        let drawn = pictureFor(op[3]);
        if (!drawn) return;
        // The bowler's-end batter in his kit (receiver 73): his frame dyed once for the look.
        if ((op[7] || op[8]) && drawn.cut) drawn = dress(drawn, op[7] || "", op[8] || "") || drawn;
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
      if (!rehearsing) { drawDyed = new Set(); drawPlainLook = new Set(); }
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
        live: batter === undefined ? live.current : batter, cacheLive: !rehearsing }, 0, drawn);
      if (tune.shade === "canvas") drawShade();
      if (rehearsing) return;
      // Receiver 90: a dyed piece it couldn't draw, or dyed and photographed pieces together: the whole batter in the
      // photographed pieces, drawn again at once.
      if (drawDyed && drawDyed.size) {
        // Receiver 91: a photographed piece only when this look dyes it (a 2.9.9 look's forearms, gloves and bat's face aren't).
        let half = false;
        for (const name of drawPlainLook) if (lookDyesPiece(drawDyed, name)) { half = true; break; }
        if (!half) for (const key of drawDyed) if (!images.has(key)) { half = true; break; }
        if (half) {
          if (!dressingWasOn) { dressingWasOn = true; artEpoch += 1; needsRedraw = true; if (staticLayer) { staticLayer.key = null; staticLayer.keys = null; } }
          lookWhitesUntil = performance.now() + LOOK_WHITES_MS;
        }
      }
      drawDyed = null; drawPlainLook = null;
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
    // Receiver 114: a command's padded bounds, kept with the array (received commands are never written to, and the
    // same command in the next frame is the same array: core.shareOps). A blended frame's own arrays are rewritten
    // every draw: its commands the same in both frames it blends between (`same`) use their source's.
    const paddedBoxes = new WeakMap();
    function paddedBox(op) {
      let padded = paddedBoxes.get(op);
      if (padded !== undefined) return padded;
      const box = core.opBounds(op, pictureSize);
      padded = box ? [box[0] - 2, box[1] - 2, box[2] + 2, box[3] + 2] : null;
      // A picture not here yet has no size: worked out again once it is.
      if (padded || op[0] !== "i") paddedBoxes.set(op, padded);
      return padded;
    }
    function boxesOf(frame, from, same) {
      const boxes = new Array(frame.o.length);
      for (let index = from; index < frame.o.length; index += 1) {
        const op = frame.o[index];
        if (op[0] === "L" || op[0] === "B" || op[0] === "l") break;
        const source = same ? same[index] : op;
        let box;
        if (source) box = paddedBox(source);
        else { const raw = core.opBounds(op, pictureSize); box = raw ? [raw[0] - 2, raw[1] - 2, raw[2] + 2, raw[3] + 2] : null; }
        boxes[index] = box;
        if (!box) break;
      }
      return boxes;
    }
    function splitStatic(frame, from, previous, keys, boxes) {
      const statics = [];
      const changed = [];
      for (let index = from; index < frame.o.length; index += 1) {
        const op = frame.o[index];
        if (op[0] === "L" || op[0] === "B" || op[0] === "l") break;
        const padded = boxes[index];
        if (!padded) break;
        if (staticable(op) && previous && previous.has(keys[index]) && !changed.some((other) => overlaps(other, padded))) statics.push(index);
        else changed.push(padded);
      }
      return statics;
    }
    // Where the layer's commands are in this frame, or null when it doesn't
    // fit: each must be there in the layer's order, before anything without
    // bounds, with no other command before it overlapping it (that one
    // would be drawn above it now).
    function layerFits(frame, from, keys, boxes) {
      const want = staticLayer.keys;
      if (!want || !want.length) return null;
      const at = [];
      const others = [];
      let next = 0;
      for (let index = from; index < frame.o.length && next < want.length; index += 1) {
        const op = frame.o[index];
        if (op[0] === "L" || op[0] === "B" || op[0] === "l") return null;
        const padded = boxes[index];
        if (!padded) return null;
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
      // Receiver 112 (the Living Room TV's Ultra profiled while it drew: `opKey` 3.2% of its page's thread, every
      // command of every blended draw written out as text): a blended frame's command is keyed from the two frames it
      // is blended between, whose keys are made once each. The same in both, it is that command exactly (each number
      // x + (x - x) u); different, it is on the move and has no key (never in the layer). A scratch frame without them
      // (a test's own) is written out as before.
      const a = fresh ? frame.__from : null, b = fresh ? frame.__to : null, pairs = fresh ? frame.__pairs : null;
      const blendedFrom = !!(a && b && a.o.length === frame.o.length);
      // Receiver 114: what each command's bounds come from (its own array; a blended frame's, the source command the
      // same in both frames, else worked out from the draw's numbers).
      const same = fresh ? new Array(frame.o.length).fill(null) : null;
      for (let index = from; index < frame.o.length; index += 1) {
        const op = frame.o[index];
        if (op[0] !== "f" && op[0] !== "s" && op[0] !== "i") continue;
        if (blendedFrom) {
          const partner = pairs ? pairs[index] : index;
          const opA = a.o[index], opB = partner >= 0 ? b.o[partner] : null;
          const keyA = opKey(opA, false);
          // Receiver 114: the same array in both (core.shareOps) is the same command without comparing their text.
          if (opB && opB !== opA && opKey(opB, false) !== keyA) continue;
          keys[index] = keyA;
          same[index] = opA;
        } else {
          keys[index] = opKey(op, fresh);
        }
        keysNow.add(keys[index]);
      }
      const boxes = boxesOf(frame, from, same);
      const statics = splitStatic(frame, from, lastStaticKeys, keys, boxes);
      lastStaticKeys = keysNow;
      const candidateKey = statics.length >= 2 ? statics.map((index) => keys[index]).join("|") : null;
      const steady = candidateKey !== null && candidateKey === lastCandidateKey;
      lastCandidateKey = candidateKey;
      const sized = staticLayer.canvas && staticLayer.canvas.width === canvas.width && staticLayer.canvas.height === canvas.height;
      let used = sized ? layerFits(frame, from, keys, boxes) : null;
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
      dropLiveLayer();
    }

    // MARK: Live batter layer (receiver 105, Nov 20 2026)
    //
    // The owner's casts since the cricket-realism tester builds (Android 27524 on the Ultra, iOS 368 on an onn): the TV's
    // frame loop every 45 ms and its batting view's draws about 30% dearer than main's. Most of that is the batter: his
    // guard is the realism stance, his pieces drawn turned, and a software canvas draws a turned picture at about twice
    // an upright one's cost; ~90% of the live batters a phone sends are the one before again (he stands still through
    // each run-up and between balls). A batter that comes round a second time unchanged is drawn once into a canvas of
    // his own size and copied from there (one drawImage, pixel for pixel, for his ~20 pieces and shadows) until he moves,
    // a picture arrives or the look changes (`artEpoch`). Only plain pieces and shadows (no layer, blur or blend); his
    // place in the frame is the slot's, so what is drawn under and over him is unchanged.
    const liveLayer = { canvas: null, key: null, epoch: -1, s: 0, width: 0, height: 0, rect: null, last: null, lastEpoch: -1, lastBatter: null,
      dyed: null, plain: null, built: 0, hits: 0 };
    const liveKeys = new WeakMap();
    // Receiver 112: from his commands' own keys (liveOpKeys), each made once a batter.
    function liveKey(batter) {
      let key = liveKeys.get(batter);
      if (key !== undefined) return key;
      key = null;
      const keys = liveOpKeys(batter);
      if (keys && keys.every((one) => one !== null)) key = keys.context + "\u0001" + keys.join("\u0001");
      liveKeys.set(batter, key);
      return key;
    }
    // Each of a batter's commands as a key (null for one that isn't a plain piece or shadow: a blend, a blur), with his
    // filters' and clips' own (`context`); null for a batter with anything else (a layer, text), drawn as he is.
    const liveOpKeyCache = new WeakMap();
    function liveOpKeys(batter) {
      let keys = liveOpKeyCache.get(batter);
      if (keys !== undefined) return keys;
      keys = batter.o.length ? new Array(batter.o.length) : null;
      for (let index = 0; keys && index < batter.o.length; index += 1) {
        const op = batter.o[index], kind = op[0];
        if (kind !== "f" && kind !== "s" && kind !== "i") { keys = null; break; }
        const plain = !(op[2] && op[2] !== "source-over") && !(filtersOf(batter, kind === "f" ? op[7] : kind === "s" ? op[9] : op[5]).blur > 0);
        // Receiver 114: written out once a command array (his unchanged pieces are the live batter before's arrays).
        keys[index] = plain ? opKey(op, false) : null;
      }
      if (keys) keys.context = JSON.stringify([batter.fl, batter.cl]);
      liveOpKeyCache.set(batter, keys);
      return keys;
    }
    // His pixels on the TV's canvas (`scale` canvas pixels a stage point), with room for his pieces' edges.
    function liveRect(batter, scale) {
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (const op of batter.o) {
        const box = core.opBounds(op, pictureSize);
        if (!box) return null;
        left = Math.min(left, box[0]); top = Math.min(top, box[1]); right = Math.max(right, box[2]); bottom = Math.max(bottom, box[3]);
      }
      const l = Math.max(0, Math.floor(left * scale - 2)), t = Math.max(0, Math.floor(top * scale - 2));
      const r = Math.min(canvas.width, Math.ceil(right * scale + 2)), b = Math.min(canvas.height, Math.ceil(bottom * scale + 2));
      return r > l && b > t ? [l, t, r, b] : null;
    }
    // A context drawing `dx`, `dy` canvas pixels up and to the left: the commands' own transforms, in a canvas of the
    // batter's size whose corner is his rect's.
    function shiftedContext(c, dx, dy) {
      return new Proxy(c, {
        get(target, name) {
          if (name === "setTransform") return (a, b, cc, d, e, f) => target.setTransform(a, b, cc, d, e - dx, f - dy);
          const value = target[name];
          return typeof value === "function" ? value.bind(target) : value;
        },
        set(target, name, value) { target[name] = value; return true; }
      });
    }
    function buildLiveLayer(batter, surface, rect, key) {
      const w = rect[2] - rect[0], h = rect[3] - rect[1];
      if (!liveLayer.canvas) liveLayer.canvas = document.createElement("canvas");
      const layer = liveLayer.canvas;
      // Grown, not shrunk: a resized canvas is a new allocation.
      if (layer.width < w || layer.height < h) { layer.width = Math.max(layer.width, w); layer.height = Math.max(layer.height, h); }
      const c = layer.getContext("2d");
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1;
      c.globalCompositeOperation = "source-over";
      c.clearRect(0, 0, layer.width, layer.height);
      c.imageSmoothingQuality = smoothing;
      const missing = counters.missing, epoch = artEpoch, dyed = drawDyed, plain = drawPlainLook;
      drawDyed = new Set(); drawPlainLook = new Set();
      paint(shiftedContext(c, rect[0], rect[1]), batter, 0, Object.assign({}, surface, { live: null, cacheLive: false }), 0, null);
      const built = { dyed: drawDyed, plain: drawPlainLook };
      drawDyed = dyed; drawPlainLook = plain;
      // A piece missing or the look changing as he was drawn: not kept (drawn in place, as before).
      if (counters.missing !== missing || artEpoch !== epoch || dressingWasOn) { liveLayer.key = null; return false; }
      Object.assign(liveLayer, { key, epoch, s: surface.s, width: canvas.width, height: canvas.height, rect, dyed: built.dyed, plain: built.plain });
      liveLayer.built += 1;
      return true;
    }
    function drawLiveLayer(c, batter, surface, bounds) {
      if (!tune.cache || !tune.live || dressingWasOn) { liveLayer.last = null; return false; }
      const key = liveKey(batter);
      if (key === null) { liveLayer.last = null; return false; }
      const scale = surface.s;
      const kept = liveLayer.canvas && liveLayer.key === key && liveLayer.epoch === artEpoch && liveLayer.s === scale
        && liveLayer.width === canvas.width && liveLayer.height === canvas.height;
      if (kept) {
        liveLayer.hits += 1;
      } else {
        // Drawn as he is until the same batter comes round again: a batter on the move is never built.
        // Receiver 112: again in the phone's next live batter (he stands as he stood), not the same batter drawn a second
        // time between two of them: a batter whose hands follow the player's is new in every one, and a layer built on his
        // second draw was a whole extra draw of him, copied once at most (liveRuns copies his still pieces instead).
        if (tune.runs && liveLayer.lastBatter === batter) return false;
        const again = liveLayer.last === key && liveLayer.lastEpoch === artEpoch;
        liveLayer.last = key;
        liveLayer.lastEpoch = artEpoch;
        liveLayer.lastBatter = batter;
        if (!again) return false;
        const rect = liveRect(batter, scale);
        if (!rect || !buildLiveLayer(batter, surface, rect, key)) return false;
      }
      const r = liveLayer.rect, w = r[2] - r[0], h = r[3] - r[1];
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1;
      c.globalCompositeOperation = "source-over";
      c.drawImage(liveLayer.canvas, 0, 0, w, h, r[0], r[1], w, h);
      c.restore();
      if (bounds) grow(bounds, [r[0] / scale, r[1] / scale, r[2] / scale, r[3] / scale], scale, 0);
      if (drawDyed) liveLayer.dyed.forEach((k) => drawDyed.add(k));
      if (drawPlainLook) liveLayer.plain.forEach((k) => drawPlainLook.add(k));
      return true;
    }
    function dropLiveLayer() {
      liveLayer.key = null;
      liveLayer.last = null;
      liveLayer.lastBatter = null;
      liveLayer.rect = null;
      if (liveLayer.canvas) { try { liveLayer.canvas.width = 0; liveLayer.canvas.height = 0; } catch (error) { /* gone */ } liveLayer.canvas = null; }
      dropLiveRuns();
    }

    // MARK: The live batter's still pieces (receiver 112, Nov 27 2026)
    //
    // The owner on tester build AA (Android 27579 and iOS 411 on the Living Room TV's Chromecast Ultra: "Still lagging a
    // bit in pickleball", "Lagging in cricket as well", "the frames are not smooth. It's missing frames in between"): in
    // play the TV drew 21-23 a second, each draw 10-11 ms, against 24-26 and 6.5-8 ms on builds up to L (Nov 24). Since
    // build R (Nov 25) the drawn batter's hands follow the player's own (HandsFollow, StadiumHandsFollow): a camera's pose
    // wobbles every frame, so his arms, gloves and willow move a little in every live batter, no two the same, and his
    // layer (liveLayer, receiver 105) went from 13-36 copies every 2 s to 0-2 (`batter` in stats): his twenty pieces,
    // most of them turned, drawn again every draw. His legs, pelvis, torso and head don't move with his hands. So each run
    // of his commands that is the same as in the batter before (at least two, a picture among them) is drawn once into a
    // canvas of its own and copied from there while it stays the same; what moved is drawn in place between those runs,
    // in his own order, so what is under and over each piece is unchanged. A run is only made once it has held from one
    // batter to the next (a swing changes every piece: nothing is made). `batterRuns` in stats counts the copies.
    // `runs: 0` (a bench switch) draws him as receiver 111 did. receiver-live-runs.test.cjs: the same pixels as his
    // pieces drawn again (the layer's tolerance), and the draws' work against a budget.
    const MAX_RUN_LAYERS = 4;
    const liveRuns = { layers: new Map(), batter: null, keys: null, before: null, beforeEpoch: -1, epoch: -1, hits: 0, built: 0 };
    function dropLiveRuns() {
      liveRuns.layers.forEach((layer) => zeroCanvas(layer.canvas));
      liveRuns.layers.clear();
      liveRuns.batter = null;
      liveRuns.keys = null;
      liveRuns.before = null;
    }
    // The runs of `keys` the same as `before` (index ranges [from, to)): two commands at least, a picture among them.
    function stillRuns(batter, keys, before) {
      const runs = [];
      let start = -1;
      for (let index = 0; index <= keys.length; index += 1) {
        const same = index < keys.length && keys[index] !== null && keys[index] === before[index];
        if (same && start < 0) start = index;
        if (!same && start >= 0) {
          if (index - start >= 2 && batter.o.slice(start, index).some((op) => op[0] === "i")) runs.push([start, index]);
          start = -1;
        }
      }
      return runs;
    }
    function runLayer(batter, keys, from, to, surface) {
      const key = surface.s + "|" + canvas.width + "x" + canvas.height + "|" + artEpoch + "|" + keys.context + "\u0002" + keys.slice(from, to).join("\u0001");
      const kept = liveRuns.layers.get(key);
      if (kept) {
        // The most recently used last (the oldest goes first).
        liveRuns.layers.delete(key);
        liveRuns.layers.set(key, kept);
        liveRuns.hits += 1;
        return kept;
      }
      const part = Object.assign({}, batter, { o: batter.o.slice(from, to) });
      const rect = liveRect(part, surface.s);
      if (!rect) return null;
      let reused = null;
      if (liveRuns.layers.size >= MAX_RUN_LAYERS) {
        const oldest = liveRuns.layers.keys().next().value;
        reused = liveRuns.layers.get(oldest).canvas;
        liveRuns.layers.delete(oldest);
      }
      const layer = reused || document.createElement("canvas");
      const w = rect[2] - rect[0], h = rect[3] - rect[1];
      // Grown, not shrunk: a resized canvas is a new allocation.
      if (layer.width < w || layer.height < h) { layer.width = Math.max(layer.width, w); layer.height = Math.max(layer.height, h); }
      const c = layer.getContext("2d");
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1;
      c.globalCompositeOperation = "source-over";
      c.clearRect(0, 0, layer.width, layer.height);
      c.imageSmoothingQuality = smoothing;
      const missing = counters.missing, epoch = artEpoch, dyed = drawDyed, plain = drawPlainLook;
      drawDyed = new Set(); drawPlainLook = new Set();
      paint(shiftedContext(c, rect[0], rect[1]), part, 0, Object.assign({}, surface, { live: null, cacheLive: false }), 0, null);
      const built = { canvas: layer, rect, dyed: drawDyed, plain: drawPlainLook };
      drawDyed = dyed; drawPlainLook = plain;
      // A piece missing or the look changing as it was drawn: not kept (drawn in place).
      if (counters.missing !== missing || artEpoch !== epoch || dressingWasOn) { zeroCanvas(layer); return null; }
      liveRuns.layers.set(key, built);
      liveRuns.built += 1;
      return built;
    }
    // Draws `batter` with his still runs copied; false when there are none (he is drawn as before).
    function drawLiveRuns(c, batter, surface, bounds, depth) {
      if (!tune.cache || !tune.live || !tune.runs || dressingWasOn) { liveRuns.batter = null; return false; }
      const keys = liveOpKeys(batter);
      // A new batter: the one before is what his runs are measured against (a batter drawn again keeps his).
      if (liveRuns.batter !== batter) {
        liveRuns.before = liveRuns.keys;
        liveRuns.beforeEpoch = liveRuns.epoch;
        liveRuns.batter = batter;
        liveRuns.keys = keys;
        liveRuns.epoch = artEpoch;
      }
      const before = liveRuns.before;
      if (!keys || !before || before.length !== keys.length || before.context !== keys.context || liveRuns.beforeEpoch !== artEpoch) return false;
      const runs = stillRuns(batter, keys, before);
      if (!runs.length) return false;
      const live = Object.assign({}, surface, { live: null });
      const inPlace = (from, to) => { if (to > from) paint(c, Object.assign({}, batter, { o: batter.o.slice(from, to) }), 0, live, depth, bounds); };
      let at = 0;
      for (const [from, to] of runs) {
        inPlace(at, from);
        const layer = runLayer(batter, keys, from, to, surface);
        if (!layer) { inPlace(from, to); at = to; continue; }
        const r = layer.rect, w = r[2] - r[0], h = r[3] - r[1];
        c.save();
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.globalAlpha = 1;
        c.globalCompositeOperation = "source-over";
        c.drawImage(layer.canvas, 0, 0, w, h, r[0], r[1], w, h);
        c.restore();
        if (bounds) grow(bounds, [r[0] / surface.s, r[1] / surface.s, r[2] / surface.s, r[3] / surface.s], surface.s, 0);
        if (drawDyed) layer.dyed.forEach((k) => drawDyed.add(k));
        if (drawPlainLook) layer.plain.forEach((k) => drawPlainLook.add(k));
        at = to;
      }
      inPlace(at, batter.o.length);
      return true;
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
              // Receiver 105: a batter standing as he stood is copied from his own layer (liveLayer).
              if (surface.cacheLive && stack.length === 1 && drawLiveLayer(c, batter, surface, top.bounds)) break;
              // Receiver 112: his still pieces copied, what moved drawn in place (liveRuns).
              if (surface.cacheLive && stack.length === 1 && drawLiveRuns(c, batter, surface, top.bounds, base)) break;
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
    // A challenge chip's tones (shared/challenges/reference.mjs chip()); anything else is drawn as level (neutral).
    const CHALLENGE_TONES = ["start", "ahead", "behind", "level", "target", "passed", "chased"];
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
      // Can you beat my score? (docs/design/CHALLENGES.md "TV message"): the phone's optional `challenge` {name, setter,
      // text, suffix?, tone} as "{name}'s {setter} · {text}" under the scorebug (shared/challenges/copy.json tv.chip),
      // coloured by tone. Older phones send none, and half a chip is none: nothing shows.
      const challenge = h.challenge && typeof h.challenge.name === "string" && h.challenge.name && typeof h.challenge.text === "string"
        && (typeof h.challenge.setter === "string" || typeof h.challenge.setter === "number") ? h.challenge : null;
      show("hud-challenge", !!challenge);
      if (challenge) {
        const chip = el("hud-challenge");
        const tone = "hud-challenge tone-" + (CHALLENGE_TONES.indexOf(challenge.tone) >= 0 ? challenge.tone : "level");
        if (chip && chip.className !== tone) chip.className = tone;
        setText("hud-challenge-initial", (Array.from(challenge.name)[0] || "").toUpperCase());
        setText("hud-challenge-setter", challenge.name + "'s " + challenge.setter);
        setText("hud-challenge-text", challenge.text);
        const suffix = typeof challenge.suffix === "string" ? challenge.suffix : "";
        show("hud-challenge-suffix", !!suffix);
        setText("hud-challenge-suffix", suffix);
      }
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
      if (!on) {
        if (rehearsal.wanted) rehearse(performance.now());
        // Receiver 77: the rest of the preload once the rehearsal is done.
        else if (preloadQueue.length && preloading < 3) pumpSome();
        return;
      }
      const began = performance.now();
      frameStep(began);
      counters.js += performance.now() - began;
    }

    function frameStep(began) {
      const local = began;
      readySelectedLook();
      noteDressing(local);
      // Shown once whole with its photo on its layer for a frame, or at
      // COVER_MS whatever.
      // Receiver 70 (the owner, Oct 23 2026: "getting the tv ready screen takes a long time and the circle keeps on
      // restarting"): not held for steady. Under the picture, the stadium all but transparent over it, the Ultra drew
      // ~20 a second, hitching every second or two, so the ring restarted and the steady verdict came at 20 (plateau)
      // after 3-4 s or past the phone's 8 s cap; the stadium uncovered draws 28-30. Steadiness is now watched on the
      // stadium itself while the phone holds its first ball (CastSceneStreamer.steadyLimit).
      // Receiver 111: a stadium that came on cold stays under the picture until its drawing is warm too (COVER_MS at most,
      // as ever), and is watched for steady from the moment it shows: drawn under the picture it hitched (receiver 70).
      if (root.dataset.warming && (local >= coverUntil
        || (wholeSent && (!framePhoto || (!photoPending && layerShownAt && local - layerShownAt >= 30))
          && (document.body.dataset.card !== "picture" || (layersWarm() && (!coldOn || drawingWarm())))))) {
        const cold = coldOn;
        uncover();
        if (cold && wholeSent && !steadyWatch.verdict) steadyWatch.start(local);
      }
      if (root.dataset.warming) { warmLayers(local); showWarming(local); }
      if (lastLoop) counters.gaps.push(local - lastLoop);
      lastLoop = local;
      const phoneNow = clock.phoneNow(local);
      if (phoneNow == null) return;
      const result = timeline.at(phoneNow);
      // A frame already on screen is drawn again only while blending.
      let drew = false;
      // Receiver 113: a frame with cold pictures may wait a frame or two while they are warmed (holdsForCold).
      if (result && ((result.blended && tune.blend) || result.stamp !== lastStamp || needsRedraw) && !holdsForCold(result.frame, local)) {
        const missingBefore = counters.missing;
        drawFrame(result.frame);
        noteWhole(missingBefore);
        shownFrame = result.frame;
        drew = true;
        stadiumDraws += 1;
        needsRedraw = false;
        if (result.blended) counters.blended += 1;
        if (result.partly) counters.partly += 1;
        lastStamp = result.stamp;
        // Receiver 111: not under a cold stadium's cover (watched again once it shows).
        if (steadyWatch.started && !steadyWatch.verdict && !coldOn) {
          // Receiver 87 (w34kr8dq, iOS 294 after a reconnect: "it bowled me because I couldn't even see the ball coming on
          // the TV"): a plateau verdict while the stadium's pictures were still loading (397 draws missing one 2 s before)
          // said steady at 18 a second and let the first ball go. While pictures are still loading the watch starts again
          // (the phone holds its first ball at most its own 8 s, as before).
          const verdict = steadyWatch.draw(local);
          if (verdict && verdict.why === "plateau" && (local - lastMissingAt < 500 || startLoading > 0)) steadyWatch.start(local);
          else noteSteady(verdict, local);
        }
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
      // Receiver 113: a picture that came in with the stadium on, warmed in this frame's spare time.
      if (lateWarm.length && tune.cold === 1) warmQueued(local);
      // Receiver 77: the start's pictures still to come (the rest waits, restWaits).
      if (preloadQueue.length && preloading < 3) pumpSome();
      // Receiver 112: photo layers no longer drawn let go, once a second.
      if (local - lastLayerCheck >= 1000) evictLayers(local);
      // An ack means a new stadium frame was drawn, not merely that this
      // page's timer is alive. A blocked sender can still receive messages:
      // repeating the last stamp hid frozen Google TV pictures from both
      // phones' 1.5 s timeout and let the match continue behind them.
      if (local - lastAck >= 250 && lastStamp != null && lastStamp !== lastAcknowledgedStamp) {
        lastAck = local;
        lastAcknowledgedStamp = lastStamp;
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
          // Receiver 112: draws of 50 ms or more (one spike or many behind `drawMax`).
          drawSlow: counters.drawMs.filter((ms) => ms >= 50).length,
          dressMax: Number(counters.dressMax.toFixed(1)), dressed: counters.dressed,
          dressReadMax: Number(counters.dressReadMax.toFixed(1)), dressDyeMax: Number(counters.dressDyeMax.toFixed(1)),
          missing: counters.missing, images: images.size, layers: backdropLayers.size, warmed: warmed.size, cached: staticLayer.hits, rebuilt: staticLayer.built, batter: liveLayer.hits, batterRuns: liveRuns.hits, bitmaps: bitmaps.size, queue: timeline.length,
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
          rehearsed: rehearsal.draws,
          // Receiver 113: draws held while cold pictures were warmed, and pictures warmed with the stadium on.
          coldHeld: counters.coldHeld, warmedLate: counters.warmedLate,
          // Receiver 115: frames that came as references, and those that couldn't be put back.
          refFrames: counters.refFrames, refMiss: counters.refMiss
        };
        if (rehearsal.ms.length >= 20) stats.rehearseMs = [rehearsal.firstMs, Number(core.percentile(rehearsal.ms.slice(-10), 0.5).toFixed(1))];
        // Receiver 77: when the rehearsal began and the preload ran dry, ms from the hello.
        if (rehearsal.startedAt) stats.rehearseAt = Math.round(rehearsal.startedAt - rehearsal.askedAt);
        if (preloadDoneAt !== null && rehearsal.asked) stats.preloadMs = Math.max(0, Math.round(preloadDoneAt - rehearsal.askedAt));
        // Receiver 111: the drawing's warm-up so far (draws rehearsed and drawn, up to a rehearsal's worth); a stadium that
        // came on cold (`cold`) and how long the phone's picture stayed over it (`cover`, ms from it coming on).
        if (judgesWarmth()) stats.warmth = drawingWarm() ? rehearsalTarget() : rehearsal.draws + stadiumDraws;
        if (on && wasCold) stats.cold = 1;
        if (on && uncoveredAt) stats.cover = Math.max(0, Math.round(uncoveredAt - onAt));
        // The receiver's own files read from the TV and fetched this page (receiver 77, keptURL);
        // numbers, not a list: a phone's log writes each field on one line.
        if (keptDb) { stats.kept = keptCounts.read; stats.fetched = keptCounts.fetched; if (keptCounts.carried) stats.carried = keptCounts.carried; }
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
        // Receiver 83: a report of the start's pictures coming in, not of the TV (core.warmReport).
        const report = core.warmReport(stats, { sinceOn: on ? local - onAt : null, uploading: uploads.size, received: counters.received,
          loading: loading.size, missing: counters.missing });
        send(report);
        if (debug) setDebug(stats);
        counters.received = 0;
        counters.draws = 0; counters.blended = 0; counters.frames = 0; counters.redraws = 0;
        counters.late = []; counters.drawMs = []; counters.dressMax = 0; counters.dressReadMax = 0; counters.dressDyeMax = 0; counters.dressed = 0; counters.missing = 0; counters.gaps = [];
        counters.live = 0; counters.pose = []; counters.ahead = []; counters.eff = [];
        counters.js = 0; counters.long = 0; counters.lag = [];
        counters.partly = 0; counters.stale = [];
        counters.coldHeld = 0; counters.warmedLate = 0; counters.refFrames = 0; counters.refMiss = 0;
      }
    }

    let debugLine = null;
    function setDebug(stats) {
      if (!debugLine) {
        debugLine = document.createElement("div");
        debugLine.id = "scene-status";
        root.appendChild(debugLine);
      }
      debugLine.textContent = core.debugLine(stats);
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
        lastStamp = null;
        lastAcknowledgedStamp = null;
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
        // Receiver 111: and on a cold page, until its drawing is warm (COVER_MS at most all the same). Only an innings
        // (`options.innings`, receiver.js: the game state's cricket screen), whose first ball the phone holds for steady:
        // a full match's bowling (the game state's result card) starts as it comes on, on both phones.
        coldOn = judgesWarmth() && phoneWaitsSteady && !drawingWarm() && (!options.innings || !!options.innings());
        wasCold = coldOn;
        coldProgress = 0;
        uncoveredAt = 0;
      }
      if (!value) uncover();
      // Receiver 111: a stadium that goes off before its drawing is warm (a full match's bowling, skipped 0.6 s in) asks
      // for the rest of the rehearsal, so the innings' stadium after it does not come on cold.
      const wentOff = on && !value;
      on = !!value;
      if (wentOff && hasHello && !released && judgesWarmth() && !drawingWarm()) wantRehearsal(performance.now(), true);
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
      // Receiver 115: `refs`, a frame's commands may be references to a frame before (core.createRefBook). Not `fb`
      // (receiver 114's live batter riding in a frame's message): y8qphjrd (Android AG 27585 on staging 114, Nov 27 ~14:10:
      // "It used to show the shot, now it just directly goes to fielding") against zcm4jrnf (AH on 113, no riding: "Much
      // better, timing was good as well"): a batter waiting up to 20 ms for his frame crossed the TV's display frames, and a
      // 30 Hz model of the recordings loses ~150 of 2,205 drawn batters (Android) and ~93 of 1,313 (iOS), most in swings.
      // A rider that comes anyway is still drawn (the "f" handler), so a phone that rides on a receiver that never said fb
      // loses nothing more.
      const ready = { t: "ready", scene: 1, pic: 1, card: 1, live: 1, setup: 1, whole: 1, predict: 1, shared: 1, inset: insetOff ? 0 : 1, steady: 1, refs: 1,
        held: options.heldKeep || 0, cards: options.heldCards ? options.heldCards() : [], screen: screenPixels(), version: VERSION, ua: navigator.userAgent, have };
      // A weak dongle: the phone sends frames and live batters at its pace.
      if (plan.weak) ready.weak = 1;
      send(ready);
      preloadBundled(helloKit, helloGround, helloViews);
    }

    function report(where, error) {
      const receiverCore = typeof globalThis !== "undefined" ? globalThis.SlipSparkReceiverCore : null;
      send(Object.assign({ t: "error", where, message: String((error && error.message) || error).slice(0, 300) }, receiverCore ? receiverCore.failureReport(where, error) : {}));
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
        zeroCanvas(shot);
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
          hasHello = true;
          // Receiver 112: a new cast's photo layers are counted afresh (evictLayers).
          layerSession += 1; sessionOnMs = 0; lastLayerCheck = 0;
          if (window.RallycadeDye) window.RallycadeDye.prepare();
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
          refs.clear();
          helloRefs = message.refs === 1;
          live.clear();
          lastStamp = null;
          lastAcknowledgedStamp = null;
          wholeSent = false;
          // Receiver 60: the phone's kit, whose cached pieces load with the batter's.
          helloKit = typeof message.kit === "string" ? message.kit : null;
          helloGround = groundKey(message.ground);
          // Receiver 85: a phone's new connection sends its pieces anew (Android every cast): each a new look's again.
          piecesHeld.clear();
          helloViews = Array.isArray(message.views) ? message.views : null;
          helloPieces = new Set(Array.isArray(message.pieces)
            ? message.pieces.slice(0, 40).filter((key) => typeof key === "string" && key.length <= 120 && isDressedPiece(key)) : []);
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
          selectStadiumLook(message.on === 1 ? message.lookPieces : null);
          setOn(message.on === 1);
          break;
        case "f": {
          // Receiver 115: its references to a frame before put back (ready.refs).
          if (message.r != null) {
            if (!refs.resolve(message)) { refMissed(message); break; }
            counters.refFrames += 1;
          } else if (helloRefs) refs.resolve(message);
          const frame = timeline.add(message, message.e);
          if (frame) noteArrival(frame);
          // Receiver 114 (`ready.fb`): a live batter that rides in the frame's message (`b`, his own "b" message), as
          // if it had come on its own just after: one Cast message instead of two (each costs the Ultra ~3 ms: the Cast
          // framework parses it twice and dispatches it twice).
          if (message.b && typeof message.b === "object" && !Array.isArray(message.b)) { message.b.t = "b"; handleMessage(message.b); }
          break;
        }
        case "fs": {
          // Receiver 115: each frame's references put back, in order (a frame may refer to the one before it in the set);
          // one that can't be, and those after it, aren't drawn.
          if (Array.isArray(message.frames)) {
            const whole = [];
            for (const raw of message.frames) {
              const referred = raw && raw.r != null;
              if (!referred && !helloRefs) { whole.push(raw); continue; }
              if (!refs.resolve(raw)) { refMissed(raw); break; }
              if (referred) counters.refFrames += 1;
              whole.push(raw);
            }
            if (whole.length < message.frames.length) message.frames = whole;
          }
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
    const bundledLoaded = loadBundled();
    Promise.all([atMost(bundledLoaded, 4000), atMost(openCache(), 2000), atMost(fontsReady, 1500)]).then(() => {
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
      hasHello = false;
      if (window.RallycadeDye) window.RallycadeDye.release();
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
      dressed.forEach(empty);
      dressed.clear();
      dressingSheets.forEach(releasePixels);
      dressingSheets.clear();
      maskSheets.forEach((entry) => releasePixels(entry.image));
      maskSheets.clear();
      gearSheets.forEach((entry) => releasePixels(entry.image));
      gearSheets.clear();
      requestedKitSources = false; requestedGearSources = false;
      images.forEach(empty);
      images.clear();
      backdropLayers.forEach((entry) => { try { entry.element.removeAttribute("src"); } catch (error) { /* gone */ } });
      empty(canvas);
      canvasDrawn = null;
      dropWarmCanvas();
      dropLateWarm();
      endRehearsal();
      dropStaticLayer();
      // Receiver 89: the composed pictures' own layers, and every blob URL this page made.
      pictures.forEach((entry) => { if (entry && Array.isArray(entry.layers)) entry.layers.forEach(zeroCanvas); });
      pictures.clear();
      composed.length = 0;
      objectURLs.forEach((url) => { try { URL.revokeObjectURL(url); } catch (error) { /* gone */ } });
      objectURLs.clear();
    }

    // Receiver 107: another of the receiver's own files (the music bed, receiver.js) kept on the TV as its pictures are:
    // where it loads from once the TV's copies are open (`keptURL`), the plain path if they never open.
    function keptFile(path) {
      return atMost(bundledLoaded, 4000).then(() => keptURL(path)).catch(() => path);
    }

    return { NAMESPACE, handle, report, setOn, renderHUD, drawFrame, keptFile, playRecording, playRecordingAt, snapshot, timeline, clock, live, images, bitmaps, release, selectGame,
      get cricketWanted() { return cricketWanted; },
      pictures, counters, tune, setTune, warmed, staticLayer, liveLayer, liveRuns, get dressing() { return dressingWasOn; }, holdLast, get holding() { return holding; }, get hasFrame() { return !!shownFrame; },
      // Receiver 77: how the rehearsal and the preload stand (tests and the bench's probe).
      get rehearsal() { return { draws: rehearsal.draws, wanted: rehearsal.wanted, own: rehearsal.own, startedAt: rehearsal.startedAt, askedAt: rehearsal.askedAt }; },
      // Receiver 111: how warm the stadium's drawing is, and whether this stadium came on cold.
      get warmth() { return { warm: drawingWarm(), draws: rehearsal.draws + stadiumDraws, rehearsedFully, drewSteadily, cold: coldOn, wasCold, uncoveredAt }; },
      get selectedGame() { return selectedGame; },
      get preload() { return { left: preloadQueue.length, loading: preloading, doneAt: preloadDoneAt }; } };
  }

  window.RallycadeReceiverScene = { NAMESPACE, createScene };
})();
