import { useRef, useEffect, useState, useCallback } from "react";

// ─── Constants ───────────────────────────────────────────────────────────────
const ARENA_W = 14;
const ARENA_H = 9;
const BALL_R = 0.28;
const POLE_R = 0.55;
const GOAL_H = 3.8;
const MAG_STRENGTH = 52;
const MAG_MIN_DIST = 0.9;
const DAMPING = 0.999;
const ANG_DAMPING = 0.97;
const RESTITUTION = 0.82;
const WALL_RESTITUTION = 0.75;
const MAX_SPEED = 26;
const BOT_SPEED = 5.5;
const BOT_FORCE_RANGE = 3.4;
const SCORE_LIMIT = 5;
const VECTOR_GRID_COLS = 28;
const VECTOR_GRID_ROWS = 18;
const TRAIL_LENGTH = 32;
const GHOST_COUNT = 3;
const GHOST_STRENGTH = 6;
const GHOST_MIN_DIST = 1.4;
const GHOST_DRIFT_SPEED = 0.9;
const GHOST_CYCLE_MIN = 2.2;
const GHOST_CYCLE_MAX = 5.5;
const FPS_TARGET = 60;

// ─── Colors ───────────────────────────────────────────────────────────────────
const C_ATTRACT = "#00FFFF";
const C_REPEL = "#FF00FF";
const C_BALL = "#E8E8FF";
const C_ARENA_BG = "#070B12";
const C_WALL = "#1A2535";
const C_GRID = "#0D1520";
const C_P1 = "#00FFFF";
const C_BOT = "#FF00FF";
const C_HUD = "rgba(0,255,255,0.07)";

// ─── Math Helpers ─────────────────────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

function magnetForce(pole, ball, mode) {
  if (mode === "NONE") return { fx: 0, fz: 0 };
  const dx = ball.x - pole.x;
  const dz = ball.z - pole.z;
  const dist = Math.max(Math.sqrt(dx * dx + dz * dz), MAG_MIN_DIST);
  const mag = MAG_STRENGTH / (dist * dist);
  const nx = dx / dist;
  const nz = dz / dist;
  const sign = mode === "ATTRACT" ? -1 : 1;
  return { fx: sign * nx * mag, fz: sign * nz * mag };
}


function ghostForce(ghost, ball) {
  if (ghost.mode === "NONE") return { fx: 0, fz: 0 };
  const dx = ball.x - ghost.x;
  const dz = ball.z - ghost.z;
  const dist = Math.max(Math.sqrt(dx * dx + dz * dz), GHOST_MIN_DIST);
  const mag = GHOST_STRENGTH / (dist * dist);
  const nx = dx / dist;
  const nz = dz / dist;
  const sign = ghost.mode === "ATTRACT" ? -1 : 1;
  return { fx: sign * nx * mag, fz: sign * nz * mag };
}

