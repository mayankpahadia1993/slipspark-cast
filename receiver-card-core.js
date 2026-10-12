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
  // TV waits a moment for it, shows it once it is here and whole, and draws
  // its own HTML result if it never comes. Phones before build 154 name
  // none and keep the HTML result.

  // How long a result waits for its picture before the HTML result shows.
  const TIMEOUT_MS = 1500;
  // A picture in more parts than this is refused (the phone sends ~8–14).
  const MAX_PARTS = 64;
  const MAX_LENGTH = 4 * 1024 * 1024;
  // Pictures half-received at once: a newer one replaces the oldest.
  const MAX_PENDING = 2;
  // Screens a picture may stand for.
  const CARD_SCREENS = new Set(["result", "versusResult", "cricketDuelResult", "timingCheck"]);

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
        entry = { of, len, sum, width: Number(m.w) || 0, height: Number(m.h) || 0, parts: new Array(of), count: 0 };
        pending.set(id, entry);
      }
      if (entry.parts[n] == null) entry.count += 1;
      entry.parts[n] = m.d;
      if (entry.count < of) return { status: "partial", id };
      pending.delete(id);
      const data = entry.parts.join("");
      if (data.length !== len || checksum(data) !== sum) return { status: "invalid", id };
      return { status: "complete", id, picture: { id, width: entry.width, height: entry.height, data } };
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
      // picture stays until the new one is here.
      if (left > 0 && shown && family(shown) === family(expected) && ready.has(shown)) {
        return { mode: "picture", id: shown, wait: left };
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
    const KEEP = 3;
    let state = null;
    let timer = null;
    let last = { mode: "html" };

    function apply() {
      if (timer != null) { o.clearTimer(timer); timer = null; }
      const decision = display.decide(o.now());
      o.body.dataset.card = decision.mode;
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
      if (decision.wait > 0) timer = o.setTimer(apply, decision.wait + 20);
      last = decision;
      return decision;
    }

    function update(next) {
      state = next;
      display.expect(cardId(next), o.now());
      return apply();
    }

    function keep(id, url) {
      urls.set(id, url);
      display.arrived(id);
      prune(Array.from(urls.keys()), KEEP, [display.expected, last.id, id]).forEach((old) => {
        o.revoke(urls.get(old));
        urls.delete(old);
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
        keep(result.id, url);
        return result;
      }, (error) => {
        o.revoke(url);
        if (o.report) o.report("card", error);
        return { status: "invalid", id: result.id };
      });
    }

    return { receive, update, apply, keep, get decision() { return last; }, get urls() { return urls; } };
  }

  return { TIMEOUT_MS, MAX_PARTS, CARD_SCREENS, checksum, family, validId, cardId, createAssembler, createDisplay, prune, createCardView };
});
