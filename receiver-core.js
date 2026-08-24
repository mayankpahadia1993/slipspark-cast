(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.SlipSparkReceiverCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const validScreens = new Set([
    "ready", "positioning", "fight", "cricket", "versusSetup", "versus",
    "result", "versusResult", "cricketDuelHandoff", "cricketDuelResult"
  ]);
  const fightPhases = new Set([
    "ready", "countdown", "telegraph", "defend", "counter", "opening",
    "feedback", "trackingPaused", "roundBreak", "finished"
  ]);
  const cricketPhases = new Set([
    "ready", "countdown", "runUp", "delivery", "feedback", "trackingPaused", "finished"
  ]);
  const versusPhases = new Set([
    "ready", "countdown", "telegraph", "defend", "counter", "opening",
    "feedback", "knockout", "trackingPaused", "finished"
  ]);
  const validActions = new Set([
    "neutral", "slipLeft", "slipRight", "duck", "highBlock", "bodyBlock",
    "counterLeft", "counterRight"
  ]);
  const validStyles = new Set(["aggressor", "bodyHunter", "trickster"]);
  const validAttacks = new Set([
    "straight", "leftHook", "rightHook", "body", "doubleStraight", "highLow",
    "lowHigh", "delayed", "feint"
  ]);
  const jointNames = [
    "nose", "neck", "leftShoulder", "rightShoulder", "leftElbow", "rightElbow",
    "leftWrist", "rightWrist", "root", "leftHip", "rightHip"
  ];

  function number(value, fallback) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, number(value, minimum)));
  }

  function boundedString(value, fallback, maximumLength) {
    return String(value == null ? fallback : value).slice(0, maximumLength);
  }

  function optionalString(value, maximumLength) {
    return value == null ? null : boundedString(value, "", maximumLength);
  }

  function allowedString(value, allowed, fallback) {
    const candidate = boundedString(value, fallback, 40);
    return allowed.has(candidate) ? candidate : fallback;
  }

  function normalizeJoints(value) {
    const input = value && typeof value === "object" ? value : {};
    return jointNames.reduce((result, name) => {
      const joint = input[name];
      if (!joint || typeof joint !== "object") return result;
      result[name] = {
        x: clamp(joint.x, 0, 1),
        y: clamp(joint.y, 0, 1),
        confidence: clamp(joint.confidence, 0, 1)
      };
      return result;
    }, {});
  }

  function normalizePlayer(value) {
    const player = value && typeof value === "object" ? value : {};
    return {
      score: Math.floor(clamp(player.score, 0, 999999999)),
      health: clamp(player.health, 0, 100),
      combo: clamp(player.combo, 1, 99),
      action: allowedString(player.action, validActions, "neutral"),
      feedback: optionalString(player.feedback, 48)
    };
  }

  function normalizeStats(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 4).map((stat) => ({
      label: boundedString(stat && stat.label, "STAT", 32),
      value: boundedString(stat && stat.value, "0", 32)
    }));
  }

  function formatTime(seconds) {
    const safe = Math.max(0, Math.floor(number(seconds, 0)));
    return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
  }

  function normalizeState(input) {
    const value = input && typeof input === "object" ? input : {};
    const screen = validScreens.has(value.screen) ? value.screen : "ready";
    const normalized = {
      schemaVersion: number(value.schemaVersion, 2),
      sequence: Math.max(0, Math.floor(number(value.sequence, 0))),
      screen,
      positioning: null,
      fight: null,
      cricket: null,
      versusSetup: null,
      versus: null,
      result: null,
      versusResult: null,
      cricketDuelHandoff: null,
      cricketDuelResult: null
    };

    if (screen === "positioning") {
      const positioning = value.positioning && typeof value.positioning === "object" ? value.positioning : {};
      normalized.positioning = {
        isReady: positioning.isReady === true,
        instruction: boundedString(positioning.instruction, "Fit your upper body in the frame", 160),
        joints: normalizeJoints(positioning.joints)
      };
    }

    if (screen === "fight") {
      const fight = value.fight && typeof value.fight === "object" ? value.fight : {};
      normalized.fight = {
        phase: allowedString(fight.phase, fightPhases, "ready"),
        phaseValue: optionalString(fight.phaseValue, 80),
        phaseDetail: optionalString(fight.phaseDetail, 160),
        score: Math.floor(clamp(fight.score, 0, 999999999)),
        combo: clamp(fight.combo, 1, 99),
        timeRemaining: Math.floor(clamp(fight.timeRemaining, 0, 3600)),
        playerHealth: clamp(fight.playerHealth, 0, 100),
        opponentHealth: clamp(fight.opponentHealth, 0, 100),
        playerAction: allowedString(fight.playerAction, validActions, "neutral"),
        opponentStyle: allowedString(fight.opponentStyle, validStyles, "aggressor"),
        opponentName: boundedString(fight.opponentName, "Opponent", 48),
        currentAttack: allowedString(fight.currentAttack, validAttacks, "straight"),
        calledDefense: boundedString(fight.calledDefense, "Slip left", 80),
        currentRound: Math.floor(clamp(fight.currentRound, 1, 5)),
        attackCommitted: fight.attackCommitted === true,
        opponentHit: fight.opponentHit === true,
        comboStep: fight.comboStep == null ? null : Math.floor(clamp(fight.comboStep, 1, 99)),
        comboTotal: fight.comboTotal == null ? null : Math.floor(clamp(fight.comboTotal, 1, 99)),
        telegraphDuration: clamp(fight.telegraphDuration, 0.1, 10)
      };
    }

    if (screen === "cricket") {
      const cricket = value.cricket && typeof value.cricket === "object" ? value.cricket : {};
      normalized.cricket = {
        phase: allowedString(cricket.phase, cricketPhases, "ready"),
        phaseValue: optionalString(cricket.phaseValue, 80),
        phaseDetail: optionalString(cricket.phaseDetail, 160),
        runs: Math.floor(clamp(cricket.runs, 0, 99999)),
        wicketsLost: Math.floor(clamp(cricket.wicketsLost, 0, 20)),
        wicketLimit: Math.floor(clamp(cricket.wicketLimit, 1, 20)),
        ballsFaced: Math.floor(clamp(cricket.ballsFaced, 0, 999)),
        totalBalls: Math.floor(clamp(cricket.totalBalls, 1, 999)),
        runsNeeded: cricket.runsNeeded == null ? null : Math.floor(clamp(cricket.runsNeeded, 0, 99999)),
        ballsRemaining: Math.floor(clamp(cricket.ballsRemaining, 0, 999)),
        playerAction: allowedString(cricket.playerAction, validActions, "neutral")
      };
    }

    if (screen === "versusSetup") {
      const setup = value.versusSetup && typeof value.versusSetup === "object" ? value.versusSetup : {};
      normalized.versusSetup = {
        isLeftReady: setup.isLeftReady === true,
        isRightReady: setup.isRightReady === true,
        isReady: setup.isReady === true,
        instruction: boundedString(setup.instruction, "Stand side by side", 160)
      };
    }

    if (screen === "versus") {
      const versus = value.versus && typeof value.versus === "object" ? value.versus : {};
      normalized.versus = {
        phase: allowedString(versus.phase, versusPhases, "ready"),
        phaseValue: optionalString(versus.phaseValue, 80),
        phaseDetail: optionalString(versus.phaseDetail, 160),
        timeRemaining: Math.floor(clamp(versus.timeRemaining, 0, 3600)),
        currentAttack: allowedString(versus.currentAttack, validAttacks, "straight"),
        calledDefense: boundedString(versus.calledDefense, "Slip left", 80),
        comboStep: versus.comboStep == null ? null : Math.floor(clamp(versus.comboStep, 1, 99)),
        comboTotal: versus.comboTotal == null ? null : Math.floor(clamp(versus.comboTotal, 1, 99)),
        telegraphDuration: clamp(versus.telegraphDuration, 0.1, 10),
        left: normalizePlayer(versus.left),
        right: normalizePlayer(versus.right)
      };
    }

    if (screen === "result") {
      const result = value.result && typeof value.result === "object" ? value.result : {};
      normalized.result = {
        mode: boundedString(result.mode, "FIGHT", 48),
        headline: boundedString(result.headline, "Fight complete", 80),
        score: Math.floor(clamp(result.score, 0, 999999999)),
        caption: boundedString(result.caption, "FINAL SCORE", 48),
        isPersonalBest: result.isPersonalBest === true,
        stats: normalizeStats(result.stats)
      };
    }

    if (screen === "versusResult") {
      const result = value.versusResult && typeof value.versusResult === "object" ? value.versusResult : {};
      const winner = result.winner === "left" || result.winner === "right" ? result.winner : null;
      normalized.versusResult = {
        headline: boundedString(result.headline, "DRAW", 80),
        detail: boundedString(result.detail, "RUN IT BACK", 120),
        winner,
        leftScore: Math.floor(clamp(result.leftScore, 0, 999999999)),
        rightScore: Math.floor(clamp(result.rightScore, 0, 999999999)),
        leftDefense: Math.floor(clamp(result.leftDefense, 0, 100)),
        rightDefense: Math.floor(clamp(result.rightDefense, 0, 100)),
        leftCounters: Math.floor(clamp(result.leftCounters, 0, 9999)),
        rightCounters: Math.floor(clamp(result.rightCounters, 0, 9999))
      };
    }

    if (screen === "cricketDuelHandoff") {
      const handoff = value.cricketDuelHandoff && typeof value.cricketDuelHandoff === "object" ? value.cricketDuelHandoff : {};
      normalized.cricketDuelHandoff = {
        target: Math.floor(clamp(handoff.target, 1, 99999)),
        balls: Math.floor(clamp(handoff.balls, 1, 999)),
        wickets: Math.floor(clamp(handoff.wickets, 1, 20))
      };
    }

    if (screen === "cricketDuelResult") {
      const result = value.cricketDuelResult && typeof value.cricketDuelResult === "object" ? value.cricketDuelResult : {};
      const winner = ["first", "second", "tie"].includes(result.winner) ? result.winner : "tie";
      normalized.cricketDuelResult = {
        headline: boundedString(result.headline, "TIED", 80),
        margin: boundedString(result.margin, "SCORES LEVEL", 160),
        winner,
        firstRuns: Math.floor(clamp(result.firstRuns, 0, 99999)),
        firstWickets: Math.floor(clamp(result.firstWickets, 0, 20)),
        secondRuns: Math.floor(clamp(result.secondRuns, 0, 99999)),
        secondWickets: Math.floor(clamp(result.secondWickets, 0, 20))
      };
    }

    return normalized;
  }

  function parseMessage(data) {
    if (typeof data === "string") {
      try { return normalizeState(JSON.parse(data)); } catch (_) { return normalizeState(null); }
    }
    return normalizeState(data);
  }

  function fightSample(kind) {
    const phaseMap = {
      fight: ["telegraph", "leftHook", "DUCK"],
      tracking: ["trackingPaused", "TRACKING PAUSED", "Keep your head and shoulders in the frame"],
      opening: ["opening", "LEFT HOOK!", "LEFT HAND"],
      feedback: ["feedback", "perfect", "RIGHT ON THE CUE"]
    };
    const phase = phaseMap[kind] || phaseMap.fight;
    return {
      phase: phase[0], phaseValue: phase[1], phaseDetail: phase[2],
      score: 2840, combo: 1.75, timeRemaining: 42,
      playerHealth: 82, opponentHealth: 54, playerAction: "slipLeft",
      opponentStyle: "aggressor", opponentName: "Aggressor",
      currentAttack: "leftHook", calledDefense: "Duck", currentRound: 1,
      attackCommitted: kind === "fight", opponentHit: kind === "feedback",
      comboStep: kind === "opening" ? 2 : null, comboTotal: kind === "opening" ? 3 : null,
      telegraphDuration: 1.3
    };
  }

  function sampleState(kind) {
    const base = { schemaVersion: 2, sequence: 10 };
    if (kind === "positioning") return normalizeState({ ...base, screen: "positioning", positioning: { isReady: false, instruction: "Fit your upper body in the frame", joints: {} } });
    if (kind === "cricket") return normalizeState({ ...base, screen: "cricket", cricket: { phase: "delivery", phaseValue: "FULL!", phaseDetail: "DRIVE", runs: 18, wicketsLost: 1, wicketLimit: 3, ballsFaced: 7, totalBalls: 12, ballsRemaining: 5, playerAction: "counterRight" } });
    if (kind === "versusSetup") return normalizeState({ ...base, screen: "versusSetup", versusSetup: { isLeftReady: true, isRightReady: false, instruction: "RED CORNER SET — ONE MORE" } });
    if (kind === "versus") return normalizeState({ ...base, screen: "versus", versus: { phase: "defend", phaseValue: "leftHook", phaseDetail: "DUCK", timeRemaining: 41, currentAttack: "leftHook", calledDefense: "Duck", telegraphDuration: 1.3, left: { score: 1700, health: 82, combo: 1.5, action: "duck" }, right: { score: 1450, health: 70, combo: 1.25, action: "duck" } } });
    if (kind === "result") return normalizeState({ ...base, screen: "result", result: { mode: "QUICK FIGHT", headline: "You win", score: 4820, caption: "NEW PERSONAL BEST", isPersonalBest: true, stats: [{ label: "DEFENSE", value: "86%" }, { label: "REACTION", value: "312 MS" }, { label: "BEST COMBO", value: "×2.50" }] } });
    if (kind === "versusResult") return normalizeState({ ...base, screen: "versusResult", versusResult: { headline: "RED CORNER WINS", detail: "ON POINTS", winner: "left", leftScore: 4200, rightScore: 3700, leftDefense: 88, rightDefense: 76, leftCounters: 5, rightCounters: 3 } });
    if (kind === "cricketDuelHandoff") return normalizeState({ ...base, screen: "cricketDuelHandoff", cricketDuelHandoff: { target: 32, balls: 12, wickets: 3 } });
    if (kind === "cricketDuelResult") return normalizeState({ ...base, screen: "cricketDuelResult", cricketDuelResult: { headline: "PLAYER 2 WINS", margin: "BY 2 WICKETS · 1 BALL TO SPARE", winner: "second", firstRuns: 31, firstWickets: 3, secondRuns: 32, secondWickets: 1 } });
    if (kind === "ready" || !kind) return normalizeState({ ...base, sequence: 1, screen: "ready" });
    return normalizeState({ ...base, screen: "fight", fight: fightSample(kind) });
  }

  return { clamp, formatTime, normalizeJoints, normalizeState, parseMessage, sampleState };
});
