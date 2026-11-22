(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RallycadeSplit = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // A two-player split screen on the TV (receiver 108, Nov 22 2026), for any game: the owner picked "option 3" for
  // pickleball's Side by Side ("Wii / Nex and other games have already solved for this"), and asked for it in pieces any
  // game can use ("So that things from cricket can be reused in other games like pickleball too"). The game draws each
  // half's picture itself; this draws what goes over both halves, the couch-game way:
  //
  //  - one top bar across the TV: each player's name, colour and score on their own side, a dot on the server's, and a
  //    word in the middle (the game's: a level, "PAUSED");
  //  - a thin divider down the middle, and each half edged in its player's colour, with their name tag at the bottom;
  //  - a prompt only in the half it concerns, small, near the bottom ("Step into the camera's view").
  //
  // The left half is the player standing on the left as they face the TV: the phone sends the halves in that order and
  // this never reorders them. The phone sends it all as one object (a frame HUD's `ss`, to a TV whose ready says
  // `ss: 1`); older TVs ignore it, and phones that don't send it get the game's own split HUD.
  //
  //   { n: [name, name], s: [score, score], v: serving half (0, 1, or -1 for none), c: ["#rrggbb", "#rrggbb"],
  //     m: [prompt, prompt] ("" for none), l: the middle word }

  const STAGE = { width: 1280, height: 720 };
  // Player 1 navy, Player 2 coral: the kits' own colours (PickleballKit), when the phone names none.
  const COLOURS = ["#2B4C8C", "#EF6F5C"];
  const MAX_NAME = 16, MAX_PROMPT = 60, MAX_LABEL = 24;

  function text(value, max) {
    return typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, max) : "";
  }

  // The wire's `ss` as the screen draws it: two sides (left first), the middle word. Null without two names.
  function splitView(ss) {
    if (!ss || typeof ss !== "object" || !Array.isArray(ss.n) || ss.n.length < 2) return null;
    const serving = ss.v === 0 || ss.v === 1 ? ss.v : -1;
    const sides = [0, 1].map((i) => {
      const colour = Array.isArray(ss.c) && /^#[0-9a-f]{6}$/i.test(String(ss.c[i])) ? String(ss.c[i]).toUpperCase() : COLOURS[i];
      const score = Array.isArray(ss.s) && Number.isFinite(Number(ss.s[i])) ? Math.max(0, Math.round(Number(ss.s[i]))) : 0;
      return { name: text(ss.n[i], MAX_NAME) || "PLAYER " + (i + 1), score, colour, serving: serving === i,
        prompt: Array.isArray(ss.m) ? text(ss.m[i], MAX_PROMPT) : "" };
    });
    return { sides, label: text(ss.l, MAX_LABEL) };
  }

  // The screen's layer: `host` (an element over the game's halves, the TV's size) gets it, a 1280 x 720 box scaled to
  // the host's width (`fit`). Each piece changes only when its words do (a weak dongle repaints nothing else).
  function createSplitScreen(host) {
    if (!host || typeof document === "undefined") return { render() {}, fit() {}, hide() {}, shown: () => false, layer: null };
    const make = (tag, className, parent) => { const node = document.createElement(tag); node.className = className; (parent || layer).append(node); return node; };
    const layer = document.createElement("div");
    layer.className = "ss";
    layer.hidden = true;
    host.append(layer);
    const frames = [make("div", "ss-frame ss-l"), make("div", "ss-frame ss-r")];
    make("div", "ss-divider");
    const bar = make("div", "ss-bar");
    const side = (cls) => {
      const box = make("div", "ss-side " + cls, bar);
      const parts = { serve: make("i", "ss-serve", box), name: make("span", "ss-name", box), chip: make("i", "ss-chip", box), score: make("b", "ss-score", box) };
      return Object.assign(parts, { box });
    };
    const left = side("ss-l");
    const middle = make("span", "ss-mid", bar);
    const right = side("ss-r");
    // The right side reads outward from the middle: score, chip, name, serve.
    right.box.append(right.score, right.chip, right.name, right.serve);
    const tags = [make("div", "ss-tag ss-l"), make("div", "ss-tag ss-r")];
    const prompts = [make("div", "ss-prompt ss-l"), make("div", "ss-prompt ss-r")];
    const shown = {};
    const set = (key, value, apply) => { if (shown[key] !== value) { shown[key] = value; apply(value); } };
    const words = (node, value) => { if (node.textContent !== value) node.textContent = value; };

    function render(view) {
      if (!view) { hide(); return; }
      layer.hidden = false;
      set("label", view.label, (v) => { words(middle, v); middle.hidden = !v; });
      [left, right].forEach((parts, i) => {
        const s = view.sides[i];
        set("name" + i, s.name, (v) => { words(parts.name, v); words(tags[i], v); });
        set("score" + i, s.score, (v) => words(parts.score, String(v)));
        set("serve" + i, s.serving, (v) => parts.serve.classList.toggle("on", v));
        set("colour" + i, s.colour, (v) => {
          parts.chip.style.background = v; tags[i].style.background = v; frames[i].style.borderColor = v; prompts[i].style.borderColor = v;
        });
        set("prompt" + i, s.prompt, (v) => { words(prompts[i], v); prompts[i].hidden = !v; });
      });
    }
    function hide() { layer.hidden = true; }
    function fit(width) {
      const scale = (width || STAGE.width) / STAGE.width;
      set("scale", scale, (v) => { layer.style.transform = "scale(" + v + ")"; });
    }
    return { render, fit, hide, shown: () => !layer.hidden, layer };
  }

  return { STAGE, COLOURS, splitView, createSplitScreen };
});
