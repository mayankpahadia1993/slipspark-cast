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
    cricketDuelResult: document.getElementById("duel-result-screen")
  };

  function element(id) { return document.getElementById(id); }
  function text(id, value) { element(id).textContent = value == null ? "" : String(value); }
  function setVisible(target, visible) { target.hidden = !visible; }

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
    text("positioning-title", positioning.instruction.toUpperCase());
    text("positioning-status", positioning.isReady ? "✓ STARTING FIGHT…" : "TRACKING FROM IPHONE");
    element("positioning-frame").classList.toggle("is-ready", positioning.isReady);
    renderSkeleton(positioning.joints || {});
  }

  function renderFight(fight) {
    text("score", fight.score.toLocaleString("en-US"));
    text("combo", fight.combo > 1.01 ? `×${fight.combo.toFixed(2)}` : "");
    text("timer", core.formatTime(fight.timeRemaining));
    text("round", fight.currentRound > 1 || fight.timeRemaining > 60 ? `ROUND ${fight.currentRound}` : "");
    text("opponent-name", fight.opponentName.toUpperCase());
    element("player-health").style.width = `${fight.playerHealth}%`;
    element("opponent-health").style.width = `${fight.opponentHealth}%`;
    element("player-figure").className = `fighter player-figure pose-${fight.playerAction}`;
    element("opponent-figure").className = `fighter opponent-figure style-${fight.opponentStyle}${fight.opponentHit ? " is-hit" : ""}`;

    const glove = element("incoming-glove");
    glove.className = `incoming-glove attack-${fight.currentAttack}${fight.attackCommitted ? " is-impact" : ""}`;
    glove.style.setProperty("--telegraph-duration", `${fight.telegraphDuration}s`);
    glove.hidden = !(fight.phase === "telegraph" || fight.phase === "defend");

    const target = element("punch-target");
    target.hidden = !(fight.phase === "counter" || fight.phase === "opening");
    target.classList.toggle("target-left", fight.phase === "opening" && /LEFT|JAB/.test(fight.phaseValue || ""));
    target.classList.toggle("target-right", fight.phase === "opening" && /RIGHT|CROSS/.test(fight.phaseValue || ""));

    const callout = element("action-callout");
    setVisible(callout, true);
    callout.className = `action-callout phase-${fight.phase}`;
    let title = fight.phaseValue || "";
    let detail = fight.phaseDetail || "";
    if (fight.phase === "telegraph" || fight.phase === "defend") {
      title = (fight.phaseDetail || "MOVE").toUpperCase();
      detail = fight.phase === "defend" ? "NOW!" : "GET READY";
    }
    if (fight.phase === "feedback") title = title.toUpperCase();
    const comboProgress = fight.comboStep && fight.comboTotal ? ` · ${fight.comboStep}/${fight.comboTotal}` : "";
    text("action-title", title);
    text("action-detail", `${detail}${comboProgress}`);
  }

  function renderCricket(cricket) {
    text("cricket-runs", cricket.runs.toLocaleString("en-US"));
    text("cricket-wickets", `${cricket.wicketsLost}/${cricket.wicketLimit}`);
    text("cricket-ball", `BALL ${Math.min(cricket.ballsFaced + 1, cricket.totalBalls)}/${cricket.totalBalls}`);
    text("cricket-chase", cricket.runsNeeded == null ? "" : `NEED ${cricket.runsNeeded} OFF ${cricket.ballsRemaining}`);
    text("cricket-title", (cricket.phaseValue || "").toUpperCase());
    text("cricket-detail", (cricket.phaseDetail || "").toUpperCase());
  }

  function renderVersusSetup(setup) {
    text("versus-setup-title", setup.instruction.toUpperCase());
    element("red-corner-guide").classList.toggle("is-ready", setup.isLeftReady);
    element("blue-corner-guide").classList.toggle("is-ready", setup.isRightReady);
    element("red-corner-guide").querySelector("span").textContent = setup.isLeftReady ? "READY" : "STEP IN";
    element("blue-corner-guide").querySelector("span").textContent = setup.isRightReady ? "READY" : "STEP IN";
    text("versus-setup-status", setup.isReady ? "✓ STARTING FIGHT…" : "ONE FIGHTER IN EACH FRAME");
  }

  function renderVersus(versus) {
    text("versus-left-score", versus.left.score.toLocaleString("en-US"));
    text("versus-right-score", versus.right.score.toLocaleString("en-US"));
    text("versus-timer", core.formatTime(versus.timeRemaining));
    element("versus-left-health").style.width = `${versus.left.health}%`;
    element("versus-right-health").style.width = `${versus.right.health}%`;
    element("versus-left-figure").className = `versus-figure red pose-${versus.left.action}`;
    element("versus-right-figure").className = `versus-figure blue pose-${versus.right.action}`;
    let title = versus.phaseValue || "";
    let detail = versus.phaseDetail || "";
    if (versus.phase === "telegraph" || versus.phase === "defend") {
      title = (versus.phaseDetail || "MOVE").toUpperCase();
      detail = versus.phase === "defend" ? "NOW — BOTH PLAYERS" : "GET READY";
    }
    const comboProgress = versus.comboStep && versus.comboTotal ? ` · ${versus.comboStep}/${versus.comboTotal}` : "";
    text("versus-title", title.toUpperCase());
    text("versus-detail", `${detail}${comboProgress}`.toUpperCase());
    text("versus-left-feedback", versus.left.feedback || "");
    text("versus-right-feedback", versus.right.feedback || "");
  }

  function renderResult(result) {
    text("result-mode", result.mode);
    text("result-headline", result.headline.toUpperCase());
    text("result-score", result.score.toLocaleString("en-US"));
    text("result-caption", result.caption);
    const host = element("result-stats");
    host.replaceChildren(...result.stats.map((stat) => {
      const card = document.createElement("div");
      card.className = "result-stat";
      const value = document.createElement("strong");
      value.textContent = stat.value;
      const label = document.createElement("span");
      label.textContent = stat.label;
      card.append(value, label);
      return card;
    }));
  }

  function renderVersusResult(result) {
    text("versus-result-headline", result.headline);
    text("versus-result-detail", result.detail);
    text("versus-result-left-score", result.leftScore.toLocaleString("en-US"));
    text("versus-result-right-score", result.rightScore.toLocaleString("en-US"));
    text("versus-result-left-stats", `${result.leftDefense}% DEFENSE · ${result.leftCounters} COUNTERS`);
    text("versus-result-right-stats", `${result.rightDefense}% DEFENSE · ${result.rightCounters} COUNTERS`);
    element("versus-result-left").classList.toggle("is-winner", result.winner === "left");
    element("versus-result-right").classList.toggle("is-winner", result.winner === "right");
  }

  function renderDuelHandoff(handoff) {
    // Play a friend names who bats next and says where the chase goes.
    text("duel-handoff-title", handoff.title || "PLAYER 2 — YOUR CHASE");
    text("duel-target", handoff.target.toLocaleString("en-US"));
    text("duel-rules", handoff.rules || `${handoff.balls} BALLS · ${handoff.wickets} WICKETS · SAME DELIVERIES`);
    text("duel-handoff-note", handoff.note || "Raise both hands at the crease to begin");
  }

  function renderDuelResult(result) {
    text("duel-result-eyebrow", result.eyebrow || "CHASE DUEL");
    text("duel-result-first-name", result.firstName || "PLAYER 1");
    text("duel-result-second-name", result.secondName || "PLAYER 2");
    text("duel-result-note", result.note || "Raise both hands for another duel");
    text("duel-result-headline", result.headline);
    text("duel-result-margin", result.margin);
    text("duel-result-first-score", result.firstRuns.toLocaleString("en-US"));
    text("duel-result-second-score", result.secondRuns.toLocaleString("en-US"));
    text("duel-result-first-wickets", `${result.firstWickets} WICKET${result.firstWickets === 1 ? "" : "S"} DOWN`);
    text("duel-result-second-wickets", `${result.secondWickets} WICKET${result.secondWickets === 1 ? "" : "S"} DOWN`);
    element("duel-result-first").classList.toggle("is-winner", result.winner === "first");
    element("duel-result-second").classList.toggle("is-winner", result.winner === "second");
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
