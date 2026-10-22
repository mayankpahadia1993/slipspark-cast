(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RallycadeCelebration = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Receiver 66 (TestFlight 211, Oct 22 2026, the owner: "after you win the
  // championship, we should show an animation of the World Cup trophy.
  // Maybe an animation of giving a check with XP and coins earned in the
  // contest. Similarly for club cups as well."). While the phone shows a cup
  // celebration over its scorecard it sends `result.celebration`
  // (CastDisplayState.Celebration); the TV plays the same moment over the
  // phone's scorecard picture, on the phone's clock: the trophy lifted into
  // its light, the words, the presentation cheque counting up, confetti.
  // The phone ends it (a tap, a raised hand, its time up); a state without
  // it ends it here too. Choreography, timing, words and the trophies' art
  // are the phone's (CupCelebrationMotion, shared/career/cup-celebration.json,
  // which receiver-celebration.test.cjs holds these equal to). Laid out on a
  // 1920 x 1080 stage as the AirPlay TV draws CupCelebrationFrame (the
  // phone's layout at the TV's scale), scaled to fit.

  const ART = {"viewBox":[200,300],"paints":{"gold":[[0,"#6B3F12"],[0.18,"#B9792A"],[0.4,"#FFE7A3"],[0.52,"#FFC252"],[0.78,"#C2832E"],[1,"#6B3F12"]],"goldDeep":[[0,"#4A2A0B"],[0.45,"#9A6220"],[0.6,"#C98E35"],[1,"#4A2A0B"]],"goldLight":[[0,"#C9902F"],[0.45,"#FFF3C9"],[0.6,"#FFD66E"],[1,"#B9792A"]],"silver":[[0,"#4B525C"],[0.18,"#8A929E"],[0.4,"#F6F8FB"],[0.55,"#D2D7DE"],[0.8,"#8E96A2"],[1,"#454B54"]],"silverDeep":[[0,"#2E333A"],[0.5,"#6B7380"],[1,"#2E333A"]],"silverLight":[[0,"#9AA2AE"],[0.45,"#FFFFFF"],[0.6,"#E3E7EC"],[1,"#8A929E"]],"plinth":[[0,"#050B0A"],[0.45,"#1F3A34"],[0.6,"#16302B"],[1,"#050B0A"]],"ribbon":[[0,"#0B3D24"],[0.5,"#1F8A52"],[1,"#0B3D24"]],"ribbonDeep":[[0,"#062615"],[1,"#0E4F2E"]],"shine":[[0,"#FFFFFF"],[1,"#FFFFFF"]]},"trophies":{"world":[{"paint":"plinth","d":"M52 262 L148 262 Q154 262 154 268 L154 288 Q154 294 148 294 L52 294 Q46 294 46 288 L46 268 Q46 262 52 262 Z"},{"paint":"gold","d":"M46 271 L154 271 L154 276 L46 276 Z"},{"paint":"gold","d":"M63 247 L137 247 Q141 247 142 251 L146 262 L54 262 L58 251 Q59 247 63 247 Z"},{"paint":"goldDeep","d":"M58 258 L142 258 L146 262 L54 262 Z"},{"paint":"gold","d":"M89 247 C90 230 93 218 94 208 C95 200 93 194 90 186 L110 186 C107 194 105 200 106 208 C107 218 110 230 111 247 Z"},{"paint":"goldLight","d":"M89 201 Q100 196 111 201 Q113 205 111 209 Q100 214 89 209 Q87 205 89 201 Z"},{"paint":"goldDeep","d":"M100 180 C82 160 66 140 58 112 C54 96 56 80 62 64 C62 82 66 98 76 114 C84 128 94 142 100 158 C106 142 116 128 124 114 C134 98 138 82 138 64 C144 80 146 96 142 112 C134 140 118 160 100 180 Z"},{"paint":"gold","d":"M94 180 C74 166 56 146 50 118 C46 98 52 80 64 62 C62 80 64 98 74 114 C82 128 92 142 98 160 Z"},{"paint":"gold","d":"M106 180 C126 166 144 146 150 118 C154 98 148 80 136 62 C138 80 136 98 126 114 C118 128 108 142 102 160 Z"},{"paint":"goldDeep","d":"M100 178 C88 156 82 132 84 106 C86 88 92 72 98 58 C98 78 100 96 104 114 C108 134 106 156 100 178 Z"},{"paint":"gold","d":"M100 178 C86 152 80 122 86 92 C90 68 98 46 103 18 C110 42 121 64 121 92 C121 122 113 152 100 178 Z"},{"paint":"goldLight","d":"M101 168 C92 146 89 120 93 96 C96 76 101 58 104 40 C104 62 100 80 99 100 C98 124 101 146 101 168 Z"},{"paint":"goldLight","d":"M70 70 C64 86 64 102 72 118 C78 130 86 140 92 152 C82 142 72 132 66 120 C58 104 60 86 70 70 Z"},{"paint":"goldLight","d":"M132 74 C138 90 136 106 128 120 C122 130 114 140 108 150 C116 140 124 130 130 118 C138 104 138 88 132 74 Z"},{"paint":"gold","d":"M76 164 Q100 174 124 164 C122 180 113 192 100 192 C87 192 78 180 76 164 Z"},{"paint":"goldLight","d":"M78 165 Q100 175 122 165 Q121 170 119 173 Q100 180 81 173 Q79 170 78 165 Z"},{"paint":"goldDeep","d":"M84 186 Q100 194 116 186 Q112 191 100 193 Q88 191 84 186 Z"}],"club":[{"paint":"plinth","d":"M62 258 L138 258 Q146 258 146 266 L146 288 Q146 294 140 294 L60 294 Q54 294 54 288 L54 266 Q54 258 62 258 Z"},{"paint":"silver","d":"M54 266 L146 266 L146 271 L54 271 Z"},{"paint":"silverLight","d":"M82 277 L118 277 Q120 277 120 279 L120 287 Q120 289 118 289 L82 289 Q80 289 80 287 L80 279 Q80 277 82 277 Z"},{"paint":"silver","d":"M70 258 Q70 248 82 246 L118 246 Q130 248 130 258 Z"},{"paint":"silver","d":"M92 246 C94 232 94 222 92 212 L108 212 C106 222 106 232 108 246 Z"},{"paint":"silverLight","d":"M84 207 Q100 199 116 207 Q118 212 116 217 Q100 224 84 217 Q82 212 84 207 Z"},{"paint":"ribbonDeep","d":"M26 112 C22 150 24 196 26 240 L32 232 L38 242 C38 196 38 150 40 112 Z"},{"paint":"ribbonDeep","d":"M174 112 C178 150 176 196 174 240 L168 232 L162 242 C162 196 162 150 160 112 Z"},{"paint":"silver","d":"M50 92 C26 86 14 106 20 128 C26 146 44 154 62 150 L62 141 C48 143 34 138 29 125 C24 110 32 98 50 101 Z"},{"paint":"silver","d":"M150 92 C174 86 186 106 180 128 C174 146 156 154 138 150 L138 141 C152 143 166 138 171 125 C176 110 168 98 150 101 Z"},{"paint":"ribbon","d":"M18 108 L34 104 L36 120 C30 150 30 196 34 246 L27 238 L20 250 C16 200 16 150 18 108 Z"},{"paint":"ribbon","d":"M182 108 L166 104 L164 120 C170 150 170 196 166 246 L173 238 L180 250 C184 200 184 150 182 108 Z"},{"paint":"silver","d":"M46 78 L154 78 C154 120 146 160 124 184 C116 194 108 200 108 208 L92 208 C92 200 84 194 76 184 C54 160 46 120 46 78 Z"},{"paint":"silverDeep","d":"M46 78 L154 78 C154 84 154 88 153 92 L47 92 C46 88 46 84 46 78 Z"},{"paint":"silverLight","d":"M41 71 Q100 63 159 71 L159 80 Q100 88 41 80 Z"},{"paint":"silverDeep","d":"M50 74 Q100 67 150 74 Q100 79 50 74 Z"},{"paint":"shine","opacity":0.55,"d":"M64 96 C62 124 66 152 82 176 C70 156 66 128 70 96 Z"},{"paint":"shine","opacity":0.35,"d":"M128 98 C130 120 128 140 120 160 C126 140 130 120 132 98 Z"}]},"variants":{"legend":{"base":"club","paints":{"silver":"gold","silverLight":"goldLight","silverDeep":"goldDeep"}}}};
  const TIMING = {"seconds":6.5,"reduceMotionSeconds":4.5,"fadeOut":0.45,"chequeAt":1.9,"countUp":1.1};
  const WORDS = {"heading":"CHAMPIONS' CHEQUE","bank":"RALLYCADE","pay":"PAY","for":"FOR","payeeFallback":"The champion","signature":"RallyCade","signatureRole":"Tournament director","skipTV":"Raise a hand to continue"};
  const W = 1920, H = 1080;
  // StadiumResultScale.television(1920 x 1080): the phone's points to the stage's.
  const S = Math.max(0.8, Math.min(H / 430, W / 860));
  const TROPHIES = new Set(["world", "club", "legend"]);
  const CREAM = "#fcf5de", GOLD = "#ffc252";

  function clamp(x) { return Math.min(1, Math.max(0, x)); }
  function progress(t, start, duration) { return clamp((t - start) / duration); }
  function easeOut(p) { return 1 - Math.pow(1 - p, 3); }
  function easeOutBack(p) { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); }
  const LIFTED = 1.3;
  function rest() { return TIMING.chequeAt + 0.35 + TIMING.countUp + 0.4; }

  /** CupCelebrationMotion.pose: everything at `t` seconds of `total`. */
  function pose(t, total, reduced) {
    const fade = Math.min(progress(t, 0, reduced ? 0.3 : 0.35), 1 - progress(t, total - TIMING.fadeOut, TIMING.fadeOut));
    if (reduced) {
      return { fade, lift: 1, trophyOpacity: 1, bob: 0, shine: null, rays: 1, raysAngle: 0, words: [1, 1, 1],
        cheque: 1, count: 1, stamp: 0, hint: 1, sparkle: false };
    }
    let shine = null;
    for (const [start, length] of [[LIFTED, 0.85], [4.0, 0.75]]) if (t >= start && t <= start + length) { shine = (t - start) / length; break; }
    const countStart = TIMING.chequeAt + 0.35, landed = countStart + TIMING.countUp;
    return {
      fade, lift: easeOutBack(progress(t, 0.3, 1.0)), trophyOpacity: easeOut(progress(t, 0.3, 0.4)),
      bob: t > LIFTED ? Math.sin((t - LIFTED) * 1.7) * 3 : 0, shine,
      rays: easeOut(progress(t, 0.45, 0.9)), raysAngle: t * 7,
      words: [1.05, 1.18, 1.31].map((at) => easeOut(progress(t, at, 0.45))),
      cheque: easeOutBack(progress(t, TIMING.chequeAt, 0.6)),
      count: easeOut(progress(t, countStart, TIMING.countUp)),
      stamp: Math.sin(Math.PI * progress(t, landed, 0.35)),
      hint: easeOut(progress(t, 2.6, 0.5)), sparkle: t >= 1.0
    };
  }

  /** An amount as far as the count has got. */
  function counted(value, count) { return count >= 1 ? value : Math.floor(value * count); }
  function amount(value) { return Math.round(value).toLocaleString("en-US"); }
  /** CupCelebrationMotion.random: confetti piece `index`'s `k`th number in 0..<1. */
  function random(index, k) { const x = Math.sin(index * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); }

  /** A trophy's shapes with their paints (Legend: the Club Cup in gold). */
  function shapes(trophy) {
    if (ART.trophies[trophy]) return ART.trophies[trophy].map((shape) => ({ d: shape.d, paint: shape.paint, opacity: shape.opacity }));
    const variant = ART.variants[trophy];
    if (!variant) return [];
    return ART.trophies[variant.base].map((shape) => ({ d: shape.d, paint: variant.paints[shape.paint] || shape.paint, opacity: shape.opacity }));
  }

  /** The trophy as SVG markup in the art's 200 x 300 box, with a shine band
   *  (`#<id>-shine`, moved by the view) clipped to it. */
  function trophySVG(trophy, id) {
    const all = shapes(trophy);
    const paints = [...new Set(all.map((shape) => shape.paint))];
    const gradients = paints.map((paint) => `<linearGradient id="${id}-${paint}" x1="0" y1="0" x2="1" y2="0">` +
      (ART.paints[paint] || []).map(([offset, colour]) => `<stop offset="${offset}" stop-color="${colour}"/>`).join("") + "</linearGradient>").join("");
    const body = all.map((shape) => `<path d="${shape.d}" fill="url(#${id}-${shape.paint})"${shape.opacity != null ? ` opacity="${shape.opacity}"` : ""}/>`).join("");
    const clip = all.map((shape) => `<path d="${shape.d}"/>`).join("");
    const [w, h] = ART.viewBox;
    return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs>${gradients}` +
      `<clipPath id="${id}-clip">${clip}</clipPath><linearGradient id="${id}-band" x1="0" y1="0" x2="1" y2="0">` +
      `<stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.75"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>` +
      `${body}<g clip-path="url(#${id}-clip)" style="mix-blend-mode:screen"><polygon id="${id}-shine" points="0,0 64,0 -41,300 -105,300" fill="url(#${id}-band)" opacity="0"/></g></svg>`;
  }

  /** Where the trophy sits and how big, on the stage (CupCelebrationFrame). */
  function layout() {
    const trophyHeight = Math.min(H * 0.74, 320 * S);
    return { trophyHeight, centre: [W * 0.29, H * 0.47], column: Math.min(400 * S, W * 0.44), columnCentre: [W * 0.70, H * 0.48] };
  }

  /** Confetti on the stage's canvas at `t` (CupCelebrationFrame.confetti). */
  function drawConfetti(context, t, colours, origin) {
    const h = H;
    for (let index = 0; index < 110; index += 1) {
      const r = (k) => random(index, k);
      const burst = index < 70;
      const start = burst ? 1.0 + r(0) * 0.18 : 1.5 + r(0) * 3.2;
      const age = t - start;
      if (age <= 0) continue;
      let x, y;
      if (burst) {
        const vx = (r(1) - 0.5) * 1.5 * h, vy = -(0.75 + r(2) * 0.75) * h, gravity = 1.25 * h;
        x = origin[0] + vx * age * (1 - Math.min(0.5, age * 0.12)); y = origin[1] + vy * age + gravity * age * age / 2;
      } else {
        x = r(1) * W + Math.sin(age * (1.5 + r(3) * 2)) * 18 * S; y = -0.04 * h + (0.22 + r(2) * 0.18) * h * age;
      }
      if (y > h + 20 || y < -h) continue;
      const piece = (6 + r(4) * 6) * S;
      context.save();
      context.globalAlpha = Math.min(1, age * 4) * (burst ? Math.max(0, 1 - Math.max(0, age - 2.6) / 0.8) : 1);
      context.translate(x, y);
      context.rotate(r(6) * Math.PI * 2 + (r(5) - 0.5) * 12 * age);
      context.scale(Math.cos(age * (4 + r(7) * 5)), 1);
      context.fillStyle = colours[Math.floor(r(8) * colours.length) % colours.length];
      if (r(9) < 0.25) { context.beginPath(); context.arc(0, 0, piece * 0.35, 0, Math.PI * 2); context.fill(); }
      else context.fillRect(-piece / 2, -piece * 0.3, piece, piece * 0.6);
      context.restore();
    }
  }

  /** Sparkles on the trophy, twinkling in turn. `box`: the trophy's [x, y, w, h]. */
  function drawSparkles(context, t, box) {
    const spots = [[0.22, 0.10], [0.80, 0.18], [0.52, 0.02], [0.10, 0.42], [0.92, 0.48], [0.66, 0.30]];
    context.save();
    context.globalCompositeOperation = "lighter";
    spots.forEach(([sx, sy], index) => {
      const phase = (t - 1.0 - index * 0.37) / 1.4;
      const glint = Math.pow(Math.max(0, Math.sin(2 * Math.PI * phase)), 3);
      if (glint <= 0.02) return;
      const cx = box[0] + box[2] * sx, cy = box[1] + box[3] * sy, radius = 11 * S * glint, inner = radius * 0.22;
      context.beginPath();
      for (let i = 0; i < 8; i += 1) {
        const angle = i * Math.PI / 4 - Math.PI / 2, rr = i % 2 === 0 ? radius : inner;
        const px = cx + Math.cos(angle) * rr, py = cy + Math.sin(angle) * rr;
        if (i === 0) context.moveTo(px, py); else context.lineTo(px, py);
      }
      context.closePath();
      context.fillStyle = `rgba(255,255,255,${(0.9 * glint).toFixed(3)})`;
      context.fill();
    });
    context.restore();
  }

  /** The confetti's colours: gold and cream, the country's kit, or the
   *  Club Cup's ribbon green. */
  function colours(celebration) {
    const kit = (celebration.colors || []).filter((c) => /^#[0-9a-fA-F]{6}$/.test(c));
    return [GOLD, CREAM, "#ffe699"].concat(kit.length ? kit : celebration.trophy === "world" ? [] : ["#1f8a52"]);
  }

  /**
   * The celebration on the page. `elements`: root, stage, canvas, dim, glow,
   * rays, floor, trophy, words, eyebrow, title, subtitle, cheque, payee, xp,
   * coins, memo, note, seal, hint, confetti. `now()` in ms; `requestFrame`
   * and `cancelFrame` drive it.
   */
  function createCelebrationView(options) {
    const e = options.elements;
    const now = options.now;
    let current = null, startedAt = 0, frameId = null, ending = 0, svgId = 0;
    const played = new Set();
    const layoutNow = layout();

    function fit() {
      if (!e.stage || !e.canvas) return;
      const width = e.stage.clientWidth || W;
      e.canvas.style.transform = `scale(${width / W})`;
    }

    function start(celebration) {
      current = celebration;
      startedAt = now() - celebration.elapsed;
      ending = 0;
      svgId += 1;
      const id = "cel" + svgId;
      e.trophy.innerHTML = trophySVG(celebration.trophy, id);
      e.seal.innerHTML = trophySVG(celebration.trophy, id + "s");
      e.trophy.dataset.shine = id + "-shine";
      e.eyebrow.textContent = celebration.eyebrow;
      e.title.textContent = celebration.title;
      e.subtitle.textContent = celebration.subtitle;
      e.payee.textContent = celebration.payee;
      e.memo.textContent = celebration.memo;
      e.note.textContent = celebration.note;
      e.root.hidden = false;
      fit();
      if (frameId === null) frameId = options.requestFrame(tick);
    }

    function apply(t) {
      const total = current.duration / 1000;
      const p = pose(t, total, current.reduced);
      // The phone ended it early: a quick fade from wherever it was.
      const out = ending ? 1 - clamp((now() - ending) / 350) : 1;
      e.root.style.opacity = String(Math.max(0, p.fade * out));
      const { trophyHeight, centre } = layoutNow;
      e.glow.style.opacity = String(p.rays);
      e.rays.style.opacity = String(p.rays);
      e.rays.style.transform = `translate(-50%, -50%) rotate(${p.raysAngle.toFixed(2)}deg)`;
      e.floor.style.opacity = String(clamp(p.lift));
      const height = trophyHeight * (0.82 + 0.18 * p.lift);
      const rise = (1 - p.lift) * H * 0.42 - p.bob * S;
      const box = [centre[0] - height / 3, centre[1] - height / 2 + rise, height * 2 / 3, height];
      e.trophy.style.opacity = String(p.trophyOpacity);
      e.trophy.style.transform = `translate(${box[0].toFixed(1)}px, ${box[1].toFixed(1)}px)`;
      e.trophy.style.width = box[2].toFixed(1) + "px";
      e.trophy.style.height = box[3].toFixed(1) + "px";
      const band = e.trophy.querySelector("#" + e.trophy.dataset.shine);
      if (band) {
        band.setAttribute("opacity", p.shine == null ? "0" : "1");
        if (p.shine != null) band.setAttribute("transform", `translate(${(-64 + (200 + 128) * p.shine).toFixed(1)}, 0)`);
      }
      [e.eyebrow, e.title, e.subtitle].forEach((node, index) => {
        node.style.opacity = String(p.words[index]);
        node.style.transform = `translateY(${((1 - p.words[index]) * 14 * S).toFixed(1)}px)`;
      });
      e.cheque.style.opacity = String(clamp(p.cheque * 1.4));
      e.cheque.style.transform = `translate(${((1 - p.cheque) * 90 * S).toFixed(1)}px, ${((1 - p.cheque) * 40 * S).toFixed(1)}px) rotate(${(-2 + (1 - p.cheque) * 9).toFixed(2)}deg)`;
      e.xp.textContent = "+" + amount(counted(current.xp, p.count)) + " XP";
      e.coins.textContent = "+" + amount(counted(current.coins, p.count)) + " coins";
      e.coins.style.transform = `scale(${(1 + 0.14 * p.stamp).toFixed(3)})`;
      e.hint.style.opacity = String(p.hint);
      const context = e.confetti && e.confetti.getContext && e.confetti.getContext("2d");
      if (context) {
        context.clearRect(0, 0, W, H);
        if (p.sparkle) {
          drawSparkles(context, t, box);
          drawConfetti(context, t, colours(current), [centre[0], centre[1] - trophyHeight * 0.3]);
        }
      }
      return t < total && out > 0;
    }

    function tick() {
      frameId = null;
      if (!current) return;
      const on = apply((now() - startedAt) / 1000);
      if (on) frameId = options.requestFrame(tick);
      else stop();
    }

    function stop() {
      if (frameId !== null) options.cancelFrame(frameId);
      frameId = null;
      current = null;
      ending = 0;
      e.root.hidden = true;
    }

    /** Every state from the phone: a new celebration starts where the
     *  phone is in it; none (the phone ended it) fades it out. */
    function update(state) {
      const celebration = state && state.result && state.result.celebration;
      if (!celebration) { if (current && !ending) ending = now(); return; }
      if (current && current.id === celebration.id) return;
      if (played.has(celebration.id)) return;
      played.add(celebration.id);
      start(celebration);
    }

    return { update, tick, stop, playing: () => current, poseAt: (t) => (current ? pose(t, current.duration / 1000, current.reduced) : null) };
  }

  return { ART, TIMING, WORDS, W, H, S, pose, counted, amount, random, shapes, trophySVG, layout, colours, createCelebrationView, rest };
});
