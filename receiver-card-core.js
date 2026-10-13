(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RallycadeCardCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Receiver 50 (build 154): a result screen is the phone's own TV
  // scorecard, drawn on the phone into one JPEG and sent in parts ("card"
  // messages on the scene channel). The user, on the receiver's own HTML
  // result: "Why are you not just showing the phone screen as is?"
  //
  // The game state names the picture its screen wants (`state.card`). The
  // TV waits for it on a quiet backdrop, shows it once it is here and whole,
  // and draws its own HTML result if it never comes. Phones before build 154
  // name none and keep the HTML result.
  //
  // Receiver 51: a picture may come again under the same id, sharper (the
  // phone sends a small draft first, then the full picture); the newest
  // whole one shows. A scorecard drawn again (its reward arrived) keeps its
  // last picture for as long as the new one takes, never the HTML.

  // How long a result waits for its picture before the HTML result shows.
  // Receiver 50 waited 1.5 s, and build 156's single 393 KB picture often
  // took longer: the TV flashed its own, different result first (the user:
  // "the screen is still different than phone"). The phone's draft now
  // arrives inside a second; the longer wait covers a slow channel.
  const TIMEOUT_MS = 4000;
  // A picture in more parts than this is refused (the phone sends 1–3 for a
  // draft and up to ~11 for the sharp picture).
  const MAX_PARTS = 64;
  const MAX_LENGTH = 4 * 1024 * 1024;
  // Pictures half-received at once: a newer one replaces the oldest.
  const MAX_PENDING = 2;
  // Screens a picture may stand for. Build 158 phones send the stadium
  // setup too (the user, on the receiver's own setup screen: "very different
  // ui than the rest of the screens"), to receivers that say `setup: 1`
  // (receiver 52).
  const CARD_SCREENS = new Set(["result", "versusResult", "cricketDuelResult", "timingCheck", "positioning"]);

  // The setup's hold ring on its picture (`ring`: [x, y, diameter], the
  // centre as fractions of the picture's width and height, the diameter as
  // a fraction of its width), or null.
  function validRing(value) {
    if (!Array.isArray(value) || value.length !== 3) return null;
    const [x, y, d] = value.map(Number);
    if (![x, y, d].every(Number.isFinite) || x < 0 || x > 1 || y < 0 || y > 1 || d <= 0 || d > 0.5) return null;
    return { x, y, d };
  }

  // Where the ring goes on the TV, in CSS pixels: the picture fills the
  // screen as `object-fit: contain` does, and the phone's ring is a circle
  // of the diameter, its stroke a tenth of it, centred on its edge. Returns
  // the box of an SVG drawn with viewBox "-5 -5 110 110" (the stroke's outer
  // half included).
  function ringPlacement(ring, picture, view) {
    if (!ring || !picture || !(picture.width > 0) || !(picture.height > 0) || !(view.width > 0) || !(view.height > 0)) return null;
    const scale = Math.min(view.width / picture.width, view.height / picture.height);
    const width = picture.width * scale, height = picture.height * scale;
    const left = (view.width - width) / 2, top = (view.height - height) / 2;
    const diameter = ring.d * width;
    const box = diameter * 1.1;
    return { left: left + ring.x * width - box / 2, top: top + ring.y * height - box / 2, size: box, diameter };
  }

  // FNV-1a over the base64 text, as the phone computes it.
  function checksum(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index) & 0xff;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  // "<scorecard>.<content>": the same scorecard keeps its first half when a
  // reward arrives and the picture is drawn again.
  function family(id) {
    return String(id || "").split(".")[0];
  }

  function validId(id) {
    return typeof id === "string" && /^[0-9a-z]{1,32}\.[0-9a-z]{1,32}$/.test(id);
  }

  function cardId(state) {
    if (!state || !CARD_SCREENS.has(state.screen)) return null;
    return validId(state.card) ? state.card : null;
  }

  // Parts in, whole pictures out: { status: "partial" | "complete" |
  // "invalid", id, picture: { id, width, height, data } }.
  function createAssembler() {
    const pending = new Map();

    function add(message) {
      const m = message && typeof message === "object" ? message : {};
      const id = m.id;
      const of = Number(m.of), n = Number(m.n), len = Number(m.len), sum = Number(m.sum);
      if (m.t !== "card" || !validId(id) || !Number.isInteger(of) || of < 1 || of > MAX_PARTS
        || !Number.isInteger(n) || n < 0 || n >= of || typeof m.d !== "string"
        || !Number.isInteger(len) || len < 1 || len > MAX_LENGTH || !Number.isFinite(sum)) {
        return { status: "invalid", id: validId(id) ? id : null };
      }
      let entry = pending.get(id);
      if (entry && (entry.of !== of || entry.len !== len || entry.sum !== sum)) {
        // The phone started this picture again with other numbers.
        pending.delete(id);
        entry = null;
      }
      if (!entry) {
        while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
        entry = { of, len, sum, width: Number(m.w) || 0, height: Number(m.h) || 0, ring: validRing(m.ring), parts: new Array(of), count: 0 };
        pending.set(id, entry);
      }
      if (entry.parts[n] == null) entry.count += 1;
      entry.parts[n] = m.d;
      if (entry.count < of) return { status: "partial", id };
      pending.delete(id);
      const data = entry.parts.join("");
      if (data.length !== len || checksum(data) !== sum) return { status: "invalid", id };
      return { status: "complete", id, picture: { id, width: entry.width, height: entry.height, ring: entry.ring, data } };
    }

    return { add, get pendingCount() { return pending.size; } };
  }

  // What the TV shows for the current state: "html" (its own result, or any
  // screen without a picture), "waiting" (a result whose picture is on its
  // way, for up to TIMEOUT_MS), or "picture" with the picture's id.
  function createDisplay(options) {
    const timeoutMs = (options && options.timeoutMs) || TIMEOUT_MS;
    const ready = new Set();
    let expected = null;
    let since = 0;
    let shown = null;

    function expect(id, now) {
      const next = validId(id) ? id : null;
      if (next === expected) return;
      expected = next;
      since = now;
    }

    function arrived(id) { ready.add(id); }
    function forget(id) { ready.delete(id); if (shown === id) shown = null; }

    function decide(now) {
      if (!expected) return { mode: "html", wait: 0 };
      if (ready.has(expected)) { shown = expected; return { mode: "picture", id: expected, wait: 0 }; }
      const left = Math.max(0, timeoutMs - (now - since));
      // The same scorecard drawn again (its reward arrived): its last
      // picture stays until the new one is here, however long that takes.
      if (shown && family(shown) === family(expected) && ready.has(shown)) {
        return { mode: "picture", id: shown, wait: 0 };
      }
      if (left > 0) return { mode: "waiting", wait: left };
      return { mode: "html", wait: 0 };
    }

    return { expect, arrived, forget, decide, get expected() { return expected; } };
  }

  // Ids to let go so at most `keep` pictures stay decoded, oldest first,
  // never the one on screen or wanted.
  function prune(ids, keep, protect) {
    const spare = ids.filter((id) => protect.indexOf(id) < 0);
    return spare.slice(0, Math.max(0, ids.length - keep));
  }

  // The page's side (receiver.js gives it the elements and the browser's
  // pieces; tests give it pretend ones): parts in, the picture shown over
  // the HTML screens, and the live hold ring over the picture.
  function createCardView(o) {
    const assembler = createAssembler();
    const display = createDisplay({ timeoutMs: o.timeoutMs });
    const urls = new Map();
    // Each picture's size and the setup's ring on it.
    const meta = new Map();
    const KEEP = 3;
    let state = null;
    let timer = null;
    let last = { mode: "html" };

    function apply() {
      if (timer != null) { o.clearTimer(timer); timer = null; }
      const decision = display.decide(o.now());
      o.body.dataset.card = decision.mode;
      // The waiting backdrop matches the screen the picture will show.
      o.root.dataset.screen = state && state.screen ? state.screen : "";
      o.root.hidden = decision.mode === "html";
      if (decision.mode === "picture") {
        const url = urls.get(decision.id);
        if (o.image.src !== url) o.image.src = url;
        o.image.hidden = false;
      } else {
        o.image.hidden = true;
      }
      const hold = decision.mode === "picture" && state && state.hold > 0 ? state.hold : 0;
      o.hold.hidden = !hold;
      if (hold) o.renderHold(o.hold, hold, "Keep holding");
      // The setup: its hold ring where the picture has it, filling live as
      // on the phone, and hidden at rest as there.
      if (o.ring) {
        const setup = decision.mode === "picture" && state && state.positioning;
        const picture = setup ? meta.get(decision.id) : null;
        const progress = setup && state.positioning.canHold ? state.positioning.progress : 0;
        const place = progress > 0 && picture ? ringPlacement(picture.ring, picture, o.view()) : null;
        o.ring.hidden = !place;
        if (place) o.renderRing(o.ring, place, progress);
      }
      if (decision.wait > 0) timer = o.setTimer(apply, decision.wait + 20);
      last = decision;
      return decision;
    }

    function update(next) {
      state = next;
      display.expect(cardId(next), o.now());
      return apply();
    }

    function keep(id, url, picture) {
      // A sharper picture under the same id replaces the draft.
      const previous = urls.get(id);
      if (previous && previous !== url) o.revoke(previous);
      urls.set(id, url);
      meta.set(id, picture ? { width: picture.width, height: picture.height, ring: picture.ring || null } : { width: 0, height: 0, ring: null });
      display.arrived(id);
      prune(Array.from(urls.keys()), KEEP, [display.expected, last.id, id]).forEach((old) => {
        o.revoke(urls.get(old));
        urls.delete(old);
        meta.delete(old);
        display.forget(old);
      });
      return apply();
    }

    function receive(message) {
      const result = assembler.add(message);
      if (result.status === "invalid") {
        if (o.report) o.report("card", "picture " + (result.id || "?") + " arrived broken");
        return Promise.resolve(result);
      }
      if (result.status !== "complete") return Promise.resolve(result);
      let url;
      try { url = o.toUrl(result.picture.data); } catch (error) {
        if (o.report) o.report("card", error);
        return Promise.resolve({ status: "invalid", id: result.id });
      }
      // Decoded before it is shown: no half-drawn picture on the TV.
      return Promise.resolve(o.decode ? o.decode(url) : null).then(() => {
        keep(result.id, url, result.picture);
        return result;
      }, (error) => {
        o.revoke(url);
        if (o.report) o.report("card", error);
        return { status: "invalid", id: result.id };
      });
    }

    return { receive, update, apply, keep, get decision() { return last; }, get urls() { return urls; } };
  }

  return { TIMEOUT_MS, MAX_PARTS, CARD_SCREENS, checksum, family, validId, cardId, validRing, ringPlacement, createAssembler, createDisplay, prune, createCardView };
});
