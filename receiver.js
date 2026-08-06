(function () {
  "use strict";

  const NAMESPACE = "urn:x-cast:com.slipspark.game";
  const core = window.SlipSparkReceiverCore;
  const app = document.getElementById("app");
  const readyScreen = document.getElementById("ready-screen");
  const positioningScreen = document.getElementById("positioning-screen");
  const fightScreen = document.getElementById("fight-screen");

  function text(id, value) {
    document.getElementById(id).textContent = value == null ? "" : String(value);
  }

  function setVisible(element, visible) {
    element.hidden = !visible;
  }

  function renderSkeleton(joints) {
    const fallback = {
      nose: [200, 118], neck: [200, 172], leftShoulder: [132, 208], rightShoulder: [268, 208],
      leftElbow: [92, 320], rightElbow: [308, 320], leftWrist: [142, 250], rightWrist: [258, 250],
      root: [200, 430], leftHip: [155, 470], rightHip: [245, 470]
    };
    const positions = {};
    Object.keys(fallback).forEach((name) => {
      const joint = joints[name];
      positions[name] = joint && Number(joint.confidence) >= 0.2
        ? [40 + Number(joint.x) * 320, 40 + (1 - Number(joint.y)) * 560]
        : fallback[name];
      const circle = document.querySelector(`[data-joint="${name}"]`);
      if (circle) {
        circle.setAttribute("cx", positions[name][0]);
        circle.setAttribute("cy", positions[name][1]);
        circle.style.opacity = joint ? "1" : ".82";
      }
    });
    document.querySelectorAll("[data-bone]").forEach((line) => {
      const names = line.getAttribute("data-bone").split("-");
      const start = positions[names[0]];
      const end = positions[names[1]];
      if (!start || !end) return;
      line.setAttribute("x1", start[0]); line.setAttribute("y1", start[1]);
      line.setAttribute("x2", end[0]); line.setAttribute("y2", end[1]);
    });
  }

  function renderPositioning(positioning) {
    const isReady = positioning.isReady;
    text("positioning-title", positioning.instruction.toUpperCase());
    text("positioning-status", isReady ? "✓ STARTING FIGHT…" : "TRACKING FROM IPHONE");
    document.getElementById("positioning-frame").classList.toggle("is-ready", isReady);
    renderSkeleton(positioning.joints || {});
  }

  function renderFight(fight) {
    text("score", fight.score.toLocaleString("en-US"));
    text("combo", fight.combo > 1.01 ? `×${fight.combo.toFixed(2)}` : "");
    text("timer", core.formatTime(fight.timeRemaining));
    text("round", fight.currentRound > 1 || fight.timeRemaining > 60 ? `ROUND ${fight.currentRound}` : "");
    text("opponent-name", fight.opponentName.toUpperCase());
    document.getElementById("player-health").style.width = `${fight.playerHealth}%`;
    document.getElementById("opponent-health").style.width = `${fight.opponentHealth}%`;

    const player = document.getElementById("player-figure");
    player.className = `fighter player-figure pose-${fight.playerAction}`;
    const opponent = document.getElementById("opponent-figure");
    opponent.className = `fighter opponent-figure style-${fight.opponentStyle}${fight.opponentHit ? " is-hit" : ""}`;

    const glove = document.getElementById("incoming-glove");
    glove.className = `incoming-glove attack-${fight.currentAttack}${fight.attackCommitted ? " is-impact" : ""}`;
    glove.style.setProperty("--telegraph-duration", `${fight.telegraphDuration}s`);
    const showGlove = fight.phase === "telegraph" || fight.phase === "defend";
    glove.hidden = !showGlove;

    const target = document.getElementById("punch-target");
    target.hidden = !(fight.phase === "counter" || fight.phase === "opening");
    target.classList.toggle("target-left", fight.phase === "opening" && /LEFT|JAB/.test(fight.phaseValue || ""));
    target.classList.toggle("target-right", fight.phase === "opening" && /RIGHT|CROSS/.test(fight.phaseValue || ""));

    const showCallout = ["ready", "countdown", "telegraph", "defend", "counter", "opening", "feedback", "trackingPaused", "roundBreak", "finished"].includes(fight.phase);
    const callout = document.getElementById("action-callout");
    setVisible(callout, showCallout);
    callout.className = `action-callout phase-${fight.phase}`;
    let title = fight.phaseValue || "";
    let detail = fight.phaseDetail || "";
    if (fight.phase === "telegraph" || fight.phase === "defend") {
      title = (fight.phaseDetail || "MOVE").toUpperCase();
      detail = fight.phase === "defend" ? "NOW!" : "GET READY";
    }
    if (fight.phase === "feedback") title = title.toUpperCase();
    text("action-title", title);
    const comboProgress = fight.comboStep && fight.comboTotal ? ` · ${fight.comboStep}/${fight.comboTotal}` : "";
    text("action-detail", `${detail}${comboProgress}`);
  }

  function render(rawState) {
    const state = core.normalizeState(rawState);
    window.__slipsparkReceiverState = state;
    app.dataset.screen = state.screen;
    app.dataset.sequence = String(state.sequence);
    app.dataset.phase = state.fight ? state.fight.phase : state.screen;
    setVisible(readyScreen, state.screen === "ready");
    setVisible(positioningScreen, state.screen === "positioning");
    setVisible(fightScreen, state.screen === "fight");
    if (state.positioning) renderPositioning(state.positioning);
    if (state.fight) renderFight(state.fight);
  }

  const preview = new URLSearchParams(window.location.search).get("preview");
  render(core.sampleState(preview || "ready"));

  if (!preview && window.cast && window.cast.framework) {
    const context = window.cast.framework.CastReceiverContext.getInstance();
    context.addCustomMessageListener(NAMESPACE, (event) => render(core.parseMessage(event.data)));
    const options = new window.cast.framework.CastReceiverOptions();
    options.customNamespaces = {};
    options.customNamespaces[NAMESPACE] = window.cast.framework.system.MessageType.JSON;
    options.disableIdleTimeout = true;
    options.skipPlayersLoad = true;
    options.statusText = "SlipSpark is ready";
    context.setApplicationState("SlipSpark is ready");
    context.start(options);
  }
})();