function makeGhosts() {
  const modes = ["ATTRACT", "REPEL", "NONE"];
  return Array.from({ length: GHOST_COUNT }, (_, i) => ({
    x: (Math.random() - 0.5) * (ARENA_W - 3),
    z: (Math.random() - 0.5) * (ARENA_H - 2),
    vx: (Math.random() - 0.5) * GHOST_DRIFT_SPEED * 2,
    vz: (Math.random() - 0.5) * GHOST_DRIFT_SPEED * 2,
    mode: modes[i % 2],  // start: one attract, one repel, one none
    timer: GHOST_CYCLE_MIN + Math.random() * (GHOST_CYCLE_MAX - GHOST_CYCLE_MIN),
    alpha: 0.6 + Math.random() * 0.4,
  }));
}
// ─── Initial State ────────────────────────────────────────────────────────────
function initState() {
  return {
    ball: { x: 0, z: 0, vx: (Math.random() - 0.5) * 4, vz: (Math.random() - 0.5) * 4 },
    p1: { x: -(ARENA_W / 2 - 1.5), z: 0, mode: "NONE" },
    bot: { x: ARENA_W / 2 - 1.5, z: 0, mode: "NONE" },
    score: { p1: 0, bot: 0 },
    phase: "PLAYING", // MENU | PLAYING | GOAL | GAMEOVER
    winner: null,
    goalFlash: 0,
    ghosts: makeGhosts(),
    stallTimer: 0,
  };
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function MagPhysSimulator() {
  const canvasRef = useRef(null);
  const stateRef = useRef(initState());
  const keysRef = useRef({});
  const lastTimeRef = useRef(null);
  const animRef = useRef(null);
  const trailRef = useRef([]);
  const [uiState, setUiState] = useState({ score: { p1: 0, bot: 0 }, phase: "MENU", p1Mode: "NONE", botMode: "NONE", winner: null });
  const sliderRef = useRef(0);
  const slider2Ref = useRef(0);
  const [sliderVal, setSliderVal] = useState(0);
  const [slider2Val, setSlider2Val] = useState(0);
  const [gameMode, setGameMode] = useState("BOT"); // "BOT" | "2P"
  const gameModeRef = useRef("BOT");

  // ─── Canvas Draw ─────────────────────────────────────────────────────────
  const draw = useCallback((ctx, W, H, state) => {
    const scaleX = W / ARENA_W;
    const scaleZ = H / ARENA_H;
    const tx = (x) => W / 2 + x * scaleX;
    const tz = (z) => H / 2 + z * scaleZ;

    // BG
    ctx.fillStyle = C_ARENA_BG;
    ctx.fillRect(0, 0, W, H);

    // Grid lines
    ctx.strokeStyle = C_GRID;
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= VECTOR_GRID_COLS; i++) {
      const gx = (i / VECTOR_GRID_COLS) * W;
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
    }
    for (let j = 0; j <= VECTOR_GRID_ROWS; j++) {
      const gz = (j / VECTOR_GRID_ROWS) * H;
      ctx.beginPath(); ctx.moveTo(0, gz); ctx.lineTo(W, gz); ctx.stroke();
    }

    // Vector field
    const cellW = W / VECTOR_GRID_COLS;
    const cellH = H / VECTOR_GRID_ROWS;
    for (let i = 0; i < VECTOR_GRID_COLS; i++) {
      for (let j = 0; j < VECTOR_GRID_ROWS; j++) {
        const gx = (i + 0.5) * cellW;
        const gz = (j + 0.5) * cellH;
        const wx = (gx / W - 0.5) * ARENA_W;
        const wz = (gz / H - 0.5) * ARENA_H;
        const fp1 = magnetForce(state.p1, { x: wx, z: wz }, state.p1.mode);
        const fbot = magnetForce(state.bot, { x: wx, z: wz }, state.bot.mode);
        const fghost = (state.ghosts || []).reduce((acc, g) => {
          const f = ghostForce(g, { x: wx, z: wz });
          return { fx: acc.fx + f.fx, fz: acc.fz + f.fz };
        }, { fx: 0, fz: 0 });
        const fx = fp1.fx + fbot.fx + fghost.fx;
        const fz = fp1.fz + fbot.fz + fghost.fz;
        const mag = Math.sqrt(fx * fx + fz * fz);
        if (mag < 0.05) continue;
        const angle = Math.atan2(fz, fx);
        const len = Math.min(mag * 0.18, cellW * 0.44) * scaleX;
        const isAttract = (state.p1.mode === "ATTRACT" || state.bot.mode === "ATTRACT");
        const isRepel = (state.p1.mode === "REPEL" || state.bot.mode === "REPEL");
        let color;
        if (isAttract && isRepel) color = "#8800FF";
        else if (isAttract) color = `rgba(0,255,255,${Math.min(0.7, mag * 0.07)})`;
        else if (isRepel) color = `rgba(255,0,255,${Math.min(0.7, mag * 0.07)})`;
        else color = `rgba(100,150,255,${Math.min(0.4, mag * 0.04)})`;
        ctx.save();
        ctx.translate(gx, gz);
        ctx.rotate(angle);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(-len / 2, 0);
        ctx.lineTo(len / 2, 0);
        // arrowhead
        ctx.moveTo(len / 2 - 3, -2);
        ctx.lineTo(len / 2, 0);
        ctx.lineTo(len / 2 - 3, 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Center line
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
    ctx.setLineDash([]);

    // Goal gaps
    const gapTop = H / 2 - (GOAL_H / 2) * scaleZ;
    const gapBot = H / 2 + (GOAL_H / 2) * scaleZ;

    // Walls
    ctx.fillStyle = C_WALL;
    // top wall
    ctx.fillRect(0, 0, W, 4);
    // bottom wall
    ctx.fillRect(0, H - 4, W, 4);
    // left wall - two segments (top & bottom of goal)
    ctx.fillRect(0, 0, 4, gapTop);
    ctx.fillRect(0, gapBot, 4, H - gapBot);
    // right wall
    ctx.fillRect(W - 4, 0, 4, gapTop);
    ctx.fillRect(W - 4, gapBot, 4, H - gapBot);

    // Wall glow
    ctx.shadowBlur = 0;

    // Goal zones glow
    // Left goal
    const glL = ctx.createLinearGradient(0, 0, 40, 0);
    glL.addColorStop(0, "rgba(0,255,255,0.18)");
    glL.addColorStop(1, "rgba(0,255,255,0)");
    ctx.fillStyle = glL;
    ctx.fillRect(0, gapTop, 4, gapBot - gapTop);

    // Right goal
    const glR = ctx.createLinearGradient(W, 0, W - 40, 0);
    glR.addColorStop(0, "rgba(255,0,255,0.18)");
    glR.addColorStop(1, "rgba(255,0,255,0)");
    ctx.fillStyle = glR;
    ctx.fillRect(W - 4, gapTop, 4, gapBot - gapTop);

    // Wall edge glow lines
    ctx.strokeStyle = "rgba(0,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(4, 0); ctx.lineTo(4, gapTop); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(4, gapBot); ctx.lineTo(4, H); ctx.stroke();
    ctx.strokeStyle = "rgba(255,0,255,0.25)";
    ctx.beginPath(); ctx.moveTo(W - 4, 0); ctx.lineTo(W - 4, gapTop); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(W - 4, gapBot); ctx.lineTo(W - 4, H); ctx.stroke();

    // Ball trail
    const trail = trailRef.current;
    for (let i = 0; i < trail.length; i++) {
      const t = trail[i];
      const alpha = (i / trail.length) * 0.5;
      const r = BALL_R * scaleX * (0.3 + 0.7 * (i / trail.length));
      const speed = Math.sqrt(t.vx * t.vx + t.vz * t.vz);
      const hue = speed > 8 ? 300 : 190;
      ctx.beginPath();
      ctx.arc(tx(t.x), tz(t.z), r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${hue},100%,70%,${alpha})`;
      ctx.fill();
    }

    // Ball
    const bx = tx(state.ball.x);
    const bz = tz(state.ball.z);
    const br = BALL_R * scaleX;
    const speed = Math.sqrt(state.ball.vx ** 2 + state.ball.vz ** 2);
    // glow
    const glowR = br * (2.5 + speed * 0.12);
    const grad = ctx.createRadialGradient(bx, bz, 0, bx, bz, glowR);
    grad.addColorStop(0, `rgba(220,230,255,0.9)`);
    grad.addColorStop(0.3, `rgba(140,180,255,0.4)`);
    grad.addColorStop(1, `rgba(0,0,0,0)`);
    ctx.beginPath();
    ctx.arc(bx, bz, glowR, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    // core
    ctx.beginPath();
    ctx.arc(bx, bz, br, 0, Math.PI * 2);
    ctx.fillStyle = C_BALL;
    ctx.fill();
    // specular
    ctx.beginPath();
    ctx.arc(bx - br * 0.3, bz - br * 0.3, br * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fill();


    // Ghost poles — faint drifting anomaly rings
    if (state.ghosts) {
      const now = Date.now() / 1000;
      for (const g of state.ghosts) {
        if (g.mode === "NONE") continue;
        const gx = tx(g.x);
        const gz = tz(g.z);
        const pulse = 0.5 + 0.5 * Math.sin(now * 2.8 + g.x * 3);
        const col = g.mode === "ATTRACT" ? `rgba(0,255,255,` : `rgba(255,0,255,`;
        const outerR = POLE_R * scaleX * (2.2 + pulse * 0.8);
        // outer halo
        const halo = ctx.createRadialGradient(gx, gz, 0, gx, gz, outerR);
        halo.addColorStop(0, col + `${0.06 + pulse * 0.06})`);
        halo.addColorStop(1, col + `0)`);
        ctx.beginPath();
        ctx.arc(gx, gz, outerR, 0, Math.PI * 2);
        ctx.fillStyle = halo;
        ctx.fill();
        // dashed ring
        ctx.save();
        ctx.setLineDash([4, 6]);
        ctx.strokeStyle = col + `${0.18 + pulse * 0.22})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(gx, gz, POLE_R * scaleX * (1.0 + pulse * 0.3), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        // center dot
        ctx.beginPath();
        ctx.arc(gx, gz, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = col + `${0.5 + pulse * 0.5})`;
        ctx.fill();
      }
    }

    // Poles
    drawPole(ctx, tx(state.p1.x), tz(state.p1.z), POLE_R * scaleX, state.p1.mode, C_P1, "P1");
    drawPole(ctx, tx(state.bot.x), tz(state.bot.z), POLE_R * scaleX, state.bot.mode, C_BOT, "BOT");

    // Goal flash overlay
    if (state.goalFlash > 0) {
      ctx.fillStyle = `rgba(0,255,255,${state.goalFlash * 0.18})`;
      ctx.fillRect(0, 0, W, H);
    }
  }, []);

  function drawPole(ctx, px, pz, pr, mode, baseColor, label) {
    const isActive = mode !== "NONE";
    const color = mode === "ATTRACT" ? C_ATTRACT : mode === "REPEL" ? C_REPEL : baseColor;

    // outer glow
    if (isActive) {
      const g = ctx.createRadialGradient(px, pz, 0, px, pz, pr * 3.5);
      g.addColorStop(0, color + "55");
      g.addColorStop(1, color + "00");
      ctx.beginPath();
      ctx.arc(px, pz, pr * 3.5, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();
    }

    // ring
    ctx.beginPath();
    ctx.arc(px, pz, pr, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = isActive ? 2.5 : 1.5;
    ctx.stroke();

    // inner fill
    const fill = ctx.createRadialGradient(px - pr * 0.3, pz - pr * 0.3, 0, px, pz, pr);
    fill.addColorStop(0, isActive ? color + "AA" : "#1A2535");
    fill.addColorStop(1, isActive ? color + "22" : "#070B12");
    ctx.beginPath();
    ctx.arc(px, pz, pr, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();

    // + or - symbol
    ctx.fillStyle = color;
    ctx.font = `bold ${pr * 0.9}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(mode === "ATTRACT" ? "−" : "+", px, pz + 1);

    // label
    ctx.font = `${pr * 0.6}px monospace`;
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillText(label, px, pz + pr * 1.6);
  }

  // ─── Physics Step ─────────────────────────────────────────────────────────
  const step = useCallback((dt) => {
    const s = stateRef.current;
    if (s.phase !== "PLAYING") return;

    // ── Bot AI ────────────────────────────────────────────────────────────
    const ball = s.ball;
    const bot = s.bot;

    // Stall detection — if ball is barely moving, nudge it back into play
    const ballSpeed = Math.sqrt(ball.vx ** 2 + ball.vz ** 2);
    s.stallTimer = (s.stallTimer || 0);
    if (ballSpeed < 0.8) {
      s.stallTimer += dt;
    } else {
      s.stallTimer = 0;
    }
    if (s.stallTimer > 1.8) {
      // Kick ball back toward center with a small impulse
      const kickDir = ball.x > 0 ? -1 : 1;
      ball.vx += kickDir * 6;
      ball.vz += (Math.random() - 0.5) * 4;
      s.stallTimer = 0;
    }

    if (gameModeRef.current === "BOT") {
    // Bot corner-lock prevention — if ball is stuck near bot, release and kick
    const realDistToBall = Math.sqrt((ball.x - bot.x) ** 2 + (ball.z - bot.z) ** 2);
    s.botStuckTimer = s.botStuckTimer || 0;
    if (realDistToBall < 1.8 && Math.sqrt(ball.vx**2 + ball.vz**2) < 1.5) {
      s.botStuckTimer += dt;
    } else {
      s.botStuckTimer = 0;
    }
    if (s.botStuckTimer > 0.5) {
      ball.vx = -10 - Math.random() * 4;
      ball.vz = (Math.random() - 0.5) * 7;
      bot.mode = "NONE";
      s.botStuckTimer = 0;
    }

    // Adaptive difficulty — bot delay scales with score gap
    // Player dominating → bot slows down. Bot dominating → bot sharpens.
    const scoreDiff = s.score.p1 - s.score.bot; // positive = player winning
    const BASE_DELAY = 0.15;
    const adaptiveDelay = clamp(BASE_DELAY - scoreDiff * 0.045, 0.04, 0.38);
    s.adaptiveDelay = adaptiveDelay;
    const BOT_DELAY = adaptiveDelay;
    s.botPerception = s.botPerception || { x: ball.x, z: ball.z, vx: ball.vx, vz: ball.vz, t: 0 };
    s.botPerception.t += dt;
    if (s.botPerception.t >= BOT_DELAY) {
      s.botPerception.x = ball.x;
      s.botPerception.z = ball.z;
      s.botPerception.vx = ball.vx;
      s.botPerception.vz = ball.vz;
      s.botPerception.t = 0;
    }
    const perceived = s.botPerception;

    // Bot tracks the delayed ball position, not the real one
    const prediction = perceived.vz * 0.18;
    const targetZ = clamp(perceived.z + prediction, -ARENA_H / 2 + 0.8, ARENA_H / 2 - 0.8);
    const dz = targetZ - bot.z;
    bot.z += clamp(dz, -BOT_SPEED * dt, BOT_SPEED * dt);
    bot.z = clamp(bot.z, -ARENA_H / 2 + 0.8, ARENA_H / 2 - 0.8);

    // Bot force decision — based on delayed perception
    const distToBall = Math.sqrt((perceived.x - bot.x) ** 2 + (perceived.z - bot.z) ** 2);
    const ballOnBotSide = perceived.x > 0;
    const ballMovingAway = perceived.vx < -0.5;
    const ballMovingTowardBotGoal = perceived.vx > 0.5 && perceived.x > 1;

    if (ballOnBotSide && distToBall < BOT_FORCE_RANGE) {
      bot.mode = "REPEL";
    } else if (!ballOnBotSide && ballMovingAway && distToBall < BOT_FORCE_RANGE * 2.8) {
      bot.mode = "ATTRACT";
    } else if (ballMovingTowardBotGoal && distToBall < BOT_FORCE_RANGE * 2.2) {
      bot.mode = "ATTRACT";
    } else if (ballOnBotSide && distToBall < BOT_FORCE_RANGE * 2) {
      bot.mode = "ATTRACT";
    } else {
      bot.mode = "NONE";
    }

    } // end BOT-only AI

    // ── Player 1 input (W/S + Q/A or left slider) ──────────────────────────
    const keys = keysRef.current;
    const p1Keyboard = keys["w"] || keys["W"] || keys["s"] || keys["S"];
    if (keys["w"] || keys["W"]) {
      s.p1.z = Math.max(s.p1.z - 7 * dt, -ARENA_H / 2 + 0.8);
      sliderRef.current = s.p1.z / (ARENA_H / 2 - 0.8);
    }
    if (keys["s"] || keys["S"]) {
      s.p1.z = Math.min(s.p1.z + 7 * dt, ARENA_H / 2 - 0.8);
      sliderRef.current = s.p1.z / (ARENA_H / 2 - 0.8);
    }
    if (!p1Keyboard) {
      const targetP1Z = sliderRef.current * (ARENA_H / 2 - 0.8);
      s.p1.z += (targetP1Z - s.p1.z) * Math.min(1, dt * 14);
      s.p1.z = clamp(s.p1.z, -ARENA_H / 2 + 0.8, ARENA_H / 2 - 0.8);
    }
    if (keys["q"] || keys["Q"]) s.p1.mode = "ATTRACT";
    else if (keys["a"] || keys["A"]) s.p1.mode = "REPEL";
    else s.p1.mode = "NONE";

    // ── Player 2 input (↑/↓ + O/P or right slider) — only in 2P mode ───────
    if (gameModeRef.current === "2P") {
      const p2Keyboard = keys["ArrowUp"] || keys["ArrowDown"];
      if (keys["ArrowUp"]) {
        s.bot.z = Math.max(s.bot.z - 7 * dt, -ARENA_H / 2 + 0.8);
        slider2Ref.current = s.bot.z / (ARENA_H / 2 - 0.8);
      }
      if (keys["ArrowDown"]) {
        s.bot.z = Math.min(s.bot.z + 7 * dt, ARENA_H / 2 - 0.8);
        slider2Ref.current = s.bot.z / (ARENA_H / 2 - 0.8);
      }
      if (!p2Keyboard) {
        const targetP2Z = slider2Ref.current * (ARENA_H / 2 - 0.8);
        s.bot.z += (targetP2Z - s.bot.z) * Math.min(1, dt * 14);
        s.bot.z = clamp(s.bot.z, -ARENA_H / 2 + 0.8, ARENA_H / 2 - 0.8);
      }
      if (keys["o"] || keys["O"]) s.bot.mode = "ATTRACT";
      else if (keys["p"] || keys["P"]) s.bot.mode = "REPEL";
      else s.bot.mode = "NONE";
    }

    // Ghost poles — drift, bounce off walls, cycle modes
    for (const g of s.ghosts) {
      g.x += g.vx * dt;
      g.z += g.vz * dt;
      // Bounce inside arena (keep away from goal mouths)
      if (g.x > ARENA_W / 2 - 1.2) { g.x = ARENA_W / 2 - 1.2; g.vx *= -1; }
      if (g.x < -ARENA_W / 2 + 1.2) { g.x = -ARENA_W / 2 + 1.2; g.vx *= -1; }
      if (g.z > ARENA_H / 2 - 0.8) { g.z = ARENA_H / 2 - 0.8; g.vz *= -1; }
      if (g.z < -ARENA_H / 2 + 0.8) { g.z = -ARENA_H / 2 + 0.8; g.vz *= -1; }
      // Mode cycle timer
      g.timer -= dt;
      if (g.timer <= 0) {
        const roll = Math.random();
        g.mode = roll < 0.38 ? "ATTRACT" : roll < 0.76 ? "REPEL" : "NONE";
        g.timer = GHOST_CYCLE_MIN + Math.random() * (GHOST_CYCLE_MAX - GHOST_CYCLE_MIN);
        // Small random velocity nudge on mode change for extra chaos
        g.vx = (Math.random() - 0.5) * GHOST_DRIFT_SPEED * 2;
        g.vz = (Math.random() - 0.5) * GHOST_DRIFT_SPEED * 2;
      }
    }

    // Magnetic forces
    // Own-goal guard: disable player REPEL if ball is already on their side heading into their goal
    const p1ModeGuarded = (s.p1.mode === "REPEL" && ball.x < -1.0 && ball.vx < 0)
      ? "NONE" : s.p1.mode;
    const fp1 = magnetForce(s.p1, ball, p1ModeGuarded);
    const fbot = magnetForce(s.bot, ball, s.bot.mode);

    const fghosts = s.ghosts.reduce((acc, g) => {
      const f = ghostForce(g, ball);
      return { fx: acc.fx + f.fx, fz: acc.fz + f.fz };
    }, { fx: 0, fz: 0 });
    ball.vx += (fp1.fx + fbot.fx + fghosts.fx) * dt;
    ball.vz += (fp1.fz + fbot.fz + fghosts.fz) * dt;

    // Speed cap
    const spd = Math.sqrt(ball.vx ** 2 + ball.vz ** 2);
    if (spd > MAX_SPEED) {
      ball.vx = (ball.vx / spd) * MAX_SPEED;
      ball.vz = (ball.vz / spd) * MAX_SPEED;
    }

    // Damping
    ball.vx *= Math.pow(DAMPING, dt * 60);
    ball.vz *= Math.pow(DAMPING, dt * 60);

    // Move ball
    ball.x += ball.vx * dt;
    ball.z += ball.vz * dt;

    // Wall collisions (top/bottom)
    const halfH = ARENA_H / 2 - BALL_R;
    if (ball.z > halfH) { ball.z = halfH; ball.vz *= -WALL_RESTITUTION; }
    if (ball.z < -halfH) { ball.z = -halfH; ball.vz *= -WALL_RESTITUTION; }

    // Side wall collisions (only outside goal gap)
    const halfW = ARENA_W / 2 - BALL_R;
    const inGoalGap = Math.abs(ball.z) < GOAL_H / 2;

    if (ball.x < -halfW) {
      if (inGoalGap) {
        // GOAL for bot
        const newScore = { p1: s.score.p1, bot: s.score.bot + 1 };
        s.score = newScore;
        s.goalFlash = 1;
        if (newScore.bot >= SCORE_LIMIT) {
          s.phase = "GAMEOVER";
          s.winner = "BOT";
        } else {
          resetBall(s);
        }
        setUiState(u => ({ ...u, score: newScore, phase: s.phase, winner: s.winner }));
      } else {
        ball.x = -halfW; ball.vx *= -WALL_RESTITUTION;
      }
    }
    if (ball.x > halfW) {
      if (inGoalGap) {
        // GOAL for p1
        const newScore = { p1: s.score.p1 + 1, bot: s.score.bot };
        s.score = newScore;
        s.goalFlash = 1;
        if (newScore.p1 >= SCORE_LIMIT) {
          s.phase = "GAMEOVER";
          s.winner = "PLAYER";
        } else {
          resetBall(s);
        }
        setUiState(u => ({ ...u, score: newScore, phase: s.phase, winner: s.winner }));
      } else {
        ball.x = halfW; ball.vx *= -WALL_RESTITUTION;
      }
    }

    // Pole-ball collision
    for (const pole of [s.p1, s.bot]) {
      const dx = ball.x - pole.x;
      const dz = ball.z - pole.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const minD = BALL_R + POLE_R;
      if (dist < minD && dist > 0) {
        const nx = dx / dist;
        const nz = dz / dist;
        ball.x = pole.x + nx * minD;
        ball.z = pole.z + nz * minD;
        const dot = ball.vx * nx + ball.vz * nz;
        ball.vx -= 2 * dot * nx * RESTITUTION;
        ball.vz -= 2 * dot * nz * RESTITUTION;
      }
    }

    // Goal flash decay
    if (s.goalFlash > 0) s.goalFlash = Math.max(0, s.goalFlash - dt * 3);

    // Trail
    const trail = trailRef.current;
    trail.push({ x: ball.x, z: ball.z, vx: ball.vx, vz: ball.vz });
    if (trail.length > TRAIL_LENGTH) trail.shift();

    // Sync UI mode display
    setUiState(u => ({ ...u, p1Mode: s.p1.mode, botMode: s.bot.mode, botDelay: s.adaptiveDelay ?? 0.15 }));
  }, []);

  function resetBall(s) {
    s.ball = {
      x: (Math.random() - 0.5) * 2,
      z: (Math.random() - 0.5) * 2,
      vx: (Math.random() > 0.5 ? 1 : -1) * (3 + Math.random() * 2),
      vz: (Math.random() - 0.5) * 3,
    };
    trailRef.current = [];
  }

  // ─── Game Loop ────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    const resize = () => {
      const container = canvas.parentElement;
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
    };
    resize();
    window.addEventListener("resize", resize);

    const loop = (ts) => {
      if (lastTimeRef.current === null) lastTimeRef.current = ts;
      const rawDt = (ts - lastTimeRef.current) / 1000;
      lastTimeRef.current = ts;
      const dt = Math.min(rawDt, 1 / 30);

      step(dt);
      draw(ctx, canvas.width, canvas.height, stateRef.current);
      animRef.current = requestAnimationFrame(loop);
    };

    animRef.current = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener("resize", resize);
    };
  }, [step, draw]);

  // ─── Keyboard ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const down = (e) => { keysRef.current[e.key] = true; e.preventDefault?.(); };
    const up = (e) => { keysRef.current[e.key] = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  // ─── Actions ──────────────────────────────────────────────────────────────
  const startGame = (mode) => {
    const m = mode || gameModeRef.current;
    gameModeRef.current = m;
    setGameMode(m);
    stateRef.current = initState();
    stateRef.current.phase = "PLAYING";
    trailRef.current = [];
    lastTimeRef.current = null;
    setUiState({ score: { p1: 0, bot: 0 }, phase: "PLAYING", p1Mode: "NONE", botMode: "NONE", winner: null, botDelay: 0.15 });
  };

  const modeColor = (m) => m === "ATTRACT" ? C_ATTRACT : m === "REPEL" ? C_REPEL : "rgba(255,255,255,0.3)";
  const modeLabel = (m) => m === "ATTRACT" ? "ATTRACT" : m === "REPEL" ? "REPEL" : "STANDBY";

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#020509", display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: "'Courier New', monospace" }}>

      {/* ── Header HUD ─────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "6px 14px", background: "rgba(0,0,0,0.7)",
        borderBottom: "1px solid rgba(0,255,255,0.10)", zIndex: 10, flexShrink: 0,
      }}>
        {/* P1 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 100 }}>
          <span style={{ color: C_P1, fontSize: 9, letterSpacing: 3, opacity: 0.7 }}>PLAYER_1</span>
          <span style={{ color: C_P1, fontSize: 20, fontWeight: "bold", lineHeight: 1 }}>{uiState.score.p1}</span>
          <span style={{ color: modeColor(uiState.p1Mode), fontSize: 8, letterSpacing: 2, padding: "1px 5px", border: `1px solid ${modeColor(uiState.p1Mode)}`, display: "inline-block", opacity: uiState.p1Mode !== "NONE" ? 1 : 0.35 }}>
            {modeLabel(uiState.p1Mode)}
          </span>
        </div>

        {/* Center */}
        <div style={{ textAlign: "center" }}>
          <div style={{ color: "rgba(255,255,255,0.9)", fontSize: 12, letterSpacing: 5, fontWeight: "bold" }}>MAG·PHYS</div>
          <div style={{ color: "rgba(255,255,255,0.25)", fontSize: 7, letterSpacing: 3, marginTop: 1 }}>
            {gameMode === "2P" ? "LOCAL 2P" : "VS BOT"}
          </div>
        </div>

        {/* P2 / Bot */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, minWidth: 100 }}>
          <span style={{ color: C_BOT, fontSize: 9, letterSpacing: 3, opacity: 0.7 }}>{gameMode === "2P" ? "PLAYER_2" : "SYS_BOT"}</span>
          <span style={{ color: C_BOT, fontSize: 20, fontWeight: "bold", lineHeight: 1 }}>{uiState.score.bot}</span>
          <span style={{ color: modeColor(uiState.botMode), fontSize: 8, letterSpacing: 2, padding: "1px 5px", border: `1px solid ${modeColor(uiState.botMode)}`, display: "inline-block", opacity: uiState.botMode !== "NONE" ? 1 : 0.35 }}>
            {modeLabel(uiState.botMode)}
          </span>
          {gameMode === "BOT" && uiState.botDelay != null && (
            <span style={{ color: uiState.botDelay > 0.22 ? "#ffaa00" : uiState.botDelay < 0.08 ? "#ff4444" : "rgba(255,255,255,0.25)", fontSize: 7, letterSpacing: 2 }}>
              {uiState.botDelay > 0.22 ? "SLOW" : uiState.botDelay < 0.08 ? "SHARP" : "NORM"}
            </span>
          )}
        </div>
      </div>

      {/* ── Game Canvas ────────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />

        {/* MENU */}
        {uiState.phase === "MENU" && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "rgba(2,5,9,0.90)", zIndex: 20 }}>
            <div style={{ color: "rgba(0,255,255,0.4)", fontSize: 9, letterSpacing: 8, marginBottom: 6 }}>MAGNETIC ARCADE</div>
            <div style={{ color: "#fff", fontSize: 32, fontWeight: "bold", letterSpacing: 8, marginBottom: 4, textShadow: `0 0 30px ${C_ATTRACT}` }}>MAG·PHYS</div>
            <div style={{ color: "rgba(255,255,255,0.25)", fontSize: 9, letterSpacing: 4, marginBottom: 28 }}>SIMULATOR</div>

            {/* Mode picker */}
            <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
              <button onClick={() => startGame("BOT")} style={{
                background: gameMode === "BOT" ? C_ATTRACT + "22" : "transparent",
                border: `1px solid ${gameMode === "BOT" ? C_ATTRACT : "rgba(255,255,255,0.2)"}`,
                color: gameMode === "BOT" ? C_ATTRACT : "rgba(255,255,255,0.4)",
                padding: "10px 24px", fontSize: 11, letterSpacing: 3, cursor: "pointer", fontFamily: "monospace",
              }}>VS BOT</button>
              <button onClick={() => startGame("2P")} style={{
                background: gameMode === "2P" ? C_REPEL + "22" : "transparent",
                border: `1px solid ${gameMode === "2P" ? C_REPEL : "rgba(255,255,255,0.2)"}`,
                color: gameMode === "2P" ? C_REPEL : "rgba(255,255,255,0.4)",
                padding: "10px 24px", fontSize: 11, letterSpacing: 3, cursor: "pointer", fontFamily: "monospace",
              }}>LOCAL 2P</button>
            </div>

            <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, lineHeight: 2, textAlign: "center", marginBottom: 6 }}>
              {gameMode === "BOT" ? (
                <><span style={{ color: C_ATTRACT }}>W/S</span> move &nbsp;·&nbsp; <span style={{ color: C_ATTRACT }}>Q</span> attract &nbsp;·&nbsp; <span style={{ color: C_REPEL }}>A</span> repel</>
              ) : (
                <><span style={{ color: C_ATTRACT }}>W/S · Q/A</span> &nbsp;&nbsp; Player 1 &nbsp;&nbsp;|&nbsp;&nbsp; Player 2 &nbsp;&nbsp; <span style={{ color: C_REPEL }}>↑/↓ · O/P</span></>
              )}
            </div>
            <div style={{ color: "rgba(255,255,255,0.2)", fontSize: 9, marginBottom: 0 }}>First to {SCORE_LIMIT}</div>
          </div>
        )}

        {/* GAMEOVER */}
        {uiState.phase === "GAMEOVER" && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "rgba(2,5,9,0.92)", zIndex: 20 }}>
            <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 9, letterSpacing: 6, marginBottom: 14 }}>MATCH COMPLETE</div>
            <div style={{ color: uiState.winner === "PLAYER" ? C_ATTRACT : C_REPEL, fontSize: 26, fontWeight: "bold", letterSpacing: 6, marginBottom: 6, textShadow: `0 0 24px ${uiState.winner === "PLAYER" ? C_ATTRACT : C_REPEL}` }}>
              {uiState.winner === "PLAYER" ? "PLAYER 1" : (gameMode === "2P" ? "PLAYER 2" : "SYS·BOT")}
            </div>
            <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 11, letterSpacing: 4, marginBottom: 6 }}>FIELD DOMINANCE</div>
            <div style={{ fontSize: 20, marginBottom: 28 }}>
              <span style={{ color: C_ATTRACT }}>{uiState.score.p1}</span>
              <span style={{ color: "rgba(255,255,255,0.15)", margin: "0 10px" }}>:</span>
              <span style={{ color: C_REPEL }}>{uiState.score.bot}</span>
            </div>
            <div style={{ display: "flex", gap: 12 }}>
              <button onClick={() => startGame(gameMode)} style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.25)", color: "rgba(255,255,255,0.6)", padding: "10px 28px", fontSize: 11, letterSpacing: 3, cursor: "pointer", fontFamily: "monospace" }}>
                REMATCH
              </button>
              <button onClick={() => { stateRef.current.phase = "MENU"; setUiState(u => ({ ...u, phase: "MENU" })); }} style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.35)", padding: "10px 28px", fontSize: 11, letterSpacing: 3, cursor: "pointer", fontFamily: "monospace" }}>
                MENU
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Bottom Controls ─────────────────────────────────────────────── */}
      <div style={{
        flexShrink: 0, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(12px)",
        borderTop: "1px solid rgba(255,255,255,0.06)", zIndex: 10,
        padding: "8px 12px 12px", display: "flex",
        flexDirection: gameMode === "2P" ? "row" : "column",
        gap: 8,
      }}>

        {/* ── P1 Panel ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, borderRight: gameMode === "2P" ? "1px solid rgba(255,255,255,0.07)" : "none", paddingRight: gameMode === "2P" ? 10 : 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: C_P1, fontSize: 8, letterSpacing: 3, whiteSpace: "nowrap", opacity: 0.7 }}>P1 · Z</span>
            <input type="range" min="-100" max="100"
              value={Math.round(sliderVal * 100)}
              onChange={e => { const v = parseInt(e.target.value) / 100; setSliderVal(v); sliderRef.current = v; }}
              style={{ flex: 1, accentColor: C_ATTRACT, cursor: "pointer" }}
            />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onPointerDown={() => { keysRef.current["q"] = true; }} onPointerUp={() => { keysRef.current["q"] = false; }} onPointerLeave={() => { keysRef.current["q"] = false; }}
              style={{ flex: 1, padding: "12px 0", background: "rgba(0,255,255,0.07)", border: `1px solid ${C_ATTRACT}`, color: C_ATTRACT, fontSize: 10, letterSpacing: 2, fontFamily: "monospace", cursor: "pointer", touchAction: "none", userSelect: "none" }}
            >− ATTRACT</button>
            <button
              onPointerDown={() => { keysRef.current["a"] = true; }} onPointerUp={() => { keysRef.current["a"] = false; }} onPointerLeave={() => { keysRef.current["a"] = false; }}
              style={{ flex: 1, padding: "12px 0", background: "rgba(255,0,255,0.07)", border: `1px solid ${C_REPEL}`, color: C_REPEL, fontSize: 10, letterSpacing: 2, fontFamily: "monospace", cursor: "pointer", touchAction: "none", userSelect: "none" }}
            >+ REPEL</button>
          </div>
        </div>

        {/* ── P2 Panel (2P mode only) ── */}
        {gameMode === "2P" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, paddingLeft: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: C_BOT, fontSize: 8, letterSpacing: 3, whiteSpace: "nowrap", opacity: 0.7 }}>P2 · Z</span>
              <input type="range" min="-100" max="100"
                value={Math.round(slider2Val * 100)}
                onChange={e => { const v = parseInt(e.target.value) / 100; setSlider2Val(v); slider2Ref.current = v; }}
                style={{ flex: 1, accentColor: C_BOT, cursor: "pointer" }}
              />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onPointerDown={() => { keysRef.current["o"] = true; }} onPointerUp={() => { keysRef.current["o"] = false; }} onPointerLeave={() => { keysRef.current["o"] = false; }}
                style={{ flex: 1, padding: "12px 0", background: "rgba(0,255,255,0.07)", border: `1px solid ${C_ATTRACT}`, color: C_ATTRACT, fontSize: 10, letterSpacing: 2, fontFamily: "monospace", cursor: "pointer", touchAction: "none", userSelect: "none" }}
              >− ATTRACT</button>
              <button
                onPointerDown={() => { keysRef.current["p"] = true; }} onPointerUp={() => { keysRef.current["p"] = false; }} onPointerLeave={() => { keysRef.current["p"] = false; }}
                style={{ flex: 1, padding: "12px 0", background: "rgba(255,0,255,0.07)", border: `1px solid ${C_REPEL}`, color: C_REPEL, fontSize: 10, letterSpacing: 2, fontFamily: "monospace", cursor: "pointer", touchAction: "none", userSelect: "none" }}
              >+ REPEL</button>
            </div>
          </div>
        )}
      </div>

      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input[type=range] { height: 4px; }
        input[type=range]::-webkit-slider-thumb { width: 20px; height: 20px; border-radius: 50%; }
        canvas { display: block; }
        button:active { opacity: 0.75; }
      `}</style>
    </div>
  );
}
