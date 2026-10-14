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
    // The 16:9 box the stadium fills, in CSS pixels.
    const stageBox = options.stage || root;
    const boxWidth = () => stageBox.clientWidth || window.innerWidth;
    const ctx = canvas.getContext("2d");
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
    const counters = { draws: 0, blended: 0, frames: 0, late: [], drawMs: [], missing: 0, redraws: 0, gaps: [], live: 0, pose: [], ahead: [], eff: [] };

    // MARK: Sizing

    // What this TV found last time (a device too slow for 1920), so the next
    // cast starts narrow. Local storage may be missing or blocked.
    function rememberedCanvas() {
      try { return JSON.parse(window.localStorage.getItem("rallycade-scene-canvas") || "null"); } catch (error) { return null; }
    }

    function rememberCanvas(width) {
      try {
        window.localStorage.setItem("rallycade-scene-canvas", JSON.stringify({ ua: navigator.userAgent, width }));
      } catch (error) { /* the next cast measures again */ }
    }

    // The wide canvas fell below the frame rate: narrow it for good. The
    // frame on screen is drawn again in the same animation frame, so the TV
    // never shows the cleared canvas.
    function narrowCanvas() {
      plan = { width: core.CANVAS.narrow, adaptive: false, why: "slow" };
      maxCanvasWidth = plan.width;
      rememberCanvas(plan.width);
      resize();
      if (shownFrame) { drawFrame(shownFrame); needsRedraw = false; }
    }

    function resize() {
      const width = core.canvasWidth(boxWidth(), window.devicePixelRatio, maxCanvasWidth);
      const height = Math.round(width * STAGE.height / STAGE.width);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
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
    // GPU layer's source, and its decoded bitmap, both in before a frame
    // draws it.
    function loadPicture(key, url, blob) {
      if (!canBitmap || !tune.bitmaps) return loadImage(url).then((image) => { addImage(key, image); return image; });
      const bytes = blob ? Promise.resolve(blob)
        : fetch(url).then((response) => { if (!response.ok) throw new Error("fetch " + url); return response.blob(); });
      const bitmap = bytes.then((data) => {
        const options = bitmapOptions(key);
        // A browser that can't resize makes it at its own size.
        return options ? window.createImageBitmap(data, options).catch(() => window.createImageBitmap(data)) : window.createImageBitmap(data);
      }).then((made) => (made && made.width > 0 && made.height > 0 ? made : null)).catch(() => null);
      return Promise.all([loadImage(url, false), bitmap]).then(([image, decoded]) => {
        if (!decoded) {
          // No bitmap: the image, decoded as before.
          return (image.decode ? image.decode().catch(() => {}) : Promise.resolve()).then(() => { addImage(key, image); return image; });
        }
        const old = bitmaps.get(key);
        if (old && old.close) old.close();
        bitmaps.set(key, decoded);
        addImage(key, image);
        return image;
      });
    }

    // The receiver's own pictures, two at a time, as soon as a phone says
    // hello: by the first ball every one is ready.
    function preloadBundled() {
      // This TV's own copies of pictures earlier casts sent too (receiver
      // 53): build 158's innings opened with 22–59 draws a second missing a
      // photo the TV had cached but not yet loaded.
      const keys = Array.from(bundled.keys()).concat(Array.from(cached).filter((key) => !bundled.has(key)).slice(0, MAX_CACHED_PRELOAD));
      let next = 0;
      const pump = () => {
        while (next < keys.length && (images.has(keys[next]) || loading.has(keys[next]))) next += 1;
        if (next >= keys.length) return;
        const key = keys[next];
        next += 1;
        loading.add(key);
        const source = bundled.has(key) ? Promise.resolve("scene-images/" + bundled.get(key))
          : database ? loadCached(key) : Promise.reject(new Error("no cache"));
        source.then((url) => loadPicture(key, url))
          .then(() => {}, () => loading.delete(key))
          .then(() => window.setTimeout(pump, 20));
      };
      pump();
      pump();
      pump();
    }

    // The first frame after the stadium comes on drawn with every picture
    // it needs: the phone holds the first ball until then (receiver 53).
    let wholeSent = false;
    function noteWhole(missingBefore) {
      if (wholeSent || !on || counters.missing !== missingBefore) return;
      wholeSent = true;
      send({ t: "whole" });
    }

    // Cached pictures loaded at hello, at most.
    const MAX_CACHED_PRELOAD = 48;

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
      if (images.has(key) || requested.has(key)) return;
      // A picture let go to save memory is made again from its commands.
      const picture = pictures.get(key);
      if (picture) { compose(key); return; }
      if (loading.has(key)) return;
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
      const bytes = atob(data);
      const array = new Uint8Array(bytes.length);
      for (let index = 0; index < bytes.length; index += 1) array[index] = bytes.charCodeAt(index);
      const blob = new Blob([array], { type: upload.type });
      if (upload.type === "image/jpeg") opaque.add(key);
      const url = URL.createObjectURL(blob);
      loadPicture(key, url, blob).then(() => {
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
        hideBackdrops(op[3]);
        entry.element.style.opacity = "1";
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
    const TUNED = Object.freeze({ blur: "shadow", layers: "bounded", cover: "clip", bitmaps: 0, shade: "thirds" });
    const tune = Object.assign({}, TUNED);
    // Each hello starts from the defaults; the bench's `x` changes them.
    function setTune(x) {
      Object.assign(tune, TUNED);
      if (x && typeof x === "object") Object.keys(TUNED).forEach((name) => { if (x[name] !== undefined) tune[name] = x[name]; });
      document.body.dataset.sceneShade = tune.shade;
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
      return ref >= 0 && frame.fl[ref] ? core.filterParts(frame.fl[ref]) : { blur: 0, multiply: null };
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
      if (image) return { image: bitmaps.get(key) || image, size: sizes.get(key), key };
      ensure(key);
      counters.missing += 1;
      // A picture still being made: its undyed photo meanwhile.
      const picture = pictures.get(key);
      const fallback = picture && picture.fallback && images.get(picture.fallback);
      if (!fallback) return null;
      return { image: bitmaps.get(picture.fallback) || fallback, size: { width: picture.width, height: picture.height }, key: picture.fallback };
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
        c.drawImage(multiply ? tint(drawn.key, drawn.image, multiply) : drawn.image, 0, 0, drawn.size.width, drawn.size.height);
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
    }

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

    function drawFrame(frame) {
      const started = performance.now();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = smoothing;
      const cover = coverIndex(frame);
      let from = 0;
      if (cover >= 0 && showBackdrop(frame.o[cover])) {
        from = cover + 1;
      } else if (cover < 0) {
        hideBackdrops(null);
      }
      // A photo whose layer isn't decoded yet is drawn on the canvas, over
      // whichever layer was showing: never an empty frame.
      paint(ctx, frame, from, { s: scale, width: canvas.width, height: canvas.height, layers: null, live: live.current });
      counters.drawMs.push(performance.now() - started);
      counters.draws += 1;
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
            const box = top.bounds ? core.opBounds(op, pictureSize) : null;
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
            if (top.bounds) grow(top.bounds, core.opBounds(op), scale, 0);
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

    function renderHUD(h) {
      // Scorebug: runs for wickets and overs, or the timing check's ball.
      show("hud-score", !!h.score);
      show("hud-check", !!h.check);
      if (h.score) {
        setText("hud-runs", h.score.runs + "/" + h.score.wickets);
        setText("hud-overs", h.score.overs + " of " + h.score.of);
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
      } else if (!h.check) {
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
        if (caption.hidden) caption.hidden = false;
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
      if (!on) return;
      const local = performance.now();
      if (lastLoop) counters.gaps.push(local - lastLoop);
      lastLoop = local;
      const phoneNow = clock.phoneNow(local);
      if (phoneNow == null) return;
      const result = timeline.at(phoneNow);
      // A frame already on screen is drawn again only while blending.
      let drew = false;
      if (result && (result.blended || result.stamp !== lastStamp || needsRedraw)) {
        const missingBefore = counters.missing;
        drawFrame(result.frame);
        noteWhole(missingBefore);
        shownFrame = result.frame;
        drew = true;
        needsRedraw = false;
        if (result.blended) counters.blended += 1;
        lastStamp = result.stamp;
      }
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
          missing: counters.missing, images: images.size, bitmaps: bitmaps.size, queue: timeline.length,
          // How glows are blurred (receiver 57): as shadows, or in small canvases.
          glow: tune.blur === "filter" ? "filter" : castsOffstageShadows() ? "shadow" : "scratch",
          synced: clock.synced ? 1 : 0, w: canvas.width, canvas: plan.why,
          gap: Number(core.percentile(counters.gaps, 0.5).toFixed(1)),
          gap90: Number(core.percentile(counters.gaps, 0.9).toFixed(1)),
          // Live batters received; and how old the pose of the batter on
          // screen was (camera capture to drawn, ms) when the phone says.
          live: counters.live
        };
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

    function setOn(value) {
      if (!!value && !on) wholeSent = false;
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
      send({ t: "ready", scene: 1, pic: 1, card: 1, live: 1, setup: 1, whole: 1, predict: 1, screen: screenPixels(), version: VERSION, ua: navigator.userAgent, have });
      preloadBundled();
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
      if (!message || typeof message !== "object") return;
      switch (message.t) {
        case "hello":
          debug = message.debug === 1;
          // A width the phone or the bench asks for is kept as asked; else
          // the device's own plan, and a wide canvas is measured afresh.
          plan = core.canvasPlan({ ua: navigator.userAgent, pinned: message.canvas || options.canvasWidth,
            wide: message.wide === 1, remembered: rememberedCanvas() });
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

    Promise.all([loadBundled(), openCache(), fontsReady]).then(() => {
      readyToAnswer = true;
      if (pendingHello) { pendingHello = false; answerHello(); }
    });
    window.requestAnimationFrame(frameLoop);

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
    }

    return { NAMESPACE, handle, report, setOn, renderHUD, drawFrame, playRecording, playRecordingAt, snapshot, timeline, clock, live, images, bitmaps, release,
      pictures, counters, tune, setTune };
  }

  window.RallycadeReceiverScene = { NAMESPACE, createScene };
})();
