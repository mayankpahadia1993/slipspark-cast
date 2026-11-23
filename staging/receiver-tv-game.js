(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RallycadeTVGame = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  // A game on the TV (receiver 109, Nov 22 2026; docs/design/CAST_SCENE.md "Adding a game to the TV"): the owner, "There
  // are other changes we have made in cricket that helps with lags etc. Let's port all of them to Pickleball as well.
  // And let's do it in a generic way so that newer games always get these fixes when relevant" and "don't change cricket
  // too much. Import from cricket directly."
  //
  // This is a thin layer over cricket's own functions (receiver-scene-core.js, `RallycadeSceneCore`, live in production)
  // that any game other than cricket's stadium draws through. Nothing here is a copy: each piece calls cricket's.
  //
  //   plan(device)        the canvas plan: cricket's canvasPlan (weak dongle 854, Linux dongles 1280, Android TVs 1920
  //                       watched), with the width cricket's stadium settled on for this TV (rememberedCanvas) and the
  //                       game's own memory, so a TV the stadium found slow starts narrow in every game
  //   width(box, dpr, plan)  cricket's canvasWidth
  //   createPerf(options)    per animation frame `frame(now, drew, width)`: cricket's createRateWatch; true when a wide
  //                       canvas should narrow to 1280 for good (`narrowed()` gives the plan, remembered for this game)
  //   report(stats, state)   cricket's warmReport: a report taken in the first 8 s while pictures still load says
  //                       `warm`, its rate as `wfps`/`wgap`, so no phone paces from it; `weak: 1` on a weak plan
  //
  // The phones' side is the same idea: iOS `CastGamePace`, Android core `CastGamePace`, over cricket's CastPace.
  // CastReceiverTests/cast-game-contract.test.cjs fails when a game's receiver or stream goes round these.

  function scene() {
    const core = root && root.RallycadeSceneCore;
    if (core) return core;
    if (typeof require === "function") { try { return require("./receiver-scene-core.js"); } catch (error) { return null; } }
    return null;
  }

  // localStorage keys: cricket's (read only) and the game's own.
  function keys(game, pathname) {
    const core = scene();
    const names = core.storageNames(pathname);
    return { cricket: names.canvas, own: names.canvas + "-" + String(game || "game") };
  }

  function read(storage, key) {
    try { return JSON.parse((storage && storage.getItem(key)) || "null"); } catch (error) { return null; }
  }

  // What this TV settled on before: the narrower of cricket's stadium's memory and the game's own, when either is
  // this TV's (same user agent).
  function remembered(game, ua, storage, pathname) {
    const k = keys(game, pathname);
    const found = [read(storage, k.cricket), read(storage, k.own)].filter((entry) => entry && entry.ua === ua && Number(entry.width) > 0);
    if (!found.length) return null;
    return found.reduce((a, b) => (Number(b.width) < Number(a.width) ? b : a));
  }

  // `device`: {game, ua, weak, pinned, wide (default true: every game's phones allow 1920), storage, pathname}.
  function plan(device) {
    const d = device || {};
    const core = scene();
    const ua = String(d.ua || "");
    return core.canvasPlan({ ua, weak: !!d.weak, pinned: d.pinned, wide: d.wide !== false, remembered: remembered(d.game, ua, d.storage, d.pathname) });
  }

  function width(box, pixelRatio, chosen) {
    return scene().canvasWidth(box, pixelRatio, chosen && chosen.width);
  }

  // `options`: {game, ua, storage, pathname, minFps}.
  function createPerf(options) {
    const o = options || {};
    const core = scene();
    const watch = core.createRateWatch({ minFps: o.minFps || core.CANVAS.minFps });
    let narrowedPlan = null;
    return {
      watch,
      // One animation frame at `now` (ms), `drew` whether it drew, on a plan and canvas `canvasWidth` wide: true once,
      // when the canvas should narrow (as cricket's stadium: `plan.adaptive && canvas.width > CANVAS.narrow`).
      frame(now, drew, chosen, canvasWidth) {
        if (narrowedPlan || !chosen || !chosen.adaptive || !(canvasWidth > core.CANVAS.narrow)) return false;
        if (!watch.tick(now, drew)) return false;
        narrowedPlan = { width: core.CANVAS.narrow, adaptive: false, why: "slow", weak: false };
        try { if (o.storage) o.storage.setItem(keys(o.game, o.pathname).own, JSON.stringify({ ua: String(o.ua || ""), width: core.CANVAS.narrow })); } catch (error) { /* measured again next cast */ }
        return true;
      },
      narrowed() { return narrowedPlan; },
      reset() { watch.reset(); }
    };
  }

  // `stats` as measured; `state` as cricket's warmReport takes it ({sinceOn, uploading, received, loading, missing});
  // `weak`: the TV draws its weak plan.
  function report(stats, state, weak) {
    const out = scene().warmReport(stats, state || {});
    if (weak) return Object.assign(out === stats ? Object.assign({}, stats) : out, { weak: 1 });
    return out;
  }

  return { plan, width, createPerf, report, remembered, keys };
});
