(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RallycadePickleballCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Pickleball on the TV (receiver 74, Oct 27 2026; docs/design/CAST_SCENE.md
  // "Pickleball on the TV"). The phone sends each moment of its match as the
  // court's drawing operations (iOS PickleballCastScene, Android core
  // PickleballCastWire from PickleballCourtArt.scene), on a 1280 x 720 stage,
  // and the TV draws them with its own copies of the court photograph and the
  // keyed player sheets (CastReceiver/pickleball/, made by
  // scripts/pickleball/cast/export-receiver-art.sh).
  //
  // Numbers are whole: stage coordinates in tenths of a point, sheet pixels
  // in tenths, opacities in thousandths, a sprite's scale in ten-thousandths.
  //
  //   ["P", x, y, w, h]                         the court photograph in its rect
  //   ["S", x, y, w, h, a]                      a player's contact shadow (ellipse, black)
  //   ["p", sheet, frame, cx, cy, cw, ch, fx, fy, ax, ay, scale, mirrored, a]
  //                                             a sprite: the sheet's cell, its feet (cell pixels) at the anchor
  //   ["B", cx, cy, r, sx, sy, sw, sh, sa, tw, tx?, ty?]
  //                                             the ball: its shadow ellipse, a trail from (tx, ty) when fast
  //   ["N", a, x, y, w, h, x0, y0, x1, y1, ...] the photograph's net over a far ball: the plate's rect, the band
  //   ["F", cx, cy, r, a, blur]                 the contact flash (a glow)
  //   ["R", x, y, w, h, a, lw]                  the contact ring (ellipse, white)
  //   ["V", x, y, w, h]                         (receiver 78) a same-phone split screen's half: the ops after it, up
  //                                             to the next "V", are that half's, clipped to its rectangle; its "P" is
  //                                             that half's photograph
  const STAGE = { width: 1280, height: 720 };
  // The HUD's stage (receiver 75; the owner on 238: "Why is the scoreboard so
  // small now?"): phone height, 440 points tall and the TV's 16:9 wide, where
  // the phone's HUD keeps its sizes, scaled up to the TV, so the score bug,
  // banner and callout take the share of the screen they take on the phone
  // (as TVPickleballView's hudScale on an AirPlay TV).
  const HUD_STAGE = { width: 440 * 16 / 9, height: 440 };
  // 2 (receiver 78): play with friends: the players' names, sheets in each player's kit, and the split screen.
  const VERSION = 2;
  const BALL = { light: [245, 255, 140], body: [219, 240, 51], dark: [153, 173, 20] };
  const FLASH = [255, 245, 199];
  // Frames further apart than this are never blended (a pause, a redraw).
  const MAX_BLEND_GAP = 160;
  // How far behind the phone the TV draws: enough for a frame to arrive
  // (the trip and its jitter) and the next to blend toward.
  const DELAY = { start: 100, least: 60, most: 220, margin: 12, window: 90 };

  const KINDS = new Set(["P", "S", "p", "B", "N", "F", "R", "V"]);
  const n = (v) => Number(v) / 10;

  // A wire op as drawing values (stage points, 0–1 opacities).
  function decodeOp(op) {
    if (!Array.isArray(op) || !KINDS.has(op[0])) return null;
    switch (op[0]) {
      case "P": return { kind: "P", x: n(op[1]), y: n(op[2]), w: n(op[3]), h: n(op[4]) };
      case "S": return { kind: "S", x: n(op[1]), y: n(op[2]), w: n(op[3]), h: n(op[4]), a: op[5] / 1000 };
      case "p": return { kind: "p", sheet: String(op[1]), frame: op[2] | 0, cx: n(op[3]), cy: n(op[4]), cw: n(op[5]), ch: n(op[6]),
        fx: n(op[7]), fy: n(op[8]), ax: n(op[9]), ay: n(op[10]), scale: op[11] / 10000, mirrored: op[12] === 1, a: op[13] / 1000 };
      case "B": return { kind: "B", cx: n(op[1]), cy: n(op[2]), r: n(op[3]), sx: n(op[4]), sy: n(op[5]), sw: n(op[6]), sh: n(op[7]),
        sa: op[8] / 1000, tw: n(op[9]), trail: op.length >= 12 ? { x: n(op[10]), y: n(op[11]) } : null };
      case "N": {
        const band = [];
        for (let i = 6; i + 1 < op.length; i += 2) band.push({ x: n(op[i]), y: n(op[i + 1]) });
        return { kind: "N", a: op[1] / 1000, x: n(op[2]), y: n(op[3]), w: n(op[4]), h: n(op[5]), band };
      }
      case "F": return { kind: "F", cx: n(op[1]), cy: n(op[2]), r: n(op[3]), a: op[4] / 1000, blur: n(op[5]) };
      case "R": return { kind: "R", x: n(op[1]), y: n(op[2]), w: n(op[3]), h: n(op[4]), a: op[5] / 1000, lw: n(op[6]) };
      case "V": return { kind: "V", x: n(op[1]), y: n(op[2]), w: n(op[3]), h: n(op[4]) };
    }
    return null;
  }

  // A split screen's halves (each "V" and the ops after it), or null for one court.
  function halves(ops) {
    if (!ops.some((op) => op && op.kind === "V")) return null;
    const out = [];
    for (const op of ops) {
      if (!op) continue;
      if (op.kind === "V") out.push({ rect: op, ops: [] });
      else if (out.length) out[out.length - 1].ops.push(op);
    }
    return out;
  }

  // What must be equal for two ops to blend number by number: the kind, and a
  // sprite's sheet, picture and mirroring; a ball with and without a trail differ.
  function opShape(op) {
    if (!Array.isArray(op)) return "";
    if (op[0] === "p") return "p" + op[1] + "/" + op[2] + "/" + op[12];
    if (op[0] === "B") return "B" + op.length;
    if (op[0] === "N") return "N" + op.length;
    return op[0];
  }

  // Blends two frames' ops: those that match (same index, same shape) number
  // by number; the rest as the earlier frame has them. Different lists (a
  // ball appearing, a flash ending) draw the earlier frame's.
  function blendOps(a, b, u) {
    if (!b || u <= 0 || a.length !== b.length) return a;
    const out = new Array(a.length);
    for (let i = 0; i < a.length; i += 1) {
      const x = a[i], y = b[i];
      if (opShape(x) !== opShape(y)) { out[i] = x; continue; }
      const op = x.slice();
      for (let j = 1; j < x.length; j += 1) {
        if (typeof x[j] === "number" && typeof y[j] === "number" && !(x[0] === "p" && (j === 2 || j === 12))) op[j] = x[j] + (y[j] - x[j]) * u;
      }
      out[i] = op;
    }
    return out;
  }

  function blendPush(a, b, u) {
    if (!a) return null;
    if (!b) return a;
    return a.map((v, i) => v + (b[i] - v) * u);
  }

  // The p-th percentile (0..1).
  function percentile(values, p) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((x, y) => x - y);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  }

  // Frames on the phone's clock, shown `delay` behind it. `add(frame, local)`
  // as each arrives (local: the TV's performance.now()); `at(local)` the
  // frame to draw now. Before the phone's `sync`, the first frame's arrival
  // stands in for the clocks' offset.
  function createPlayout(options) {
    const keepMs = (options && options.keepMs) || 2000;
    let frames = [];
    let huds = [];
    let offset = null, provisional = null;
    let delay = DELAY.start;
    let late = [];
    let lateCount = 0, received = 0;
    function phoneTime(local) {
      const o = offset !== null ? offset : provisional;
      return o === null ? null : local - o;
    }
    return {
      get delay() { return delay; },
      get synced() { return offset !== null; },
      get frames() { return frames; },
      get counts() { return { received, late: lateCount }; },
      setOffset(value) { if (Number.isFinite(Number(value))) offset = Number(value); },
      phoneTime,
      add(frame, local) {
        if (!frame || !Number.isFinite(Number(frame.s)) || !Array.isArray(frame.o)) return false;
        received += 1;
        if (offset === null && provisional === null) provisional = local - frame.s;
        const arrived = phoneTime(local);
        if (arrived !== null) {
          const lateness = arrived - frame.s;
          late.push(lateness);
          if (late.length > DELAY.window) late.shift();
          if (lateness > delay) lateCount += 1;
        }
        // A frame for a moment already held replaces it (the phone redrew it).
        frames = frames.filter((f) => f.s !== frame.s);
        frames.push(frame);
        frames.sort((x, y) => x.s - y.s);
        if (frame.h) {
          huds = huds.filter((h) => h.s !== frame.s);
          huds.push({ s: frame.s, h: frame.h });
          huds.sort((x, y) => x.s - y.s);
        }
        const newest = frames[frames.length - 1].s;
        frames = frames.filter((f) => f.s >= newest - keepMs);
        // The newest HUD before the oldest frame kept still applies.
        const kept = huds.filter((h) => h.s >= newest - keepMs);
        const before = huds.filter((h) => h.s < newest - keepMs).pop();
        huds = before ? [before].concat(kept) : kept;
        return true;
      },
      // The delay the arrivals ask for: their 90th percentile lateness, a
      // frame to blend toward and a margin, within DELAY's bounds.
      target(frameGap) {
        if (late.length < 8) return DELAY.start;
        const want = percentile(late, 0.9) + (frameGap || 33) + DELAY.margin;
        return Math.max(DELAY.least, Math.min(DELAY.most, want));
      },
      // Moves the delay toward `target` a little each drawn frame: up quickly
      // (late frames freeze the picture), down slowly (each step is a skip).
      settle(target) {
        if (target > delay) delay = Math.min(target, delay + 4);
        else if (target < delay) delay = Math.max(target, delay - 0.5);
        return delay;
      },
      setDelay(value) { delay = value; },
      // The moment shown at `local`, the frame for it (blended) and how old
      // the picture is against the phone (`stale`, ms).
      at(local) {
        const now = phoneTime(local);
        if (now === null || !frames.length) return null;
        const t = now - delay;
        let index = -1;
        for (let i = 0; i < frames.length; i += 1) if (frames[i].s <= t) index = i;
        const a = frames[Math.max(0, index)];
        const b = index >= 0 ? frames[index + 1] : null;
        let u = 0;
        if (b && b.s - a.s <= MAX_BLEND_GAP) u = Math.max(0, Math.min(1, (t - a.s) / (b.s - a.s)));
        const ops = u > 0 ? blendOps(a.o, b.o, u) : a.o;
        const push = u > 0 ? blendPush(a.k, b.k, u) : (a.k || null);
        let hud = null;
        for (const entry of huds) if (entry.s <= Math.max(t, a.s)) hud = entry.h;
        if (!hud && huds.length) hud = huds[0].h;
        const shown = index >= 0 ? (b ? t : a.s) : a.s;
        return { moment: t, frame: a, ops, push, hud, stale: now - shown, ahead: frames.filter((f) => f.s > t).length };
      },
      reset() { frames = []; huds = []; offset = null; provisional = null; delay = DELAY.start; late = []; lateCount = 0; received = 0; }
    };
  }

  // MARK: Drawing

  // Where the court photograph sits: aspect fill anchored at the bottom
  // (PickleballCourtArt.plateLayout), for a stage of `width` x `height`.
  function plateLayout(plate, width, height) {
    const scale = Math.max(width / plate[0], height / plate[1]);
    const x = (width - plate[0] * scale) / 2, y = height - plate[1] * scale;
    return { x, y, w: plate[0] * scale, h: plate[1] * scale, scale };
  }

  function ellipse(ctx, x, y, w, h) {
    ctx.beginPath();
    if (ctx.ellipse) ctx.ellipse(x + w / 2, y + h / 2, Math.max(0, w / 2), Math.max(0, h / 2), 0, 0, Math.PI * 2);
    else ctx.arc(x + w / 2, y + h / 2, Math.max(0, w / 2), 0, Math.PI * 2);
  }

  const rgba = (c, a) => "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + Math.max(0, Math.min(1, a)).toFixed(4) + ")";

  // The ops' bounds (stage points), for clearing only what was drawn.
  function opBounds(op, plateRect) {
    switch (op.kind) {
      case "P": return { x: op.x, y: op.y, w: op.w, h: op.h };
      case "V": return null;
      case "S": case "R": {
        const pad = op.kind === "R" ? op.lw : 0;
        return { x: op.x - pad, y: op.y - pad, w: op.w + pad * 2, h: op.h + pad * 2 };
      }
      case "p": {
        const left = op.mirrored ? op.ax - (op.cw - op.fx) * op.scale : op.ax - op.fx * op.scale;
        return { x: left, y: op.ay - op.fy * op.scale, w: op.cw * op.scale, h: op.ch * op.scale };
      }
      case "B": {
        let x0 = Math.min(op.cx - op.r * 1.3, op.sx), y0 = Math.min(op.cy - op.r * 1.3, op.sy);
        let x1 = Math.max(op.cx + op.r * 1.3, op.sx + op.sw), y1 = Math.max(op.cy + op.r * 1.3, op.sy + op.sh);
        if (op.trail) { x0 = Math.min(x0, op.trail.x - op.tw); y0 = Math.min(y0, op.trail.y - op.tw); x1 = Math.max(x1, op.trail.x + op.tw); y1 = Math.max(y1, op.trail.y + op.tw); }
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      case "N": {
        const xs = op.band.map((p) => p.x), ys = op.band.map((p) => p.y);
        if (!xs.length) return null;
        return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      }
      case "F": { const r = op.r + op.blur * 2.5; return { x: op.cx - r, y: op.cy - r, w: r * 2, h: r * 2 }; }
    }
    return plateRect || null;
  }

  // Draws decoded ops into `ctx` (already scaled to stage points).
  // `picture(sheet)` answers {image, scale} (scale: the file's pixels per
  // phone sheet pixel) or null; `plate` the court photograph (an image) or
  // null. `withPlate` false leaves the "P" op to a layer under the canvas.
  // Returns how many sprites it could not draw (pictures not loaded).
  function drawOps(ctx, ops, picture, plate, withPlate) {
    let missing = 0;
    let clipped = false;
    for (const op of ops) {
      if (!op) continue;
      switch (op.kind) {
        case "V":
          // A split screen's half: what follows stays inside it.
          if (clipped) ctx.restore();
          ctx.save();
          ctx.beginPath(); ctx.rect(op.x, op.y, op.w, op.h); ctx.clip();
          clipped = true;
          break;
        case "P":
          if (withPlate) {
            if (plate) ctx.drawImage(plate, op.x, op.y, op.w, op.h);
            else { ctx.fillStyle = "rgb(26,77,153)"; ctx.fillRect(op.x, op.y, op.w, op.h); }
          }
          break;
        case "S":
          ctx.fillStyle = rgba([0, 0, 0], op.a);
          ellipse(ctx, op.x, op.y, op.w, op.h); ctx.fill();
          break;
        case "p": {
          const art = picture(op.sheet);
          if (!art || !art.image) { missing += 1; break; }
          const k = art.scale;
          ctx.save();
          ctx.globalAlpha = Math.max(0, Math.min(1, op.a));
          ctx.translate(op.ax, op.ay);
          if (op.mirrored) ctx.scale(-1, 1);
          ctx.drawImage(art.image, op.cx * k, op.cy * k, op.cw * k, op.ch * k, -op.fx * op.scale, -op.fy * op.scale, op.cw * op.scale, op.ch * op.scale);
          ctx.restore();
          break;
        }
        case "B": {
          ctx.fillStyle = rgba([0, 0, 0], op.sa);
          ellipse(ctx, op.sx, op.sy, op.sw, op.sh); ctx.fill();
          if (op.trail) {
            ctx.save();
            ctx.strokeStyle = rgba(BALL.body, 0.35); ctx.lineWidth = op.tw; ctx.lineCap = "round";
            ctx.beginPath(); ctx.moveTo(op.trail.x, op.trail.y); ctx.lineTo(op.cx, op.cy); ctx.stroke();
            ctx.restore();
          }
          const gx = op.cx - op.r * 0.35, gy = op.cy - op.r * 0.35;
          const gradient = ctx.createRadialGradient(gx, gy, 0, gx, gy, Math.max(0.01, op.r * 1.3));
          gradient.addColorStop(0, rgba(BALL.light, 1)); gradient.addColorStop(0.5, rgba(BALL.body, 1)); gradient.addColorStop(1, rgba(BALL.dark, 1));
          ctx.fillStyle = gradient;
          ellipse(ctx, op.cx - op.r, op.cy - op.r, op.r * 2, op.r * 2); ctx.fill();
          break;
        }
        case "N": {
          if (!plate || op.band.length < 3) break;
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(op.band[0].x, op.band[0].y);
          for (let i = 1; i < op.band.length; i += 1) ctx.lineTo(op.band[i].x, op.band[i].y);
          ctx.closePath(); ctx.clip();
          ctx.globalAlpha = op.a;
          ctx.drawImage(plate, op.x, op.y, op.w, op.h);
          ctx.restore();
          break;
        }
        case "F": {
          // StadiumCanvas.fillGlow: a disc blurred by `blur` as one radial gradient.
          const outer = Math.max(0.5, op.r + op.blur * 2.5);
          const at = (d) => Math.min(1, Math.max(0, d / outer));
          const gradient = ctx.createRadialGradient(op.cx, op.cy, 0, op.cx, op.cy, outer);
          const stops = [[0, 1], [op.r - op.blur * 2, 0.98], [op.r - op.blur, 0.84], [op.r, 0.5], [op.r + op.blur, 0.16], [op.r + op.blur * 2, 0.02], [outer, 0]];
          for (const [d, share] of stops) gradient.addColorStop(at(d), rgba(FLASH, op.a * share));
          ctx.fillStyle = gradient;
          ellipse(ctx, op.cx - outer, op.cy - outer, outer * 2, outer * 2); ctx.fill();
          break;
        }
        case "R":
          ctx.save();
          ctx.strokeStyle = rgba([255, 255, 255], op.a); ctx.lineWidth = op.lw;
          ellipse(ctx, op.x, op.y, op.w, op.h); ctx.stroke();
          ctx.restore();
          break;
      }
    }
    if (clipped) ctx.restore();
    return missing;
  }

  // MARK: The HUD

  const TONES = { good: "#ffc252", bad: "#ff8c80", call: "#fcf5de", neutral: "#fcf5de" };
  const CALLOUT_SECONDS = 1.2;

  // What the HUD shows at phone moment `t` (ms) from the phone's `h`:
  // { you, cpu, serving: "you"|"cpu", band: [title, value], banner?, callout? }.
  function bannerView(b) {
    if (!b || !b.tx) return undefined;
    return { text: String(b.tx), tone: TONES[b.tone] ? b.tone : "neutral", color: TONES[b.tone] || TONES.neutral,
      x: Number(b.x) || 0, y: Number(b.y) || 0, width: Number(b.w) || 340, fontSize: Number(b.f) || 16 };
  }

  function calloutView(c, t) {
    if (!c || !c.tx || !Number.isFinite(Number(c.at))) return undefined;
    const age = (t - Number(c.at)) / 1000;
    if (age < 0 || age >= CALLOUT_SECONDS) return undefined;
    const parts = String(c.tx).split(" · ");
    const grade = parts.slice(1).join(" · ");
    return { title: parts[0], grade, good: grade === "Perfect" || grade === "Good", leading: c.l === 1,
      alpha: Math.max(0, Math.min(1, age / 0.12, (CALLOUT_SECONDS - age) / 0.35)), lift: -8 * Math.min(1, age / 0.2) };
  }

  // A score row's name: the phone's (a friend's, "PLAYER 1"), or the computer match's own.
  const rowName = (names, i, fallback) => Array.isArray(names) && typeof names[i] === "string" && names[i] ? names[i].slice(0, 16) : fallback;

  function hudView(h, t) {
    if (!h) return null;
    const view = {
      you: Number(h.you) || 0, cpu: Number(h.cpu) || 0, serving: h.srv === "c" ? "cpu" : "you",
      band: [String(h.lt || "LEVEL"), String(h.lv || "")],
      names: [rowName(h.nm, 0, "YOU"), rowName(h.nm, 1, "COMPUTER")], split: h.sp === 1
    };
    const banner = bannerView(h.ban), banner2 = bannerView(h.ban2);
    if (banner) view.banner = banner;
    if (banner2) view.banner2 = banner2;
    const callout = calloutView(h.call, t), callout2 = calloutView(h.call2, t);
    if (callout) view.callout = callout;
    if (callout2) view.callout2 = callout2;
    return view;
  }

  // MARK: Words of the cards

  // The ready card (the setup on the phone, and the court still loading).
  function readyView(ready, loading) {
    const r = ready || {};
    return {
      eyebrow: String(r.eyebrow || "PICKLEBALL · SINGLES · BETA"),
      title: loading ? "Getting the court ready" : String(r.title || "Get ready on your phone"),
      detail: loading ? "The match starts on your phone; the TV joins in a moment." : String(r.detail || "Step into view, then raise a hand to start."),
      line: String(r.line || "")
    };
  }

  // The result card: the phone's result screen's words (PickleballResultText).
  function resultView(result) {
    const r = result || {};
    const stats = Array.isArray(r.stats) ? r.stats.filter((s) => Array.isArray(s) && s.length >= 2).slice(0, 6).map((s) => ({ title: String(s[0]), value: String(s[1]) })) : [];
    return {
      eyebrow: String(r.eyebrow || ""), headline: String(r.headline || "Match over"),
      you: Number(r.you) || 0, cpu: Number(r.cpu) || 0, won: r.won === 1,
      names: [rowName(r.names, 0, "YOU"), rowName(r.names, 1, "COMPUTER")],
      story: String(r.story || ""), coaching: String(r.coaching || ""), stats
    };
  }

  // MARK: Pictures

  // The pictures a look needs (manifest.json `sheets`, each with its `look`).
  // Receiver 78: and the sheets the phone names (`sheets`: a friend's look, each player's kit), those the TV has.
  function sheetsFor(manifest, look, named) {
    const sheets = (manifest && manifest.sheets) || {};
    const want = new Set(Object.keys(sheets).filter((name) => sheets[name].look === (look === "woman" ? "woman" : "man") && !sheets[name].kit));
    if (Array.isArray(named)) for (const name of named) if (typeof name === "string" && sheets[name]) want.add(name);
    return [...want].sort();
  }

  return {
    STAGE, HUD_STAGE, VERSION, DELAY, MAX_BLEND_GAP, CALLOUT_SECONDS, BALL,
    decodeOp, halves, opShape, blendOps, blendPush, percentile, createPlayout, plateLayout, opBounds, drawOps, hudView, readyView, resultView,
    sheetsFor
  };
});
