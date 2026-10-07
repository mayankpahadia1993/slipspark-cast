(function () {
  "use strict";

  const NAMESPACE = "urn:x-cast:com.slipspark.game";
  const core = window.SlipSparkReceiverCore;
  const app = document.getElementById("app");
  const screens = {
    ready: document.getElementById("ready-screen"),
    positioning: document.getElementById("positioning-screen"),
    fight: document.getElementById("fight-screen"),
    cricket: document.getElementById("cricket-screen"),
    versusSetup: document.getElementById("versus-setup-screen"),
    versus: document.getElementById("versus-screen"),
    result: document.getElementById("result-screen"),
    versusResult: document.getElementById("versus-result-screen"),
    cricketDuelHandoff: document.getElementById("duel-handoff-screen"),
    cricketDuelResult: document.getElementById("duel-result-screen"),
    timingCheck: document.getElementById("timing-check-screen")
  };

  function element(id) { return document.getElementById(id); }
  function text(id, value) { element(id).textContent = value == null ? "" : String(value); }
  function setVisible(target, visible) { target.hidden = !visible; }

  // The hold ring (index.html `.hold`): fills while both hands stay up.
  const RING = 276.5;
  function renderHold(container, progress, label) {
    const value = Math.max(0, Math.min(1, Number(progress) || 0));
    container.classList.toggle("is-holding", value > 0);
    container.querySelector(".hold-fill").style.strokeDashoffset = String(RING * (1 - value));
    container.querySelector(".hold-label").textContent = value > 0 ? "Keep holding" : label;
  }
  window.RallycadeHold = renderHold;

  // Setup: the phone's words and its hold ring. Never the batter's skeleton.
  function renderPositioning(positioning) {
    text("positioning-eyebrow", positioning.eyebrow || "FIND YOUR CREASE");
    text("positioning-title", positioning.title || positioning.instruction);
    text("positioning-detail", positioning.detail || "");
    element("positioning-detail").hidden = !positioning.detail;
    text("positioning-hand", positioning.hand || "");
    element("positioning-hand").hidden = !positioning.hand;
    const hold = element("positioning-hold");
    hold.hidden = !positioning.canHold;
    if (positioning.canHold) renderHold(hold, positioning.progress, "Raise both hands and hold");
  }

  const VERDICT_WORDS = {
    early: ["Early", "far"], littleEarly: ["Bit early", "little"], perfect: ["Perfect", "perfect"],
    littleLate: ["Bit late", "little"], late: ["Late", "far"], noSwing: ["No swing", "none"]
  };

  function renderTimingCheck(check) {
    text("timing-headline", check.headline);
    text("timing-detail", check.detail || "");
    element("timing-detail").hidden = !check.detail;
    element("timing-balls").replaceChildren(...check.verdicts.map((verdict, index) => {
      const [word, kind] = VERDICT_WORDS[verdict] || VERDICT_WORDS.noSwing;
      const chip = document.createElement("span");
      chip.className = `timing-chip verdict-${kind}`;
      const number = document.createElement("b");
      number.textContent = String(index + 1);
      chip.append(number, document.createTextNode(word));
      return chip;
    }));
    element("timing-lines").replaceChildren(...check.lines.map((line) => {
      const item = document.createElement("li");
      item.textContent = line;
      return item;
    }));
    text("timing-note", check.note);
  }

  function render(rawState) {
    const state = core.normalizeState(rawState);
    window.__slipsparkReceiverState = state;
    app.dataset.screen = state.screen;
    app.dataset.sequence = String(state.sequence);
    app.dataset.phase = state.fight?.phase || state.cricket?.phase || state.versus?.phase || state.screen;
    Object.entries(screens).forEach(([name, screen]) => setVisible(screen, name === state.screen));
    if (state.positioning) renderPositioning(state.positioning);
    if (state.fight) renderFight(state.fight);
    if (state.cricket) renderCricket(state.cricket);
    if (state.versusSetup) renderVersusSetup(state.versusSetup);
    if (state.versus) renderVersus(state.versus);
    if (state.result) renderResult(state.result);
    if (state.versusResult) renderVersusResult(state.versusResult);
    if (state.cricketDuelHandoff) renderDuelHandoff(state.cricketDuelHandoff);
    if (state.cricketDuelResult) renderDuelResult(state.cricketDuelResult);
    if (state.timingCheck) renderTimingCheck(state.timingCheck);
  }

  const query = new URLSearchParams(window.location.search);
  const preview = query.get("preview");
  render(core.sampleState(preview || "ready"));

  // The stadium the TV draws itself, from the phone's drawing commands.
  const sceneModule = window.RallycadeReceiverScene;
  let sceneSender = null;
  let sendScene = () => {};
  const scene = sceneModule && sceneModule.createScene({
    root: document.getElementById("scene"),
    canvas: document.getElementById("scene-canvas"),
    stage: document.getElementById("scene-stage"),
    backdrop: document.getElementById("scene-backdrop"),
    hud: document.getElementById("scene-hud"),
    send: (message) => sendScene(message)
  });
  window.__rallycadeScene = scene;

  // ?scene=<recording.json> plays frames recorded from the phone, for
  // checking the drawing in a browser (scripts/cast-scene-check).
  if (scene && query.get("scene")) {
    if (query.get("hud") === "0") document.getElementById("scene-hud").hidden = true;
    scene.playRecordingAt(query.get("scene"), Number(query.get("at") || -1));
  }

  if (!preview && !query.get("scene") && window.cast && window.cast.framework) {
    const context = window.cast.framework.CastReceiverContext.getInstance();
    let reportFailure = () => {};
    context.addCustomMessageListener(NAMESPACE, (event) => {
      try { render(core.parseMessage(event.data)); } catch (error) { reportFailure("render", error); }
    });
    // The phone's own picture, when it streams one; the scoreboard above
    // stays underneath as the fallback.
    const videoModule = window.RallycadeReceiverVideo;
    let videoSender = null;
    let statusLine = null;
    const player = videoModule && videoModule.createPlayer(
      document.getElementById("stream"),
      (message) => { if (videoSender) context.sendCustomMessage(videoModule.NAMESPACE, videoSender, message); },
      (isLive) => { document.body.dataset.video = isLive ? "on" : "off"; },
      (text) => {
        // TestFlight phones ask for the player's counters on screen.
        if (!statusLine) {
          statusLine = document.createElement("div");
          statusLine.id = "stream-status";
          document.body.appendChild(statusLine);
        }
        statusLine.textContent = text;
      }
    );
    if (player) {
      reportFailure = player.report;
      context.addCustomMessageListener(videoModule.NAMESPACE, (event) => {
        videoSender = event.senderId;
        try { player.handle(event.data); } catch (error) { player.report("handle", error); }
      });
      // Any script failure on the TV reaches the phone's log.
      window.addEventListener("error", (event) => player.report("script", event.message + " @" + event.lineno));
      window.addEventListener("unhandledrejection", (event) => player.report("promise", event.reason));
    }
    if (scene) {
      sendScene = (message) => {
        if (sceneSender) context.sendCustomMessage(sceneModule.NAMESPACE, sceneSender, message);
      };
      context.addCustomMessageListener(sceneModule.NAMESPACE, (event) => {
        // A snapshot goes back to whoever asked (a test bench beside the
        // phone), which never becomes the stadium's sender.
        if (event.data && event.data.t === "snap") {
          scene.snapshot(event.data.q, (message) => context.sendCustomMessage(sceneModule.NAMESPACE, event.senderId, message));
          return;
        }
        sceneSender = event.senderId;
        try { scene.handle(event.data); } catch (error) { scene.report("handle", error); }
      });
      window.addEventListener("error", (event) => scene.report("script", event.message + " @" + event.lineno));
      // A phone that leaves takes its stadium with it.
      context.addEventListener(window.cast.framework.system.EventType.SENDER_DISCONNECTED, (event) => {
        if (event.senderId === sceneSender) { sceneSender = null; scene.setOn(false); }
      });
    }
    const options = new window.cast.framework.CastReceiverOptions();
    options.customNamespaces = {};
    options.customNamespaces[NAMESPACE] = window.cast.framework.system.MessageType.JSON;
    if (videoModule) options.customNamespaces[videoModule.NAMESPACE] = window.cast.framework.system.MessageType.JSON;
    if (scene) options.customNamespaces[sceneModule.NAMESPACE] = window.cast.framework.system.MessageType.JSON;
    options.disableIdleTimeout = true;
    options.skipPlayersLoad = true;
    options.statusText = "Rallycade is ready";
    context.setApplicationState("Rallycade is ready");
    context.start(options);
  }
})();
