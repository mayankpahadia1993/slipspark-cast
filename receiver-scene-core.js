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
  // "B" marks where the live batter goes (receiver 51): the phone draws the
  // frame ahead but the batter for now, in its own message ("b").
  const OPS = new Set(["f", "s", "i", "t", "L", "l", "B"]);
  // Fields that name things rather than measure them: never blended, and a
  // difference means the frames are not the same shapes.
  const DISCRETE = {
    f: [2, 3, 6, 7, 8],
    s: [2, 3, 9, 10],
    i: [2, 3, 5, 6],
    t: [2, 3, 5, 6, 10],
    L: [2, 3, 4],
    l: [],
    B: []
  };
  // Frames further apart than this are not blended: something happened between.
  const MAX_BLEND_GAP = 120;
  // Frames kept behind the one on screen, and the most queued ahead.
  const MAX_QUEUE = 90;

  function isArray(value) { return Array.isArray(value); }

  // MARK: The bowler's-end inset (Oct 20 2026, ready's `inset: 1`)

  // The phone sends the inset as one command (iOS BowlerEndInsetArt.command,
  // Android core BowlersEndInset.command): ["N", A, [x, y, w, h], plate key,
  // parts far to near], its ~17 drawing commands a frame having taken the
  // Cast channel past 300 KB/s. Drawn here as the phone draws it: the
  // backing, the plate's view, the parts, the frame and its label. Parts:
  // ["i", key, matrix, A] a picture; ["e", [cx, cy, rx, ry], C] a filled
  // ellipse; ["w", [x, y, height, gap, width, outline, bail], splay, bails]
  // the stumps; ["o", [cx, cy, r, ring], [sx, sy]] the ball and its shadow.
  // A frame whose inset is unchanged says ["n"]: the last command's drawing, kept here (frames are read in the
  // order the phone sent them; it sends the command whole after a redraw, a lost frame and every 15 frames).
  let heldInset = null;
  let heldInsetAt = 0;
  let insetBetween = [];

  // A frame that said "~", `u` of the way from the command before it to the one after: each command whose shape is
  // the same (the same pictures, the same paths) drawn between the two, number by number; any other as before.
  function interpolateInset(waiting, from, fromAt, to, toAt) {
    if (from.length !== to.length || !(toAt > fromAt)) return;
    const u = Math.max(0, Math.min(1, (waiting.s - fromAt) / (toAt - fromAt)));
    for (let index = 0; index < from.length; index += 1) {
      const a = from[index], b = to[index];
      if (shapeKey({ o: [a], fl: [], cl: [] }) !== shapeKey({ o: [b], fl: [], cl: [] })) continue;
      const discrete = DISCRETE[a[0]] || [];
      const op = new Array(a.length);
      op[0] = a[0];
      for (let field = 1; field < a.length; field += 1) op[field] = discrete.indexOf(field) >= 0 ? a[field] : blendValue(a[field], b[field], u);
      waiting.ops[waiting.start + index] = op;
    }
  }
  const INSET_PLATE_WIDTH = 660;
  const INSET_INK = [18, 43, 38];
  const INSET_CREAM = [252, 245, 222];
  const INSET_BALL = [[0, [255, 107, 92, 1000]], [500, [255, 92, 82, 1000]], [1000, [128, 20, 20, 1000]]];

  function insetEllipse(cx, cy, rx, ry) {
    const k = 0.5523;
    return ["MCCCCZ", [cx + rx, cy, cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry, cx - rx * k, cy + ry, cx - rx, cy + ry * k,
      cx - rx, cy, cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry, cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy]
      .map((v) => Math.round(v * 10))];
  }

  function insetRounded(x, y, w, h, r) {
    const k = 0.5523;
    return ["MLCLCLCLCZ", [x + r, y, x + w - r, y, x + w - r + r * k, y, x + w, y + r - r * k, x + w, y + r, x + w, y + h - r,
      x + w, y + h - r + r * k, x + w - r + r * k, y + h, x + w - r, y + h, x + r, y + h, x + r - r * k, y + h, x, y + h - r + r * k,
      x, y + h - r, x, y + r, x, y + r - r * k, x + r - r * k, y, x + r, y].map((v) => Math.round(v * 10))];
  }

  function expandInset(op, out) {
    const rect = op[2], parts = op[4];
    if (!isArray(rect) || rect.length < 4 || !isArray(parts)) return;
    const [x, y, w, h] = rect.map((v) => Number(v) / 10);
    if (!(w > 0) || !(h > 0) || ![x, y].every(Number.isFinite)) return;
    const alpha = Math.max(0, Math.min(1000, Number(op[1]) || 0)) / 1000;
    const A = (share) => Math.round(Math.max(0, Math.min(1, alpha * share)) * 1000);
    const P = (v) => Math.round(v * 10);
    const k = w / INSET_PLATE_WIDTH, edge = Math.max(1, h * 0.018);
    const fill = (shape, color, share) => ["f", A(share == null ? 1 : share), "source-over", shape[0], shape[1], ["c", color], 0, -1, -1];
    const line = (points, color, width, cap) => ["s", A(1), "source-over", "ML", points.map(P), ["c", color], [P(width), cap, 0, P(10)], [], 0, -1, -1];
    out.push(fill(insetRounded(x - edge, y - edge, w + edge * 2, h + edge * 2, edge * 2), INSET_INK.concat(920)));
    if (typeof op[3] === "string") out.push(["i", A(1), "source-over", op[3], [Math.round(k * 10000), 0, 0, Math.round(k * 10000), P(x), P(y)], -1, -1]);
    for (const part of parts) {
      if (!isArray(part)) continue;
      if (part[0] === "i" && typeof part[1] === "string" && isArray(part[2]) && part[2].length === 6) {
        out.push(["i", A((part[3] == null ? 1000 : Number(part[3])) / 1000), "source-over", part[1], part[2], -1, -1]);
      } else if (part[0] === "e" && isArray(part[1]) && part[1].length === 4 && isArray(part[2])) {
        const [cx, cy, rx, ry] = part[1].map((v) => Number(v) / 10);
        out.push(fill(insetEllipse(cx, cy, rx, ry), part[2]));
      } else if (part[0] === "w" && isArray(part[1]) && part[1].length === 7) {
        const [bx, by, height, gap, width, outline, bail] = part[1].map((v) => Number(v) / 10);
        const splay = Number(part[2]) / 1000 || 0, bails = Number(part[3]) / 1000 || 0;
        for (let index = -1; index <= 1; index += 1) {
          const sx = bx + index * gap, lean = index === 0 ? splay : splay * 0.35 * index;
          const top = [sx + lean * height, by - height * (1 - Math.abs(lean) * 0.5)];
          out.push(line([sx, by].concat(top), [0, 0, 0, 350], outline, 0));
          out.push(line([sx, by].concat(top), INSET_CREAM.concat(1000), width, 0));
        }
        const top = by - height - height * 0.012 / 0.711, half = gap + width / 2;
        if (splay < 0.02 && bails < 0.02) {
          out.push(line([bx - half, top, bx + half, top], INSET_CREAM.concat(950), bail, 1));
        } else {
          [[0, -1], [1, 1]].forEach(([index, side]) => {
            const lift = bails * height * (0.9 + index * 0.35), drift = side * bails * gap * 2.5;
            const angle = bails * (index === 0 ? 3.2 : -2.6), length = gap * 0.7;
            const cx = bx + side * gap * 0.5 + drift, cy = top - lift;
            out.push(line([cx - Math.cos(angle) * length, cy - Math.sin(angle) * length, cx + Math.cos(angle) * length, cy + Math.sin(angle) * length],
              INSET_CREAM.concat(1000), bail, 1));
          });
        }
      } else if (part[0] === "o" && isArray(part[1]) && part[1].length === 4 && isArray(part[2]) && part[2].length === 2) {
        const [cx, cy, r, ring] = part[1].map((v) => Number(v) / 10);
        const [sx, sy] = part[2].map((v) => Number(v) / 10);
        out.push(fill(insetEllipse(sx, sy, r * 1.2, r * 0.35), [0, 0, 0, 300]));
        out.push(fill(insetEllipse(cx, cy, r + ring, r + ring), [255, 255, 255, 850]));
        out.push(["f", A(1), "source-over", ...insetEllipse(cx, cy, r, r),
          ["rg", [P(cx - r * 0.3), P(cy - r * 0.35), 0, P(r * 1.35)], INSET_BALL], 0, -1, -1]);
        // The seam: a short bright arc through the middle at 45 degrees.
        const length = r * 0.78, dx = Math.cos(Math.PI / 4) * length, dy = Math.sin(Math.PI / 4) * length;
        out.push(["s", A(1), "source-over", "MQ", [cx - dx, cy - dy, cx + dy * 0.3, cy - dx * 0.3, cx + dx, cy + dy].map(P),
          ["c", [255, 255, 255, 780]], [P(Math.max(k, r * 0.11)), 1, 0, P(10)], [], 0, -1, -1]);
      }
    }
    out.push(["s", A(0.85), "source-over", ...insetRounded(x, y, w, h, edge), ["c", INSET_CREAM.concat(1000)],
      [P(Math.max(1, edge * 0.6)), 0, 0, P(10)], [], 0, -1, -1]);
    out.push(["t", A(1), "source-over", "BOWLER'S END", P(Math.max(7, h * 0.085)), 800, 0, INSET_CREAM.concat(1000),
      [P(x + h * 0.06), P(y + h * 0.05)], [0, 0], -1]);
  }

  // A frame from the phone: `s` its moment (phone milliseconds), `o` the
  // commands, `fl` filter lists, `cl` clip lists, `h` the HUD when it changed,
  // `p` when the camera saw the pose its batter follows (phone milliseconds;
  // build 157 on). A live batter ("b") has the same members but `h`.
  function normalizeFrame(raw) {
    if (!raw || typeof raw !== "object" || !Number.isFinite(Number(raw.s)) || !isArray(raw.o)) return null;
    const ops = [];
    const moment = Number(raw.s);
    let insetSeen = false;
    for (const op of raw.o) {
      if (!isArray(op)) continue;
      if (op[0] === "N") {
        const start = ops.length;
        expandInset(op, ops);
        const fresh = ops.slice(start);
        // The frames that said "~" since the last command: between it and this one.
        if (heldInset) for (const waiting of insetBetween) interpolateInset(waiting, heldInset, heldInsetAt, fresh, moment);
        insetBetween = [];
        heldInset = fresh;
        heldInsetAt = moment;
        insetSeen = true;
      } else if (op[0] === "n" || op[0] === "~") {
        // "n": the inset as the last command drew it; "~": it moved, and the next command (sent at half the frame
        // rate) says where to, so it is drawn between the two when that arrives (the phone sends it whole at least
        // every 15 frames).
        if (!heldInset) continue;
        const start = ops.length;
        for (const held of heldInset) ops.push(held);
        if (op[0] === "~") insetBetween.push({ ops, start, s: moment });
        insetSeen = true;
      } else if (OPS.has(op[0])) ops.push(op);
    }
    if (!insetSeen) insetBetween = [];
    return {
      s: Number(raw.s),
      o: ops,
      fl: isArray(raw.fl) ? raw.fl : [],
      cl: isArray(raw.cl) ? raw.cl : [],
      h: raw.h && typeof raw.h === "object" ? raw.h : null,
      p: raw.p != null && Number.isFinite(Number(raw.p)) ? Number(raw.p) : null,
      // How far ahead of its pose the phone drew the live batter (ms,
      // receiver 55): it shows the hands that much later than `p`.
      ph: raw.ph != null && Number.isFinite(Number(raw.ph)) ? Math.max(0, Number(raw.ph)) : 0
    };
  }

  // A frame that stands alone (the receiver's rehearsal, receiver 65): its
  // inset commands drawn out, and nothing kept between frames, so the live
  // stream's inset ("n", "~") is never touched.
  function plainFrame(raw) {
    if (!raw || typeof raw !== "object" || !Number.isFinite(Number(raw.s)) || !isArray(raw.o)) return null;
    const ops = [];
    for (const op of raw.o) {
      if (!isArray(op)) continue;
      if (op[0] === "N") expandInset(op, ops);
      else if (OPS.has(op[0])) ops.push(op);
    }
    return { s: Number(raw.s), o: ops, fl: isArray(raw.fl) ? raw.fl : [], cl: isArray(raw.cl) ? raw.cl : [], h: null, p: null, ph: 0 };
  }

  // Whether a frame leaves its batter to the live layer.
  function hasLiveSlot(frame) {
    if (frame.__live === undefined) frame.__live = frame.o.some((op) => op[0] === "B");
    return frame.__live;
  }

  // Between two frames' poses, as between their moments.
  function blendPose(a, b, u) {
    return a.p != null && b.p != null ? a.p + (b.p - a.p) * u : a.p;
  }

  // The frame's shapes without their measurements: two frames with the same
  // key differ only in numbers, so they can be blended.
  function walkShape(value, parts) {
    if (isArray(value)) {
      parts.push("[" + value.length);
      for (let index = 0; index < value.length; index += 1) walkShape(value[index], parts);
      parts.push("]");
    } else if (typeof value === "string") {
      parts.push("'" + value);
    } else {
      parts.push("#");
    }
  }

  // One command's shape: its kind, what it names and how many numbers it has.
  const opShapes = new WeakMap();
  function opShape(op) {
    let shape = opShapes.get(op);
    if (shape !== undefined) return shape;
    const parts = [];
    const discrete = DISCRETE[op[0]] || [];
    parts.push("<" + op[0] + op.length);
    for (let index = 1; index < op.length; index += 1) {
      if (discrete.indexOf(index) >= 0 && !isArray(op[index])) parts.push("=" + op[index]);
      else if (op[0] === "s" && index === 6 && isArray(op[6])) parts.push("g" + op[6].length + ":" + op[6][1] + ":" + op[6][2]);
      else walkShape(op[index], parts);
    }
    shape = parts.join("");
    opShapes.set(op, shape);
    return shape;
  }

  function listsShape(frame) {
    const parts = ["|fl"];
    walkShape(frame.fl, parts);
    parts.push("|cl");
    for (const clip of frame.cl) {
      if (!isArray(clip)) { parts.push("?"); continue; }
      parts.push("{" + clip.length);
      for (const entry of clip) {
        if (isArray(entry)) { parts.push(String(entry[0]) + ":" + (isArray(entry[1]) ? entry[1].length : 0) + ":" + entry[2]); }
      }
    }
    return parts.join("");
  }

  function shapeKey(frame) {
    if (frame.__shape) return frame.__shape;
    const parts = [];
    for (const op of frame.o) parts.push(opShape(op));
    if (frame.__lists === undefined) frame.__lists = listsShape(frame);
    parts.push(frame.__lists);
    frame.__shape = parts.join("");
    return frame.__shape;
  }

  // MARK: Blending what matches (receiver 65)
  //
  // Oct 21 2026 (the owner: "lag with chromecast"; the batting-feel plan's TV
  // item): two frames whose shapes differed anywhere were not blended at all.
  // After contact that is nearly every pair: a running fielder's stride
  // picture changes every few frames, a trail comes and goes. So the struck
  // ball, the fielders and the camera stepped at the 25–30 frames a second the
  // phone sends while an onn drew 45–60. Now the commands of the frame due are
  // matched, in order, to the commands of the same shape in the next one (a
  // longest common run of shapes), and each match is blended toward its
  // partner; a command with no partner is drawn as it is. Never across a cut
  // (the photo that covers the stage changes: the stadium to the replay's
  // field), and never a match that would move further than `MAX_STEP` between
  // two frames (two fielders of the same picture trading places in the
  // drawing order would otherwise slide into each other).
  const MAX_STEP = 2000;
  // The most cells the matching may use: frames of ~60 commands need 3,600.
  const MAX_MATCH_CELLS = 40000;

  // The photo that covers the stage (the stadium, the replay's outfield):
  // the key of the last plain top-level picture whose rect, from its key's
  // size, covers the whole stage. Null when none does.
  function viewOf(frame) {
    if (frame.__view !== undefined) return frame.__view;
    let depth = 0;
    let view = null;
    for (const op of frame.o) {
      if (op[0] === "L") { depth += 1; continue; }
      if (op[0] === "l") { depth -= 1; continue; }
      if (depth || op[0] !== "i" || !(op[1] >= 1000) || !isArray(op[4])) continue;
      const size = pictureSize(op[3]);
      const m = op[4];
      if (!size || m[1] !== 0 || m[2] !== 0 || !(m[0] > 0) || !(m[3] > 0)) continue;
      const left = m[4] / 10, top = m[5] / 10;
      const right = left + size.width * m[0] / 10000, bottom = top + size.height * m[3] / 10000;
      if (left <= 0.5 && top <= 0.5 && right >= STAGE.width - 0.5 && bottom >= STAGE.height - 0.5) view = op[3];
    }
    frame.__view = view;
    return view;
  }

  // Where a command is (tenths), to tell a move from a jump: a picture's
  // translation, a path's first point, words' anchor; null when it has none.
  function anchorOf(op) {
    switch (op[0]) {
      case "i": return isArray(op[4]) && op[4].length === 6 ? [op[4][4], op[4][5]] : null;
      case "f":
      case "s": return isArray(op[4]) && op[4].length >= 2 ? [op[4][0], op[4][1]] : null;
      case "t": return isArray(op[8]) && op[8].length >= 2 ? [op[8][0], op[8][1]] : null;
      default: return null;
    }
  }

  function jumps(a, b) {
    const from = anchorOf(a), to = anchorOf(b);
    if (from && to && (Math.abs(to[0] - from[0]) > MAX_STEP || Math.abs(to[1] - from[1]) > MAX_STEP)) return true;
    // A picture growing or shrinking more than twice over between two frames is another one.
    if (a[0] === "i" && isArray(a[4]) && isArray(b[4])) {
      const sa = Math.abs(a[4][0]) + Math.abs(a[4][1]), sb = Math.abs(b[4][0]) + Math.abs(b[4][1]);
      if (sa > 0 && sb > 0 && (sa > sb * 2 || sb > sa * 2)) return true;
    }
    return false;
  }

  // For each command of `a`, the index of its partner in `b` (or -1), and how
  // many have one: the longest run of commands of the same shapes in the
  // same order, less any that would jump. Kept on `a` for the next draw.
  function matchOps(a, b) {
    if (a.__matchWith === b) return a.__match;
    const n = a.o.length, m = b.o.length;
    const pairs = new Int32Array(n).fill(-1);
    let count = 0;
    if (viewOf(a) === viewOf(b)) {
      const ka = a.o.map(opShape), kb = b.o.map(opShape);
      let start = 0;
      while (start < n && start < m && ka[start] === kb[start]) { pairs[start] = start; start += 1; }
      let endA = n, endB = m;
      while (endA > start && endB > start && ka[endA - 1] === kb[endB - 1]) { endA -= 1; endB -= 1; pairs[endA] = endB; }
      const rows = endA - start, cols = endB - start;
      if (rows > 0 && cols > 0 && (rows + 1) * (cols + 1) <= MAX_MATCH_CELLS) {
        const width = cols + 1;
        const run = new Uint16Array((rows + 1) * width);
        for (let i = rows - 1; i >= 0; i -= 1) {
          for (let j = cols - 1; j >= 0; j -= 1) {
            run[i * width + j] = ka[start + i] === kb[start + j] ? run[(i + 1) * width + j + 1] + 1
              : Math.max(run[(i + 1) * width + j], run[i * width + j + 1]);
          }
        }
        let i = 0, j = 0;
        while (i < rows && j < cols) {
          if (ka[start + i] === kb[start + j]) { pairs[start + i] = start + j; i += 1; j += 1; }
          else if (run[(i + 1) * width + j] >= run[i * width + j + 1]) i += 1;
          else j += 1;
        }
      }
      for (let index = 0; index < n; index += 1) {
        if (pairs[index] >= 0 && jumps(a.o[index], b.o[pairs[index]])) pairs[index] = -1;
      }
      // A command left without a partner (the longest run paired it with
      // another of its shape, too far away: the inset's ball for the
      // stadium's) takes the nearest free command of its shape between its
      // neighbours' partners, so the order still holds.
      const used = new Uint8Array(m);
      for (let index = 0; index < n; index += 1) if (pairs[index] >= 0) used[pairs[index]] = 1;
      let low = 0;
      for (let index = 0; index < n; index += 1) {
        if (pairs[index] >= 0) { low = pairs[index] + 1; continue; }
        let high = m;
        for (let after = index + 1; after < n; after += 1) if (pairs[after] >= 0) { high = pairs[after]; break; }
        const from = anchorOf(a.o[index]);
        let best = -1, bestDistance = Infinity;
        for (let candidate = low; candidate < high; candidate += 1) {
          if (used[candidate] || kb[candidate] !== ka[index] || jumps(a.o[index], b.o[candidate])) continue;
          const to = anchorOf(b.o[candidate]);
          const distance = from && to ? Math.abs(to[0] - from[0]) + Math.abs(to[1] - from[1]) : 0;
          if (distance < bestDistance) { best = candidate; bestDistance = distance; }
        }
        if (best >= 0) { pairs[index] = best; used[best] = 1; low = best + 1; }
      }
      for (let index = 0; index < n; index += 1) if (pairs[index] >= 0) count += 1;
    }
    a.__matchWith = b;
    a.__match = { pairs, count, lists: (a.__lists === undefined ? (a.__lists = listsShape(a)) : a.__lists)
      === (b.__lists === undefined ? (b.__lists = listsShape(b)) : b.__lists) };
    return a.__match;
  }

  // Blends `a` toward `b` into `out` (a frame of a's shapes, from
  // `cloneFrame`) where `match` pairs their commands; every other command,
  // and the filter and clip lists when theirs differ, as `a` has them.
  function blendMatchedInto(out, a, b, match, u) {
    const pairs = match.pairs;
    for (let index = 0; index < a.o.length; index += 1) {
      const opA = a.o[index];
      const partner = pairs[index];
      const opB = partner >= 0 ? b.o[partner] : opA;
      const t = partner >= 0 ? u : 0;
      const op = out.o[index];
      const discrete = DISCRETE[opA[0]] || [];
      op[0] = opA[0];
      for (let field = 1; field < opA.length; field += 1) {
        const x = opA[field];
        if (discrete.indexOf(field) >= 0) op[field] = x;
        else if (typeof x === "number") op[field] = x + (opB[field] - x) * t;
        else if (isArray(x) && isArray(op[field])) blendInto(op[field], x, opB[field], t);
        else op[field] = x;
      }
    }
    out.s = a.s + (b.s - a.s) * u;
    out.p = blendPose(a, b, u);
    blendInto(out.fl, a.fl, match.lists ? b.fl : a.fl, match.lists ? u : 0);
    blendInto(out.cl, a.cl, match.lists ? b.cl : a.cl, match.lists ? u : 0);
    return out;
  }

  // A fresh frame `u` of the way from `a` to `b`, blending what matches (as
  // the timeline does; for films and previews).
  function blendMatched(a, b, u) {
    if (shapeKey(a) === shapeKey(b)) return blendFrames(a, b, u);
    const out = cloneFrame(a);
    return blendMatchedInto(out, a, b, matchOps(a, b), u);
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
    return { s: a.s + (b.s - a.s) * u, o: ops, fl: blendValue(a.fl, b.fl, u), cl: blendValue(a.cl, b.cl, u), h: null,
      p: blendPose(a, b, u) };
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
    return { s: frame.s, o: frame.o.map(cloneValue), fl: cloneValue(frame.fl), cl: cloneValue(frame.cl), h: null, p: frame.p };
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
    out.p = blendPose(a, b, u);
    blendInto(out.fl, a.fl, b.fl, u);
    blendInto(out.cl, a.cl, b.cl, u);
    return out;
  }

  // The frames on their way to the screen, by moment. A redraw (a newer
  // epoch) replaces everything from its first moment on, and frames of an
  // older epoch still arriving are dropped.
  function createTimeline(options) {
    let frames = [];
    let epoch = 0;
    // Whether frames of different shapes blend the commands that match
    // (receiver 65; the bench's `x.blend: "whole"` turns it off).
    let blendsMatches = !(options && options.matches === false);
    // How a message becomes a frame (`plainFrame` for the rehearsal).
    const normalize = (options && options.normalize) || normalizeFrame;
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
      get blendsMatches() { return blendsMatches; },
      // The frames held, oldest first (tests).
      get frames() { return frames.slice(); },
      set blendsMatches(value) { blendsMatches = !!value; },
      get newest() { return frames.length ? frames[frames.length - 1] : null; },

      // One frame ("f"): ignored when an older epoch's.
      add(rawFrame, frameEpoch) {
        const frame = normalize(rawFrame);
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
        const incoming = rawFrames.map((raw) => normalize(raw)).filter(Boolean).sort((x, y) => x.s - y.s);
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
        if (b && b.s - a.s <= MAX_BLEND_GAP && b.s > a.s) {
          const same = shapeKey(a) === shapeKey(b);
          // Receiver 65: frames of different shapes blend what matches.
          const match = same || !blendsMatches ? null : matchOps(a, b);
          if (same || (match && match.count > 0)) {
            const u = Math.min(1, Math.max(0, (now - a.s) / (b.s - a.s)));
            if (u <= 0) return { frame: a, stamp: a.s, blended: false };
            if (scratchShape !== shapeKey(a)) { scratch = cloneFrame(a); scratch.scratch = true; scratchShape = shapeKey(a); }
            const frame = same ? blendFramesInto(scratch, a, b, u) : blendMatchedInto(scratch, a, b, match, u);
            return { frame, stamp: a.s, blended: true, partly: !same };
          }
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

  // The live batter (receiver 51): the newest "b" message, drawn into each
  // frame's "B" slot from the moment it arrives. It is not held for its
  // moment or blended with the one before: either would show an older pose.
  // The phone draws it for about the moment it lands here.
  function createLiveLayer() {
    let current = null;
    return {
      get current() { return current; },
      // Newest wins; one older than the batter held (out of order) is dropped.
      set(raw) {
        const frame = normalizeFrame(raw);
        if (!frame) return null;
        if (current && frame.s < current.s) return null;
        frame.h = null;
        current = frame;
        return frame;
      },
      clear() { current = null; }
    };
  }

  // How old the pose of the batter drawn at phone moment `now` is, in ms:
  // the live batter's for a frame with a slot, the frame's own otherwise.
  // Null when the phone didn't say (before build 157, or no camera).
  function poseAge(now, frame, live) {
    if (!frame || !Number.isFinite(now)) return null;
    const pose = hasLiveSlot(frame) ? (live ? live.p : null) : frame.p;
    return pose == null ? null : now - pose;
  }

  // How far ahead of its pose the batter drawn for this frame was drawn
  // (ms): the live batter's for a frame with a slot, else none. Null when
  // its pose age is unknown, as `poseAge`.
  function poseAhead(frame, live) {
    if (!frame) return null;
    const source = hasLiveSlot(frame) ? live : frame;
    if (!source || source.p == null) return null;
    return source.ph || 0;
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
  const CANVAS = { wide: 1920, narrow: 1280, weak: 854, minFps: 25 };

  // Where the TV keeps what it remembers (the canvas width it settled on)
  // and the pictures phones sent (IndexedDB). The staging receiver is the
  // same files in the production site's `staging/` folder (Oct 19 2026,
  // docs/design/CAST_SCENE.md "Chromecast environments"): one origin, so one
  // localStorage and one IndexedDB. Served from a folder named `staging` it
  // keeps its own names, so a test on it never narrows production's canvas
  // or fills production's picture cache. Production keeps the names it has
  // always had.
  function storageNames(pathname) {
    const suffix = /\/staging\/[^/]*$/.test(String(pathname || "")) ? "-staging" : "";
    return { canvas: "rallycade-scene-canvas" + suffix, pictures: "rallycade-scene" + suffix };
  }

  // The 32-bit Cast dongles (Chromecast 2nd and 3rd generation: "Linux
  // armv7l", CrKey) draw a quarter as fast as an Ultra ("Linux aarch64").
  // iOS 184–199 at a house party (Oct 18 2026) drew 7–10 fps on one, the
  // page's loop every ~105 ms with frames arriving on time; the same stream
  // drew 29 on the Ultra, and the Ultra with its page slowed threefold (the
  // bench's cpu=3) drew 8. The weak plan: an 854 canvas, no blended redraws,
  // glows unblurred (`WEAK_TUNED` in receiver-scene.js), and `weak: 1` in
  // `ready` so the phone sends at the TV's pace.
  function isWeakDongle(ua) {
    const text = String(ua || "");
    return /CrKey/.test(text) && /armv7l/.test(text) && !/Android|GoogleTV|Google TV|Fuchsia/i.test(text);
  }

  // `device`: `ua` (navigator.userAgent), `pinned` (a width the phone or the
  // bench asked for in `hello`), `wide` (the phone's hello allows 1920: build
  // 134 on), `remembered` (what this TV found last time: `{ua, width}`).
  // Returns the most pixels across, whether to keep watching the frame
  // rate, and why (sent in `stats`). Phones that don't allow it (the App
  // Store's 2.6) keep the 1280 canvas they were released with.
  function canvasPlan(device) {
    const ua = String((device && device.ua) || "");
    const pinned = Number(device && device.pinned);
    const weak = !!(device && device.weak) || isWeakDongle(ua);
    if (pinned >= 320) return Object.assign({ width: Math.min(CANVAS.wide, Math.round(pinned)), adaptive: false, why: "asked" }, weak ? { weak: true } : {});
    if (weak) return { width: CANVAS.weak, adaptive: false, why: "weak", weak: true };
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

  // MARK: Steady before the first ball (receiver 65)
  //
  // Oct 21 2026 (the owner: "worse at the start"; the batting-feel plan's TV
  // item): an onn drew 17, 32, 18, 32 frames a second through the first ball
  // and 45 only from ~14 s; build 207 on the Ultra climbed 1 → 27 over 18 s.
  // The phone held the first ball only until a frame had every picture
  // (`whole`). Now the TV says `steady` once it has drawn at least `fps`
  // frames a second for `window` ms with no gap over `maxGap` (a hitch), and
  // a phone that says it waits (hello `steady: 1`) holds the first ball until
  // then, at most its own cap. A TV that can't reach `fps` (a 32-bit
  // Chromecast at 9, an LG C3 at 23) is steady once `plateau` ms in its rate
  // holds (the last window within 15% of the one before: neither falling nor
  // still climbing): it is as smooth as it gets. `start` at the first whole frame, `draw` at each
  // drawn one; the verdict comes once.
  //
  // Receiver 67 (build 215, w84tyjvq/x4n1rrhk, Oct 22 2026): the owner's
  // Chromecast Ultra draws 19–21.5 a second, never 25, so every innings
  // waited for the plateau: 5.7–7.9 s after the stadium came on, once the
  // phone's 8 s cap, with the player standing at the crease ("TV pauses 5
  // (loading 5)"). Its rate now holds when its last `plateauWindow` ms (1 s)
  // is within 15% of the first second of the last `plateau` ms (3 s; two
  // windows of 2 s before), so a TV drawing evenly at 21 is steady 3 s after
  // its first whole frame (with 2 s since its last hitch); one still climbing
  // or falling 2 a second each second waits until it is within 15% of where
  // it settles.
  const STEADY = { fps: 25, window: 2000, maxGap: 100, plateau: 3000, plateauWindow: 1000, hold: 0.85 };

  function createSteadyWatch(options) {
    const fps = (options && options.fps) || STEADY.fps;
    const span = (options && options.window) || STEADY.window;
    const maxGap = (options && options.maxGap) || STEADY.maxGap;
    const plateau = (options && options.plateau) || STEADY.plateau;
    const plateauSpan = (options && options.plateauWindow) || STEADY.plateauWindow;
    const hold = (options && options.hold) || STEADY.hold;
    let since = null;
    let times = [];
    let verdict = null;
    // When the current run without a hitch began.
    let runFrom = null;
    function rate(from, to) {
      let count = 0;
      for (const t of times) if (t > from && t <= to) count += 1;
      return count * 1000 / (to - from);
    }
    return {
      get verdict() { return verdict; },
      get started() { return since !== null; },
      start(now) { since = now; times = []; verdict = null; runFrom = now; },
      reset() { since = null; times = []; verdict = null; runFrom = null; },
      // How far along the current run without a hitch is, 0…1 (1 once steady).
      progress(now) {
        if (verdict) return 1;
        if (since === null || runFrom === null) return 0;
        return Math.max(0, Math.min(1, (now - runFrom) / span));
      },
      draw(now) {
        if (since === null || verdict) return null;
        const last = times.length ? times[times.length - 1] : since;
        // A hitch: a gap over `maxGap`, or over two and a half of this TV's
        // usual gaps (a 32-bit Chromecast draws every ~110 ms).
        const gaps = [];
        for (let index = Math.max(1, times.length - 30); index < times.length; index += 1) gaps.push(times[index] - times[index - 1]);
        const usual = gaps.length >= 10 ? percentile(gaps, 0.5) : 0;
        if (now - last > Math.max(maxGap, usual * 2.5)) runFrom = now;
        times.push(now);
        while (times.length && times[0] < now - 2 * span) times.shift();
        if (now - runFrom < span) return null;
        const recent = rate(now - span, now);
        if (recent >= fps - 0.01) {
          verdict = { fps: Math.round(recent * 10) / 10, why: "fast", after: Math.round(now - since) };
        } else if (now - since >= plateau && recent >= 4) {
          const last = rate(now - plateauSpan, now);
          const before = rate(now - plateau, now - plateau + plateauSpan);
          // Neither falling nor still climbing: within `1 - hold` of the window before.
          if (before > 0 && last >= before * hold && last * hold <= before) verdict = { fps: Math.round(recent * 10) / 10, why: "plateau", after: Math.round(now - since) };
        }
        return verdict;
      }
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

  // The CSS colours drawn every frame, made once each (receiver 57): a
  // string a command a frame kept the Chromecast's collector busy.
  const colors = new Map();

  function cssColor(color, multiply) {
    if (!isArray(color)) return "rgba(0,0,0,0)";
    let r = color[0], g = color[1], b = color[2], a = color[3] / 1000;
    if (multiply) {
      r = r * multiply[0] / 255; g = g * multiply[1] / 255; b = b * multiply[2] / 255; a *= multiply[3] / 1000;
    }
    r = Math.round(r); g = Math.round(g); b = Math.round(b);
    const alpha = Math.round(Math.max(0, Math.min(1, a)) * 1000);
    const key = ((r * 256 + g) * 256 + b) * 1001 + alpha;
    let css = colors.get(key);
    if (css === undefined) {
      css = "rgba(" + r + "," + g + "," + b + "," + (alpha / 1000).toFixed(3) + ")";
      if (colors.size >= 4096) colors.clear();
      colors.set(key, css);
    }
    return css;
  }

  // MARK: Cheap drawing on a Chromecast (receiver 57)

  // A filter list's blur (stage points, several in a row add as their
  // squares do) and colour multiply.
  function filterParts(list) {
    let squares = 0;
    let multiply = null;
    if (isArray(list)) {
      for (const filter of list) {
        if (!isArray(filter)) continue;
        if (filter[0] === "b") { const radius = Number(filter[1]) / 10; if (radius > 0) squares += radius * radius; }
        if (filter[0] === "m" && isArray(filter[1])) multiply = filter[1];
      }
    }
    return { blur: Math.sqrt(squares), multiply };
  }

  // Where a command paints, in stage points [left, top, right, bottom]
  // before any blur; null when it can't be told. `size` gives a picture's
  // drawn size by key.
  function opBounds(op, size) {
    switch (op[0]) {
      case "f":
      case "s": {
        const points = op[4];
        if (!isArray(points) || points.length < 2) return null;
        let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
        for (let index = 0; index + 1 < points.length; index += 2) {
          const x = points[index], y = points[index + 1];
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
        if (!(right >= left) || !(bottom >= top)) return null;
        let pad = 0;
        if (op[0] === "s") {
          const geometry = isArray(op[6]) ? op[6] : [10, 0, 0, 100];
          const half = Math.max(0.01, geometry[0] / 10) / 2;
          // A mitred corner can reach out `miterLimit` half widths.
          pad = half * (geometry[2] === 0 ? Math.max(1, geometry[3] / 10) : 1) + 1;
        }
        return [left / 10 - pad, top / 10 - pad, right / 10 + pad, bottom / 10 + pad];
      }
      case "i": {
        const m = op[4];
        const drawn = size && size(op[3]);
        if (!isArray(m) || !drawn) return null;
        const a = m[0] / 10000, b = m[1] / 10000, c = m[2] / 10000, d = m[3] / 10000, e = m[4] / 10, f = m[5] / 10;
        const xs = [e, a * drawn.width + e, c * drawn.height + e, a * drawn.width + c * drawn.height + e];
        const ys = [f, b * drawn.width + f, d * drawn.height + f, b * drawn.width + d * drawn.height + f];
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      }
      case "t": {
        // Generous: as wide as its longest line of wide letters, either way of the anchor.
        const fontSize = Number(op[4]) / 10;
        const lines = String(op[3]).split("\n");
        const longest = Math.max(...lines.map((line) => line.length));
        const at = isArray(op[8]) ? op[8] : [0, 0];
        const width = longest * fontSize + fontSize;
        const height = (lines.length + 1) * fontSize * 1.2;
        return [at[0] / 10 - width, at[1] / 10 - height, at[0] / 10 + width, at[1] / 10 + height];
      }
      default:
        return null;
    }
  }

  // The "l" that closes the layer opened at `index`, or -1.
  function layerEnd(ops, index) {
    let depth = 0;
    for (let at = index; at < ops.length; at += 1) {
      const kind = ops[at][0];
      if (kind === "L") depth += 1;
      else if (kind === "l") { depth -= 1; if (depth === 0) return at; }
    }
    return -1;
  }

  // Whether a clip list leaves the whole stage drawn: every clip in it a
  // plain rectangle around the stage. The phone clips the stadium photo
  // to the stage (CastStadiumScene.drawBackdrop), which kept it off the
  // GPU layer: an iPhone's stadium photo was drawn on the canvas, under a
  // clip, thirty times a second (receiver 57).
  function clipsWholeStage(list) {
    if (!isArray(list) || !list.length) return false;
    for (const clip of list) {
      if (!isArray(clip) || typeof clip[0] !== "string" || !isArray(clip[1])) return false;
      if (!/^ML+Z?$/.test(clip[0])) return false;
      const points = clip[1];
      const count = clip[0].replace("Z", "").length;
      if (points.length !== count * 2 || count < 4) return false;
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (let index = 0; index < points.length; index += 2) {
        left = Math.min(left, points[index]); right = Math.max(right, points[index]);
        top = Math.min(top, points[index + 1]); bottom = Math.max(bottom, points[index + 1]);
      }
      // A rectangle walked edge by edge: each point a corner, each step
      // along one axis.
      for (let index = 0; index < points.length; index += 2) {
        const x = points[index], y = points[index + 1];
        if ((x !== left && x !== right) || (y !== top && y !== bottom)) return false;
        const next = (index + 2) % points.length;
        if (x !== points[next] && y !== points[next + 1]) return false;
      }
      if (left > 5 || top > 5 || right < STAGE.width * 10 - 5 || bottom < STAGE.height * 10 - 5) return false;
    }
    return true;
  }

  // MARK: Where a canvas was drawn into (receiver 67, build 215)
  //
  // Oct 22 2026 (w84tyjvq/x4n1rrhk: the owner's Chromecast Ultra drew 19-21.5
  // a second, its frame loop every 43-56 ms): a draw cleared the whole
  // 1280 x 720 canvas and copied the whole static layer onto it, though the
  // stadium's commands cover a fraction of it (the photo is its own layer
  // under the canvas). Of a draw's cost in scripts/cast-frame-cost.mjs those
  // two were 13% and 29%. Now a draw clears only where the one before drew,
  // and copies only the static layer's own parts. `flat` is [left, top,
  // right, bottom, ...] in canvas pixels (each command's padded bounds): the
  // whole pixels they cover, clamped to `width` x `height`, merged where two
  // overlap or their union is at most `slack` times both their areas. With
  // `disjoint` it merges until no two overlap (a copy must not land twice: a
  // see-through pixel would darken); without, one pass (clearing twice is
  // harmless). Over `most` rects: their bounding box.
  function mergeRects(flat, width, height, options) {
    const slack = (options && options.slack) || 1.25;
    const most = (options && options.most) || 16;
    const disjoint = !!(options && options.disjoint);
    const area = (r) => (r[2] - r[0]) * (r[3] - r[1]);
    const out = [];
    for (let index = 0; index + 3 < flat.length; index += 4) {
      const r = [Math.max(0, Math.floor(flat[index])), Math.max(0, Math.floor(flat[index + 1])),
        Math.min(width, Math.ceil(flat[index + 2])), Math.min(height, Math.ceil(flat[index + 3]))];
      if (!(r[2] > r[0] && r[3] > r[1])) continue;
      let into = -1;
      for (let k = 0; k < out.length && into < 0; k += 1) {
        const o = out[k];
        const overlaps = r[0] < o[2] && o[0] < r[2] && r[1] < o[3] && o[1] < r[3];
        const union = [Math.min(r[0], o[0]), Math.min(r[1], o[1]), Math.max(r[2], o[2]), Math.max(r[3], o[3])];
        if (overlaps || area(union) <= (area(r) + area(o)) * slack) { out[k] = union; into = k; }
      }
      if (into < 0) out.push(r);
    }
    // A union can reach rects it didn't touch before: merge again until none overlap.
    for (let changed = disjoint; changed;) {
      changed = false;
      for (let i = 0; i < out.length && !changed; i += 1) {
        for (let j = i + 1; j < out.length && !changed; j += 1) {
          const a = out[i], c = out[j];
          if (a[0] < c[2] && c[0] < a[2] && a[1] < c[3] && c[1] < a[3]) {
            out[i] = [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[2], c[2]), Math.max(a[3], c[3])];
            out.splice(j, 1);
            changed = true;
          }
        }
      }
    }
    if (out.length > most) {
      const box = out.reduce((b, r) => [Math.min(b[0], r[0]), Math.min(b[1], r[1]), Math.max(b[2], r[2]), Math.max(b[3], r[3])]);
      return [box];
    }
    return out;
  }

  return {
    isWeakDongle, storageNames, STAGE, MAX_BLEND_GAP, MAX_STEP, CANVAS, normalizeFrame, plainFrame, expandInset, shapeKey, opShape, viewOf, matchOps, blendMatched, blendMatchedInto,
    blendFrames, blendFramesInto, cloneFrame, createTimeline, createClock,
    percentile, tracePath, cssColor, pictureSize, canvasPlan, canvasWidth, createRateWatch, STEADY, createSteadyWatch, createLiveLayer, hasLiveSlot, poseAge, poseAhead,
    filterParts, opBounds, layerEnd, clipsWholeStage, mergeRects
  };
});
