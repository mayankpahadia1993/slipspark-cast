(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.SlipSparkReceiverCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const validScreens = new Set(["ready", "positioning", "fight"]);
  const validPhases = new Set([
    "ready", "countdown", "telegraph", "defend", "counter", "opening",
    "feedback", "trackingPaused", "roundBreak", "finished"
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

  function formatTime(seconds) {
    const safe = Math.max(0, Math.floor(number(seconds, 0)));
    return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
  }

  function normalizeState(input) {
    const value = input && typeof input === "object" ? input : {};
    const screen = validScreens.has(value.screen) ? value.screen : "ready";
    const normalized = {
      schemaVersion: number(value.schemaVersion, 1),
      sequence: Math.max(0, Math.floor(number(value.sequence, 0))),
      screen,
      positioning: null,
      fight: null
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
        phase: validPhases.has(fight.phase) ? fight.phase : "ready",
        phaseValue: fight.phaseValue == null ? null : boundedString(fight.phaseValue, "", 80),
        phaseDetail: fight.phaseDetail == null ? null : boundedString(fight.phaseDetail, "", 160),
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
        currentRound: Math.floor(clamp(fight.currentRound, 1, 3)),
        attackCommitted: fight.attackCommitted === true,
        opponentHit: fight.opponentHit === true,
        comboStep: fight.comboStep == null ? null : Math.floor(clamp(fight.comboStep, 1, 99)),
        comboTotal: fight.comboTotal == null ? null : Math.floor(clamp(fight.comboTotal, 1, 99)),
        telegraphDuration: clamp(fight.telegraphDuration, 0.1, 10)
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

  function sampleState(kind) {
    if (kind === "positioning") {
      return normalizeState({
        schemaVersion: 1,
        sequence: 2,
        screen: "positioning",
        positioning: { isReady: false, instruction: "Fit your upper body in the frame", joints: {} }
      });
    }

    if (kind === "ready" || !kind) return normalizeState({ screen: "ready", sequence: 1 });

    const phaseMap = {
      fight: ["telegraph", "leftHook", "DUCK"],
      tracking: ["trackingPaused", "TRACKING PAUSED", "Keep your head and shoulders in the frame"],
      opening: ["opening", "LEFT HOOK!", "LEFT HAND"],
      feedback: ["feedback", "perfect", "RIGHT ON THE CUE"]
    };
    const phase = phaseMap[kind] || phaseMap.fight;
    return normalizeState({
      schemaVersion: 1,
      sequence: 10,
      screen: "fight",
      fight: {
        phase: phase[0], phaseValue: phase[1], phaseDetail: phase[2],
        score: 2840, combo: 1.75, timeRemaining: 42,
        playerHealth: 82, opponentHealth: 54, playerAction: "slipLeft",
        opponentStyle: "aggressor", opponentName: "Aggressor",
        currentAttack: "leftHook", calledDefense: "Duck", currentRound: 1,
        attackCommitted: kind === "fight", opponentHit: kind === "feedback",
        comboStep: kind === "opening" ? 2 : null, comboTotal: kind === "opening" ? 3 : null,
        telegraphDuration: 1.3
      }
    });
  }

  return { clamp, formatTime, normalizeJoints, normalizeState, parseMessage, sampleState };
});
