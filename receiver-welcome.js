(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RallycadeWelcome = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Receiver 56: the app-open welcome, played by the TV itself while the
  // phone plays it (the phone sends `welcome` on the ready screen:
  // CastDisplayState.Welcome). The stadium photo starts dark, the four
  // floodlights strike one by one with a flicker and a glow, the logo lands
  // with a small bounce and the commentator's lines show as captions (the
  // voice plays on the phone). Timings are shared/commentary/welcome.json's,
  // positions are the phone's (WelcomeStadiumGeometry). A short welcome is
  // a caption over the ready screen. Light by design: a dozen style changes
  // a frame for a few seconds, no canvas.

  const TIMING = {
    lights: [0.20, 0.48, 0.76, 1.04],
    logoAt: 1.15,
    fadeIn: 0.9,
    fadeOut: 0.5
  };
  // The design canvas (1920 x 1080) the photo fills: CricketStadium is
  // 1672 x 941 pixels.
  const W = 1920, H = 1080, K = 1920 / 1672;
  const ROOF_LEFT = [[109, 143], [226, 178], [331, 203], [405, 221], [477, 239], [539, 251]];
  const ROOF_RIGHT = [[1632, 97], [1505, 138], [1385, 175], [1283, 203], [1227, 218], [1189, 228], [1133, 239], [1061, 251]];
  const TOWERS = [[398, 128], [1248, 135]];
  // The part of the stadium each light brightens: centre and spread.
  const REGIONS = [[0.15, 0.32, 0.22, 0.35], [0.85, 0.32, 0.22, 0.35], [0.33, 0.72, 0.30, 0.45], [0.67, 0.72, 0.30, 0.45]];
  const WARM = "255, 242, 219";

  function clamp01(x) { return Math.max(0, Math.min(1, x)); }
  function easeOut(p) { p = clamp01(p); return 1 - Math.pow(1 - p, 3); }

  /** A floodlight `dt` seconds after it strikes (WelcomeTimeline.strike). */
  function strike(dt) {
    if (dt < 0) return 0;
    if (dt < 0.035) return 0.7;
    if (dt < 0.07) return 0.12;
    if (dt < 0.09) return 0.9;
    if (dt < 0.12) return 0.35;
    const u = dt - 0.12;
    return 1 + 0.35 * Math.exp(-u / 0.12) - 0.65 * Math.exp(-u / 0.04);
  }

  /** A Gaussian glow as CSS: `alpha` at its middle, spread `sigma` design pixels. */
  function glow(x, y, sigma, alpha) {
    const r = sigma * 2.6;
    const stops = [0, 0.2, 0.4, 0.6, 0.8, 1].map((f) => {
      const d = f * 2.6;
      return `rgba(${WARM}, ${(alpha * Math.exp(-d * d)).toFixed(3)}) ${(f * 100).toFixed(0)}%`;
    });
    return `radial-gradient(circle ${r.toFixed(1)}px at ${(x * K).toFixed(1)}px ${(y * K).toFixed(1)}px, ${stops.join(", ")})`;
  }

  /** Each light's glows as one CSS background: the roofs' lamps, the towers' heads. */
  function glows() {
    const lamps = (points) => points.flatMap(([x, y]) => [glow(x, y, 4 * K, 1), glow(x, y, 16 * K, 0.35), glow(x, y, 55 * K, 0.07)]).join(", ");
    const tower = ([x, y]) => [glow(x, y, 38 * K, 0.9), glow(x, y, 100 * K, 0.45), glow(x, y, 300 * K, 0.16)].join(", ");
    return [lamps(ROOF_LEFT), lamps(ROOF_RIGHT), tower(TOWERS[0]), tower(TOWERS[1])];
  }

  /** Each light's part of the stadium, as a CSS mask over the lit photo. */
  function masks() {
    return REGIONS.map(([x, y, sx, sy]) =>
      `radial-gradient(ellipse ${(sx * 200).toFixed(0)}% ${(sy * 200).toFixed(0)}% at ${(x * 100).toFixed(0)}% ${(y * 100).toFixed(0)}%, ` +
      "rgba(0,0,0,.85) 0%, rgba(0,0,0,.55) 20%, rgba(0,0,0,.2) 40%, rgba(0,0,0,0) 60%)");
  }

  /**
   * What the welcome shows `t` seconds in: whether it is on, the lights,
   * the logo and the caption. `welcome` is normalizeWelcome's.
   */
  function frame(welcome, t) {
    const end = welcome.end / 1000;
    const out = 1 - clamp01((t - end) / TIMING.fadeOut);
    const full = welcome.kind === "full";
    const reduced = welcome.reduced;
    const levels = full ? TIMING.lights.map((at) => (reduced ? clamp01(t / TIMING.fadeIn) : strike(t - at))) : [0, 0, 0, 0];
    const tau = t - TIMING.logoAt;
    const logo = full && tau >= 0 ? {
      opacity: clamp01(tau / (reduced ? 0.4 : 0.12)),
      scale: reduced ? 1 : 1 + 0.4 * Math.exp(-tau / 0.12) * Math.cos(2 * Math.PI * tau / 0.36),
      word: clamp01((tau - 0.08) / (reduced ? 0.4 : 0.12)),
      wordScale: reduced || tau < 0.08 ? 1 : 1 + 0.25 * Math.exp(-(tau - 0.08) / 0.12) * Math.cos(2 * Math.PI * (tau - 0.08) / 0.36),
      scrim: easeOut(tau / 0.4),
      halo: Math.min(1, 0.9 * easeOut(tau / 0.2) * (1 + (reduced ? 0 : 0.8) * Math.exp(-Math.max(0, tau - 0.12) / 0.25)))
    } : null;
    let caption = null;
    for (const line of welcome.lines) {
      const at = line.at / 1000, length = line.duration / 1000;
      const appear = (t - (at - 0.05)) / 0.3, leave = (at + length + 0.35 - t) / 0.25;
      // A line that would start as the TV hands back is left to the phone.
      if (appear > 0 && leave > 0 && at < end - 0.6) { caption = { text: line.text, opacity: Math.min(easeOut(appear), clamp01(leave)), rise: (1 - easeOut(appear)) * 60 }; break; }
    }
    return { on: t < end + TIMING.fadeOut, opacity: out, full, levels, lit: Math.min(...levels.map(clamp01)), logo, caption };
  }

  /**
   * The welcome on the page. `elements`: root, stage, canvas, dark, lit
   * (four), litAll, glows (four), scrim, halo, icon, wordmark, caption,
   * captionText. `now()` in ms; `requestFrame`/`cancelFrame` drive it.
   */
  function createWelcomeView(options) {
    const e = options.elements;
    const now = options.now;
    let current = null, startedAt = 0, frameId = null;
    // Each welcome plays once, however often its state is sent again.
    const played = new Set();
    const backgrounds = glows();
    const regionMasks = masks();
    let prepared = false;

    function prepare() {
      if (prepared || !e.glows) return;
      prepared = true;
      e.glows.forEach((layer, index) => { layer.style.background = backgrounds[index]; });
      e.lit.forEach((layer, index) => { layer.style.webkitMaskImage = regionMasks[index]; layer.style.maskImage = regionMasks[index]; });
    }

    function fit() {
      if (!e.stage || !e.canvas) return;
      const width = e.stage.clientWidth || W;
      e.canvas.style.transform = `scale(${width / W})`;
    }

    let fitted = false;
    function apply(f) {
      e.root.hidden = !f.on;
      // Measured once it is on screen: hidden, the stage has no size.
      if (f.on && !fitted) { fitted = true; fit(); }
      e.root.style.opacity = String(f.opacity);
      e.stage.hidden = !f.full;
      // A short welcome is a caption over the ready screen itself.
      e.root.style.background = f.full ? "#000" : "transparent";
      if (f.full) {
        e.lit.forEach((layer, index) => { layer.style.opacity = String(clamp01(f.levels[index])); });
        e.litAll.style.opacity = String(f.lit);
        e.glows.forEach((layer, index) => { layer.style.opacity = String(Math.max(0, f.levels[index])); });
        const logo = f.logo;
        e.scrim.style.opacity = String(logo ? logo.scrim : 0);
        e.halo.style.opacity = String(logo ? logo.halo : 0);
        e.icon.style.opacity = String(logo ? logo.opacity : 0);
        e.icon.style.transform = `translate(-50%, -50%) scale(${logo ? logo.scale.toFixed(3) : 1})`;
        e.wordmark.style.opacity = String(logo ? logo.word : 0);
        e.wordmark.style.transform = `translate(-50%, -50%) scale(${logo ? logo.wordScale.toFixed(3) : 1})`;
      }
      e.caption.hidden = !f.caption;
      if (f.caption) {
        e.captionText.textContent = f.caption.text;
        e.caption.style.opacity = String(f.caption.opacity);
        e.caption.style.transform = `translate(-50%, ${f.caption.rise.toFixed(1)}px)`;
      }
    }

    function tick() {
      frameId = null;
      if (!current) return;
      const f = frame(current, (now() - startedAt) / 1000);
      apply(f);
      if (f.on) frameId = options.requestFrame(tick);
      else stop();
    }

    function stop() {
      if (frameId !== null) options.cancelFrame(frameId);
      frameId = null;
      current = null;
      e.root.hidden = true;
      e.caption.hidden = true;
    }

    /** Every state from the phone: a new welcome starts (where the phone
     *  is in it), the same one may end sooner (a skip), none stops it. */
    function update(state) {
      const welcome = state && state.welcome;
      if (!welcome) { if (current) stop(); return; }
      if (current && current.id === welcome.id) { current = Object.assign({}, current, { end: Math.min(current.end, welcome.end) }); return; }
      if (played.has(welcome.id)) return;
      played.add(welcome.id);
      prepare();
      current = welcome;
      startedAt = now() - welcome.elapsed;
      fitted = false;
      if (frameId === null) frameId = options.requestFrame(tick);
    }

    return { update, tick, stop, playing: () => current, frameAt: (t) => (current ? frame(current, t) : null) };
  }

  return { TIMING, strike, frame, glows, masks, createWelcomeView, W, H, K };
});
