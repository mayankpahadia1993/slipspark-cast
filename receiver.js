(function () {
  "use strict";

  const NAMESPACE = "urn:x-cast:com.slipspark.game";
  // How long a disconnected phone's stadium stays on screen.
  const SCENE_GRACE_MS = 20000;
  const core = window.SlipSparkReceiverCore;
  const app = document.getElementById("app");
  const screens = {
    ready: document.getElementById("ready-screen"),
    positioning: document.getElementById("positioning-screen"),
    // Play has no HTML board (Oct 18 2026): cricket is the stadium, and
    // until its first frame (or on a phone that can't draw it) the holding
    // screen. Boxing (flagged off) gets the holding screen too.
    fight: document.getElementById("holding-screen"),
    cricket: document.getElementById("holding-screen"),
    versusSetup: document.getElementById("holding-screen"),
    versus: document.getElementById("holding-screen"),
    result: document.getElementById("result-screen"),
    versusResult: document.getElementById("versus-result-screen"),
    cricketDuelHandoff: document.getElementById("duel-handoff-screen"),
    cricketDuelResult: document.getElementById("duel-result-screen"),
    timingCheck: document.getElementById("timing-check-screen")
  };

  function element(id) { return document.getElementById(id); }
  function text(id, value) { element(id).textContent = value == null ? "" : String(value); }
  function setVisible(target, visible) { target.hidden = !visible; }

  // The hold (index.html `.hold`): its words, and once both hands are up a
  // ring that fills while they stay up. No words when `label` is empty.
  const RING = 276.5;
  function renderHold(container, progress, label) {
    const value = Math.max(0, Math.min(1, Number(progress) || 0));
    container.classList.toggle("is-holding", value > 0);
    container.querySelector(".hold-fill").style.strokeDashoffset = String(RING * (1 - value));
    const words = container.querySelector(".hold-label");
    words.textContent = label || "";
    words.hidden = !label;
  }
  window.RallycadeHold = renderHold;

  // Build 153: a chase's target is a surprise until the crease, and even
  // there it lands a beat after the line ("… · ? TO WIN" → "… · 24 TO WIN"),
  // as on the phone (TargetRevealText).
  let eyebrowShown = null, eyebrowReveal = null;
  function renderEyebrow(line) {
    if (line === eyebrowShown) return;
    eyebrowShown = line;
    clearTimeout(eyebrowReveal);
    const hidden = core.hideTarget(line);
    text("positioning-eyebrow", hidden || line);
    if (hidden) eyebrowReveal = setTimeout(() => text("positioning-eyebrow", line), core.TARGET_REVEAL_MS);
  }

  // Setup: the phone's words and its hold ring. Never the batter's skeleton.
  function renderPositioning(positioning) {
    renderEyebrow(positioning.eyebrow || "FIND YOUR CREASE");
    text("positioning-title", positioning.title || positioning.instruction);
    text("positioning-detail", positioning.detail || "");
    element("positioning-detail").hidden = !positioning.detail;
    text("positioning-hand", positioning.hand || "");
    element("positioning-hand").hidden = !positioning.hand;
    const hold = element("positioning-hold");
    hold.hidden = !positioning.canHold;
    if (positioning.canHold) renderHold(hold, positioning.progress, positioning.holdLabel || "Raise both hands to play");
  }

  // The holding screen: play is on but the stadium isn't up (its first
  // frame not yet drawn, the phone reconnecting, or a phone too old to send
  // one). The score as it stands, never a call to watch a ball it can't show.
  const PLAY_SCREENS = new Set(["cricket", "fight", "versus", "versusSetup"]);
  function holdingWords(state, reconnecting, drawsStadium) {
    if (state.screen !== "cricket") {
      return { status: "ON YOUR PHONE", title: "Boxing is on<br>your phone", detail: "The TV shows the stadium for cricket.", score: "" };
    }
    const cricket = state.cricket || {};
    const balls = Number(cricket.totalBalls) || 0;
    const ball = balls ? "BALL " + Math.min((Number(cricket.ballsFaced) || 0) + 1, balls) + " OF " + balls : "";
    const score = [cricket.runs != null ? cricket.runs + "/" + (cricket.wicketsLost || 0) : "", ball].filter(Boolean).join(" · ");
    // A phone that never said hello on the stadium's channel (older than
    // build 121, 2026's App Store builds all draw it): play stays on it.
    if (!drawsStadium && !reconnecting) {
      return { status: "ON YOUR PHONE", title: "Your innings is<br>on your phone", detail: "Update RallyCade to see the stadium on your TV.", score };
    }
    return reconnecting
      ? { status: "RECONNECTING", title: "Reconnecting to<br>your phone", detail: "The innings carries on on your phone.", score }
      : { status: "STADIUM LOADING", title: "Your stadium<br>is on its way", detail: "Keep playing on your phone.", score };
  }
  let holdingShown = "";
  function renderHolding(state, reconnecting) {
    const words = holdingWords(state, reconnecting, stadiumPhone);
    // Game states come 10–30 a second: the page is written only when its words change.
    const key = JSON.stringify(words);
    if (key === holdingShown) return;
    holdingShown = key;
    text("holding-status", words.status);
    element("holding-title").innerHTML = words.title;
    text("holding-detail", words.detail);
    text("holding-score", words.score);
    element("holding-score").hidden = !words.score;
  }
  window.RallycadeHoldingWords = holdingWords;

  function renderResult(result) {
    text("result-mode", result.mode);
    const headline = result.headline.toUpperCase();
    text("result-headline", headline);
    // Sized by its length (build 153): one line if it can, two at most.
    const size = core.resultHeadlineSize(headline, window.innerWidth || 1280);
    element("result-headline").style.fontSize = size.fontPx + "px";
    text("result-score", result.score.toLocaleString("en-US"));
    text("result-caption", result.caption);
    // Build 123 phones send the innings' own score and words ("97/1",
    // "Raise both hands to bat again"); older ones only the number.
    if (result.scoreText) text("result-score", result.scoreText);
    text("result-hint", result.hint || "Raise both hands to go again · Results saved on your phone");
    const reward = element("result-reward");
    reward.hidden = !result.reward;
    if (result.reward) {
      text("result-reward-title", result.reward.title);
      text("result-reward-xp", `+${result.reward.xp.toLocaleString("en-US")} XP`);
      text("result-reward-coins", `+${result.reward.coins.toLocaleString("en-US")} coins`);
      text("result-reward-detail", result.reward.detail);
      const level = element("result-reward-level");
      level.hidden = !result.reward.levelUp;
      text("result-reward-level", result.reward.levelUp);
      element("result-reward-milestones").replaceChildren(...(result.reward.milestones || []).map((line) => {
        const item = document.createElement("li");
        item.textContent = line;
        return item;
      }));
    }
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

  // Build 154: a result is the phone's own scorecard picture when the phone
  // sends one (receiver-card-core.js); this page's result screens stay
  // underneath for older phones and as the fallback.
  const cardCore = window.RallycadeCardCore;
  // The setup's ring (index.html `#card-ring`): the phone's StadiumHoldRing,
  // a circle with its stroke a tenth of its size, filling clockwise from
  // the top.
  const SETUP_RING = 2 * Math.PI * 50;
  function renderRing(ring, place, progress) {
    ring.style.left = place.left + "px";
    ring.style.top = place.top + "px";
    ring.style.width = ring.style.height = place.size + "px";
    const value = Math.max(0, Math.min(1, Number(progress) || 0));
    ring.querySelector(".card-ring-fill").style.strokeDashoffset = String(SETUP_RING * (1 - value));
  }
  // Messages to the phone on the scene channel, once one has said hello.
  let sendScene = () => {};
  const cardView = cardCore && cardCore.createCardView({
    root: element("card"), image: element("card-image"), hold: element("card-hold"), body: document.body,
    ring: element("card-ring"), renderRing, view: () => ({ width: window.innerWidth, height: window.innerHeight }),
    renderHold, now: () => performance.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms), clearTimer: (id) => clearTimeout(id),
    // Receiver 60: the picture's own base64 text as its address; the browser
    // turns it into bytes as it loads it. A script loop did that before, and
    // a Chromecast Ultra spent 40-140 ms on it a picture (a sharp 1920 x 1080
    // one, the first few of a cast) before the picture could show.
    toUrl(data) {
      return "data:image/jpeg;base64," + data;
    },
    revoke(url) { if (url && url.indexOf("blob:") === 0) URL.revokeObjectURL(url); },
    // A phone that draws the stadium: as its innings starts, its setup
    // picture stays up until the stadium draws over it, never the HTML
    // scoreboard (receiver 53).
    holdLast: (state) => !!(state && state.screen === "cricket" && stadiumPhone),
    decode(url) {
      const probe = new Image();
      probe.src = url;
      return probe.decode ? probe.decode() : new Promise((ok, fail) => { probe.onload = ok; probe.onerror = fail; });
    },
    report: (where, error) => cardFailure(where, error),
    // Receiver 60: the phone's log says when each picture reached the TV.
    onShown: (shown) => sendScene({ t: "shown", id: shown.id, w: shown.width, ms: shown.waited })
  });
  let cardFailure = () => {};

  // Receiver 56: the app-open welcome, while the phone plays it.
  const welcomeQuery = new URLSearchParams(window.location.search);
  const welcomeHeld = /^welcome/.test(welcomeQuery.get("preview") || "") && welcomeQuery.get("at") !== null;
  const welcomeModule = window.RallycadeWelcome;
  const welcomeRoot = element("welcome");
  const welcomeView = welcomeModule && welcomeRoot && welcomeModule.createWelcomeView({
    elements: {
      root: welcomeRoot, stage: element("welcome-stage"), canvas: element("welcome-canvas"),
      lit: [...welcomeRoot.querySelectorAll(".welcome-lit")], litAll: element("welcome-lit-all"),
      glows: [...welcomeRoot.querySelectorAll(".welcome-glow")], scrim: element("welcome-scrim"), halo: element("welcome-halo"),
      icon: element("welcome-icon"), wordmark: element("welcome-wordmark"), caption: element("welcome-caption"),
      captionText: element("welcome-caption-text")
    },
    // ?preview=welcome&at=1.3: that moment, held (for pictures of it).
    now: () => (welcomeHeld ? 0 : performance.now()),
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (id) => cancelAnimationFrame(id)
  });
  // A phone has said hello on the scene channel this cast.
  let stadiumPhone = false;
  // The stadium came on during this stretch of play, and the scene's phone left.
  let stadiumThisPlay = false;
  let sceneLost = false;
  let lastState = null;
  // During play with the stadium off after it has been up: its last frame
  // stays with a chip (receiver-scene.js holdLast), never an HTML board.
  function updateHold() {
    const scene = window.__rallycadeScene;
    if (!lastState) return;
    const play = PLAY_SCREENS.has(lastState.screen);
    const held = !!scene && play && stadiumThisPlay && scene.holdLast(sceneLost ? "Reconnecting…" : "Loading the stadium…");
    if (!held && scene && scene.holding) scene.holdLast(null);
    if (play) renderHolding(lastState, sceneLost);
  }

  function render(rawState) {
    const state = core.normalizeState(rawState);
    window.__slipsparkReceiverState = state;
    app.dataset.screen = state.screen;
    app.dataset.sequence = String(state.sequence);
    app.dataset.phase = state.fight?.phase || state.cricket?.phase || state.versus?.phase || state.screen;
    const shown = screens[state.screen];
    new Set(Object.values(screens)).forEach((screen) => setVisible(screen, screen === shown));
    if (state.positioning) renderPositioning(state.positioning);
    lastState = state;
    if (!PLAY_SCREENS.has(state.screen)) stadiumThisPlay = false;
    if (PLAY_SCREENS.has(state.screen)) renderHolding(state, sceneLost);
    updateHold();
    if (state.result) renderResult(state.result);
    if (state.versusResult) renderVersusResult(state.versusResult);
    if (state.cricketDuelHandoff) renderDuelHandoff(state.cricketDuelHandoff);
    if (state.cricketDuelResult) renderDuelResult(state.cricketDuelResult);
    if (state.timingCheck) renderTimingCheck(state.timingCheck);
    if (cardView) cardView.update(state);
    if (welcomeView) welcomeView.update(state);
  }

  const query = new URLSearchParams(window.location.search);
  const preview = query.get("preview");
  if (welcomeHeld) {
    const state = core.sampleState(preview);
    if (state.welcome) state.welcome.elapsed = Math.round(Number(query.get("at")) * 1000);
    render(state);
  } else {
    render(core.sampleState(preview || "ready"));
  }
  // ?preview=…&card=<picture>: that picture as the phone's scorecard.
  if (preview && query.get("card") && cardView) {
    render(Object.assign({}, core.sampleState(preview), { card: "0.0" }));
    cardView.keep("0.0", query.get("card"));
  }
  // ?preview=…&measure=1: the result screen's layout written onto the page,
  // for the receiver render test (a headless browser dumps the page).
  if (preview && query.get("measure")) {
    requestAnimationFrame(() => {
      const shown = screens[core.sampleState(preview).screen];
      const headline = element("result-headline");
      const style = getComputedStyle(headline);
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize);
      const box = shown.getBoundingClientRect();
      const children = [...shown.children].filter((child) => !child.hidden).map((child) => child.getBoundingClientRect());
      const report = {
        width: window.innerWidth, height: window.innerHeight,
        headlineLines: Math.round(headline.getBoundingClientRect().height / lineHeight),
        headlineFont: parseFloat(style.fontSize),
        top: Math.min(...children.map((rect) => rect.top)), bottom: Math.max(...children.map((rect) => rect.bottom)),
        right: Math.max(...children.map((rect) => rect.right)), left: Math.min(...children.map((rect) => rect.left)),
        overflow: shown.scrollHeight > box.height + 1
      };
      document.body.setAttribute("data-measure", JSON.stringify(report));
    });
  }

  // The stadium the TV draws itself, from the phone's drawing commands.
  const sceneModule = window.RallycadeReceiverScene;
  let sceneSender = null;
  const scene = sceneModule && sceneModule.createScene({
    root: document.getElementById("scene"),
    canvas: document.getElementById("scene-canvas"),
    stage: document.getElementById("scene-stage"),
    backdrop: document.getElementById("scene-backdrop"),
    hud: document.getElementById("scene-hud"),
    send: (message) => sendScene(message),
    // ?canvas=1920 draws previews and films that wide (a Mac counts as a dongle).
    canvasWidth: Number(query.get("canvas")) || undefined
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
      let sceneGone = 0;
      sendScene = (message) => {
        if (sceneSender) context.sendCustomMessage(sceneModule.NAMESPACE, sceneSender, message);
      };
      context.addCustomMessageListener(sceneModule.NAMESPACE, (event) => {
        // A snapshot goes back to whoever asked (a test bench beside the
        // phone), which never becomes the stadium's sender.
        if (event.data && event.data.t === "card") {
          if (cardView) cardView.receive(event.data);
          return;
        }
        if (event.data && event.data.t === "snap") {
          scene.snapshot(event.data.q, (message) => context.sendCustomMessage(sceneModule.NAMESPACE, event.senderId, message));
          return;
        }
        sceneSender = event.senderId;
        if (event.data && event.data.t === "hello") {
          stadiumPhone = true;
          window.clearTimeout(sceneGone);
        }
        try { scene.handle(event.data); } catch (error) { scene.report("handle", error); }
        if (event.data && event.data.t === "scene") {
          if (event.data.on === 1) { sceneLost = false; if (lastState && PLAY_SCREENS.has(lastState.screen)) stadiumThisPlay = true; }
          updateHold();
        }
        if (event.data && event.data.t === "hello") { sceneLost = false; updateHold(); }
      });
      window.addEventListener("error", (event) => scene.report("script", event.message + " @" + event.lineno));
      cardFailure = (where, error) => scene.report(where, error);
      // A phone that leaves takes its stadium with it, but not at once: a
      // dropped Wi-Fi connection comes back within seconds, and meanwhile
      // the stadium's last frame stays up rather than the HTML scoreboard
      // (build 158: "still some older chromecast screen showed up").
      context.addEventListener(window.cast.framework.system.EventType.SENDER_DISCONNECTED, (event) => {
        if (event.senderId !== sceneSender) return;
        sceneSender = null;
        window.clearTimeout(sceneGone);
        sceneGone = window.setTimeout(() => { if (!sceneSender) { scene.setOn(false); stadiumPhone = false; sceneLost = true; updateHold(); } }, SCENE_GRACE_MS);
      });
    }
    // Receiver 59: the stadium's bitmaps and canvases are let go as the
    // receiver stops, so the TV can start it again at once.
    if (scene) {
      context.addEventListener(window.cast.framework.system.EventType.SHUTDOWN, () => scene.release());
      window.addEventListener("pagehide", () => scene.release());
      window.addEventListener("unload", () => scene.release());
    }
    const options = new window.cast.framework.CastReceiverOptions();
    options.customNamespaces = {};
    options.customNamespaces[NAMESPACE] = window.cast.framework.system.MessageType.JSON;
    if (videoModule) options.customNamespaces[videoModule.NAMESPACE] = window.cast.framework.system.MessageType.JSON;
    if (scene) options.customNamespaces[sceneModule.NAMESPACE] = window.cast.framework.system.MessageType.JSON;
    const musicModule = window.RallycadeMusic;
    if (musicModule) {
      const audio = new Audio("music/music-theme.m4a");
      const music = musicModule.createPlayer({ audio,
        send: (sender, message) => context.sendCustomMessage(musicModule.NAMESPACE, sender, message) });
      options.customNamespaces[musicModule.NAMESPACE] = window.cast.framework.system.MessageType.JSON;
      context.addCustomMessageListener(musicModule.NAMESPACE, event => music.handle(event.senderId, event.data));
      context.addEventListener(window.cast.framework.system.EventType.SENDER_DISCONNECTED, event => music.disconnected(event.senderId));
      context.addEventListener(window.cast.framework.system.EventType.SHUTDOWN, () => music.stop());
      window.addEventListener("pagehide", () => music.stop());
      window.addEventListener("unload", () => music.stop());
    }
    options.disableIdleTimeout = true;
    options.skipPlayersLoad = true;
    options.statusText = "RallyCade is ready";
    context.setApplicationState("RallyCade is ready");
    context.start(options);
  }
})();
