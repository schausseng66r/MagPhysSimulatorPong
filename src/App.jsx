import { useRef, useEffect, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import { create } from "zustand";
import * as THREE from "three";

// ─── Constants ────────────────────────────────────────────────────────────────
const ARENA_W        = 14;
const ARENA_H        = 9;
const BALL_R         = 0.28;
const POLE_R         = 0.55;
const GOAL_H         = 3.8;
const MAG_STRENGTH   = 52;
const MAG_MIN_DIST   = 0.9;
const DAMPING        = 0.999;
const RESTITUTION    = 0.82;
const WALL_REST      = 0.75;
const MAX_SPEED      = 26;
const BOT_SPEED      = 5.5;
const BOT_RANGE      = 3.4;
const SCORE_LIMIT    = 5;
const GHOST_STRENGTH = 6;
const GHOST_MIN_DIST = 1.4;
const GHOST_DRIFT    = 0.9;
const GHOST_MIN      = 2.2;
const GHOST_MAX      = 5.5;
const TRAIL_LEN      = 28;
const FIELD_COLS     = 20;
const FIELD_ROWS     = 13;
const FIELD_COUNT    = FIELD_COLS * FIELD_ROWS;

const C_ATTRACT = "#00FFFF";
const C_REPEL   = "#FF00FF";

// Submerged Analog Minimalism -- UI palette
// Lo-fi, low-contrast, monochrome. Heavy vignette, deep grain, murky atmosphere.
// Scene materials (poles/ball/field) keep faint hue separation for gameplay
// readability; all UI chrome (HUD/menu/buttons) is fully desaturated.
const UI = {
  void:     "#0A0C0D",
  depth1:   "#13171A",
  depth2:   "#1A1F22",
  silt:     "rgba(180,190,188,0.10)",
  siltSoft: "rgba(180,190,188,0.05)",
  haze:     "rgba(195,202,200,0.42)",
  hazeDim:  "rgba(195,202,200,0.22)",
  ghost:    "rgba(195,202,200,0.10)",
  bone:     "#C7CDC9",
  attract:  "#9FB0AC",
  repel:    "#B0A29B",
};

// ─── Math helpers ─────────────────────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function magForce(pole, ball, mode, str = MAG_STRENGTH, minD = MAG_MIN_DIST) {
  if (mode === "NONE") return { fx: 0, fz: 0 };
  const dx   = ball.x - pole.x;
  const dz   = ball.z - pole.z;
  const dist = Math.max(Math.sqrt(dx * dx + dz * dz), minD);
  const mag  = str / (dist * dist);
  const sign = mode === "ATTRACT" ? -1 : 1;
  return { fx: sign * (dx / dist) * mag, fz: sign * (dz / dist) * mag };
}
const ghostF = (g, b) => magForce(g, b, g.mode, GHOST_STRENGTH, GHOST_MIN_DIST);

function makeBall() {
  return {
    x: (Math.random() - 0.5) * 2, z: (Math.random() - 0.5) * 2,
    vx: (Math.random() > 0.5 ? 1 : -1) * (3 + Math.random() * 2),
    vz: (Math.random() - 0.5) * 3,
  };
}
function makeGhosts() {
  return Array.from({ length: 3 }, (_, i) => ({
    x: (Math.random() - 0.5) * (ARENA_W - 3),
    z: (Math.random() - 0.5) * (ARENA_H - 2),
    vx: (Math.random() - 0.5) * GHOST_DRIFT * 2,
    vz: (Math.random() - 0.5) * GHOST_DRIFT * 2,
    mode: i === 0 ? "ATTRACT" : i === 1 ? "REPEL" : "NONE",
    timer: GHOST_MIN + Math.random() * (GHOST_MAX - GHOST_MIN),
  }));
}

// ─── Zustand store ────────────────────────────────────────────────────────────
const useStore = create((set, get) => ({
  phase:    "MENU",
  gameMode: "BOT",
  winner:   null,
  score:    { p1: 0, bot: 0 },
  goalFlash:    0,
  cameraShake:  0,
  ball:   makeBall(),
  p1:     { x: -(ARENA_W / 2 - 1.5), z: 0, mode: "NONE" },
  bot:    { x:  (ARENA_W / 2 - 1.5), z: 0, mode: "NONE" },
  ghosts: makeGhosts(),

  setPhase:    (phase)    => set({ phase }),
  setGameMode: (gameMode) => set({ gameMode }),

  startGame: (mode) => {
    const gameMode = mode || get().gameMode;
    set({
      gameMode, phase: "PLAYING", winner: null,
      score: { p1: 0, bot: 0 },
      ball: makeBall(),
      p1:  { x: -(ARENA_W / 2 - 1.5), z: 0, mode: "NONE" },
      bot: { x:  (ARENA_W / 2 - 1.5), z: 0, mode: "NONE" },
      ghosts: makeGhosts(),
      goalFlash: 0, cameraShake: 0,
    });
  },

  scoreGoal: (scorer) => {
    const { score } = get();
    const s = {
      p1:  scorer === "p1"  ? score.p1  + 1 : score.p1,
      bot: scorer === "bot" ? score.bot + 1 : score.bot,
    };
    if      (s.p1  >= SCORE_LIMIT) set({ score: s, phase: "GAMEOVER", winner: "PLAYER", goalFlash: 1, cameraShake: 1 });
    else if (s.bot >= SCORE_LIMIT) set({ score: s, phase: "GAMEOVER", winner: "BOT",    goalFlash: 1, cameraShake: 1 });
    else                           set({ score: s, ball: makeBall(), goalFlash: 1, cameraShake: 1 });
  },
}));

// ─── Pre-compute field grid ───────────────────────────────────────────────────
const fieldX = [], fieldZ = [];
for (let i = 0; i < FIELD_COLS; i++)
  for (let j = 0; j < FIELD_ROWS; j++) {
    fieldX.push(-ARENA_W / 2 + (i + 0.5) * (ARENA_W / FIELD_COLS));
    fieldZ.push(-ARENA_H / 2 + (j + 0.5) * (ARENA_H / FIELD_ROWS));
  }

// ─── Physics controller ───────────────────────────────────────────────────────
function PhysicsController({ keysRef, s1Ref, s2Ref, modeRef }) {
  const stuckRef  = useRef(0);
  const stallRef  = useRef(0);
  const percRef   = useRef(null);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 1 / 30);
    const s  = useStore.getState();
    if (s.phase !== "PLAYING") return;

    const ball   = { ...s.ball };
    const p1     = { ...s.p1 };
    const bot    = { ...s.bot };
    const ghosts = s.ghosts.map(g => ({ ...g }));

    // Stall kick
    const spd = Math.sqrt(ball.vx ** 2 + ball.vz ** 2);
    if (spd < 0.8) stallRef.current += dt; else stallRef.current = 0;
    if (stallRef.current > 1.8) {
      ball.vx += (ball.x > 0 ? -1 : 1) * 6;
      ball.vz += (Math.random() - 0.5) * 4;
      stallRef.current = 0;
    }

    // Bot AI
    if (modeRef.current === "BOT") {
      const rd = Math.sqrt((ball.x - bot.x) ** 2 + (ball.z - bot.z) ** 2);
      if (rd < 1.8 && spd < 1.5) stuckRef.current += dt; else stuckRef.current = 0;
      if (stuckRef.current > 0.5) {
        ball.vx = -10 - Math.random() * 4;
        ball.vz = (Math.random() - 0.5) * 7;
        bot.mode = "NONE"; stuckRef.current = 0;
      }
      const delay = clamp(0.15 - (s.score.p1 - s.score.bot) * 0.045, 0.04, 0.38);
      if (!percRef.current) percRef.current = { x: ball.x, z: ball.z, vx: ball.vx, vz: ball.vz, t: 0 };
      percRef.current.t += dt;
      if (percRef.current.t >= delay) percRef.current = { x: ball.x, z: ball.z, vx: ball.vx, vz: ball.vz, t: 0 };
      const p = percRef.current;
      const tz = clamp(p.z + p.vz * 0.18, -ARENA_H / 2 + 0.8, ARENA_H / 2 - 0.8);
      bot.z = clamp(bot.z + clamp(tz - bot.z, -BOT_SPEED * dt, BOT_SPEED * dt), -ARENA_H / 2 + 0.8, ARENA_H / 2 - 0.8);
      const dp = Math.sqrt((p.x - bot.x) ** 2 + (p.z - bot.z) ** 2);
      if      (p.x > 0  && dp < BOT_RANGE)              bot.mode = "REPEL";
      else if (p.x <= 0 && p.vx < -0.5 && dp < BOT_RANGE * 2.8) bot.mode = "ATTRACT";
      else if (p.vx > 0.5 && p.x > 1  && dp < BOT_RANGE * 2.2) bot.mode = "ATTRACT";
      else if (p.x > 0  && dp < BOT_RANGE * 2)          bot.mode = "ATTRACT";
      else                                                bot.mode = "NONE";
    }

    // P1 input
    const keys = keysRef.current;
    const p1kb = keys["w"] || keys["W"] || keys["s"] || keys["S"];
    if (keys["w"] || keys["W"]) { p1.z = Math.max(p1.z - 7 * dt, -ARENA_H / 2 + 0.8); s1Ref.current = p1.z / (ARENA_H / 2 - 0.8); }
    if (keys["s"] || keys["S"]) { p1.z = Math.min(p1.z + 7 * dt,  ARENA_H / 2 - 0.8); s1Ref.current = p1.z / (ARENA_H / 2 - 0.8); }
    if (!p1kb) p1.z = clamp(p1.z + (s1Ref.current * (ARENA_H / 2 - 0.8) - p1.z) * Math.min(1, dt * 14), -ARENA_H / 2 + 0.8, ARENA_H / 2 - 0.8);
    if      (keys["q"] || keys["Q"]) p1.mode = "ATTRACT";
    else if (keys["a"] || keys["A"]) p1.mode = "REPEL";
    else                              p1.mode = "NONE";

    // P2 input
    if (modeRef.current === "2P") {
      const p2kb = keys["ArrowUp"] || keys["ArrowDown"];
      if (keys["ArrowUp"])   { bot.z = Math.max(bot.z - 7 * dt, -ARENA_H / 2 + 0.8); s2Ref.current = bot.z / (ARENA_H / 2 - 0.8); }
      if (keys["ArrowDown"]) { bot.z = Math.min(bot.z + 7 * dt,  ARENA_H / 2 - 0.8); s2Ref.current = bot.z / (ARENA_H / 2 - 0.8); }
      if (!p2kb) bot.z = clamp(bot.z + (s2Ref.current * (ARENA_H / 2 - 0.8) - bot.z) * Math.min(1, dt * 14), -ARENA_H / 2 + 0.8, ARENA_H / 2 - 0.8);
      if      (keys["o"] || keys["O"]) bot.mode = "ATTRACT";
      else if (keys["p"] || keys["P"]) bot.mode = "REPEL";
      else                              bot.mode = "NONE";
    }

    // Ghosts
    for (const g of ghosts) {
      g.x += g.vx * dt; g.z += g.vz * dt;
      if (g.x >  ARENA_W / 2 - 1.2) { g.x =  ARENA_W / 2 - 1.2; g.vx *= -1; }
      if (g.x < -ARENA_W / 2 + 1.2) { g.x = -ARENA_W / 2 + 1.2; g.vx *= -1; }
      if (g.z >  ARENA_H / 2 - 0.8) { g.z =  ARENA_H / 2 - 0.8; g.vz *= -1; }
      if (g.z < -ARENA_H / 2 + 0.8) { g.z = -ARENA_H / 2 + 0.8; g.vz *= -1; }
      g.timer -= dt;
      if (g.timer <= 0) {
        const r = Math.random();
        g.mode  = r < 0.38 ? "ATTRACT" : r < 0.76 ? "REPEL" : "NONE";
        g.timer = GHOST_MIN + Math.random() * (GHOST_MAX - GHOST_MIN);
        g.vx    = (Math.random() - 0.5) * GHOST_DRIFT * 2;
        g.vz    = (Math.random() - 0.5) * GHOST_DRIFT * 2;
      }
    }

    // Forces
    const p1g  = (p1.mode === "REPEL" && ball.x < -1.0 && ball.vx < 0) ? "NONE" : p1.mode;
    const fp1  = magForce(p1, ball, p1g);
    const fbot = magForce(bot, ball, bot.mode);
    const fg   = ghosts.reduce((a, g) => { const f = ghostF(g, ball); return { fx: a.fx + f.fx, fz: a.fz + f.fz }; }, { fx: 0, fz: 0 });
    ball.vx += (fp1.fx + fbot.fx + fg.fx) * dt;
    ball.vz += (fp1.fz + fbot.fz + fg.fz) * dt;

    // Speed cap + damping
    const bs = Math.sqrt(ball.vx ** 2 + ball.vz ** 2);
    if (bs > MAX_SPEED) { ball.vx = (ball.vx / bs) * MAX_SPEED; ball.vz = (ball.vz / bs) * MAX_SPEED; }
    const df = Math.pow(DAMPING, dt * 60);
    ball.vx *= df; ball.vz *= df;
    ball.x  += ball.vx * dt; ball.z += ball.vz * dt;

    // Wall collisions
    const hH = ARENA_H / 2 - BALL_R;
    if (ball.z >  hH) { ball.z =  hH; ball.vz *= -WALL_REST; }
    if (ball.z < -hH) { ball.z = -hH; ball.vz *= -WALL_REST; }
    const hW = ARENA_W / 2 - BALL_R;
    const inGoal = Math.abs(ball.z) < GOAL_H / 2;
    if (ball.x < -hW) {
      if (inGoal) { useStore.getState().scoreGoal("bot"); percRef.current = null; stuckRef.current = 0; return; }
      else { ball.x = -hW; ball.vx *= -WALL_REST; }
    }
    if (ball.x > hW) {
      if (inGoal) { useStore.getState().scoreGoal("p1"); percRef.current = null; stuckRef.current = 0; return; }
      else { ball.x = hW; ball.vx *= -WALL_REST; }
    }

    // Pole collisions
    for (const pole of [p1, bot]) {
      const dx = ball.x - pole.x, dz = ball.z - pole.z;
      const d  = Math.sqrt(dx * dx + dz * dz);
      const mn = BALL_R + POLE_R;
      if (d < mn && d > 0) {
        ball.x = pole.x + (dx / d) * mn; ball.z = pole.z + (dz / d) * mn;
        const dot = ball.vx * (dx / d) + ball.vz * (dz / d);
        ball.vx -= 2 * dot * (dx / d) * RESTITUTION;
        ball.vz -= 2 * dot * (dz / d) * RESTITUTION;
      }
    }

    useStore.setState({
      ball, p1, bot, ghosts,
      goalFlash:   Math.max(0, s.goalFlash   - dt * 3),
      cameraShake: Math.max(0, s.cameraShake - dt * 4),
    });
  });

  return null;
}

// ─── Camera rig ───────────────────────────────────────────────────────────────
function CameraRig() {
  const { camera } = useThree();
  useFrame(() => {
    const { cameraShake } = useStore.getState();
    const mobile = window.innerWidth < 768;
    const bY = mobile ? 11 : 8, bZ = 2.5, fov = mobile ? 70 : 60;
    if (Math.abs(camera.fov - fov) > 0.1) { camera.fov += (fov - camera.fov) * 0.05; camera.updateProjectionMatrix(); }
    const sh = cameraShake * 0.15;
    camera.position.set((Math.random() - 0.5) * sh, bY + (Math.random() - 0.5) * sh * 0.4, bZ);
    camera.lookAt(0, 0, 0);
  });
  return null;
}

// ─── Arena ────────────────────────────────────────────────────────────────────
function Arena() {
  const goalFlash = useStore(s => s.goalFlash);
  const hW = ARENA_W / 2, hH = ARENA_H / 2, gH = GOAL_H / 2;
  const seg = hH - gH;

  return (
    <group>
      {/* Table */}
      <mesh receiveShadow position={[0, -0.12, 0]}>
        <boxGeometry args={[ARENA_W, 0.22, ARENA_H]} />
        <meshStandardMaterial color="#080E1A" metalness={0.85} roughness={0.18} />
      </mesh>

      {/* Top / bottom walls */}
      {[1, -1].map(s => (
        <mesh key={s} position={[0, 0.2, s * (hH + 0.09)]}>
          <boxGeometry args={[ARENA_W + 0.36, 0.4, 0.18]} />
          <meshStandardMaterial color="#1A2535" metalness={0.6} roughness={0.4} />
        </mesh>
      ))}

      {/* Left wall segments */}
      {[1, -1].map(s => (
        <mesh key={s} position={[-(hW + 0.09), 0.2, s * (hH / 2 + gH / 2)]}>
          <boxGeometry args={[0.18, 0.4, seg]} />
          <meshStandardMaterial color="#1A2535" metalness={0.6} roughness={0.4} emissive={UI.attract} emissiveIntensity={0.04} />
        </mesh>
      ))}

      {/* Right wall segments */}
      {[1, -1].map(s => (
        <mesh key={s} position={[(hW + 0.09), 0.2, s * (hH / 2 + gH / 2)]}>
          <boxGeometry args={[0.18, 0.4, seg]} />
          <meshStandardMaterial color="#1A2535" metalness={0.6} roughness={0.4} emissive={UI.repel} emissiveIntensity={0.04} />
        </mesh>
      ))}

      {/* Center line */}
      <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.03, ARENA_H]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.07} />
      </mesh>

      {/* Goal lights */}
      <pointLight position={[-hW - 0.5, 0.5, 0]} color={UI.attract} intensity={1.4 + goalFlash * 4} distance={4} decay={2} />
      <pointLight position={[ hW + 0.5, 0.5, 0]} color={UI.repel} intensity={1.4 + goalFlash * 4} distance={4} decay={2} />
    </group>
  );
}

// ─── Ball ─────────────────────────────────────────────────────────────────────
const _ballColor  = new THREE.Color();
const _trailColor = new THREE.Color();

function Ball() {
  const meshRef  = useRef();
  const lightRef = useRef();
  const trailRef = useRef(Array.from({ length: TRAIL_LEN }, () => useRef()));
  const histRef  = useRef([]);

  useFrame(() => {
    const { ball, phase } = useStore.getState();
    if (phase !== "PLAYING") return;

    const spd  = Math.sqrt(ball.vx ** 2 + ball.vz ** 2);
    const spdN = Math.min(spd / MAX_SPEED, 1);

    if (meshRef.current) {
      meshRef.current.position.set(ball.x, BALL_R, ball.z);
      meshRef.current.material.emissiveIntensity = 0.22 + spdN * 0.7;
    }
    if (lightRef.current) {
      lightRef.current.position.set(ball.x, BALL_R + 0.3, ball.z);
      lightRef.current.intensity = 0.9 + spdN * 1.8;
    }

    // Trail
    const hist = histRef.current;
    hist.push({ x: ball.x, z: ball.z, s: spd });
    if (hist.length > TRAIL_LEN) hist.shift();

    trailRef.current.forEach((r, i) => {
      const m = r.current;
      if (!m) return;
      if (i >= hist.length) { m.visible = false; return; }
      const h   = hist[i];
      const age = i / hist.length;
      m.visible = true;
      m.position.set(h.x, 0.06, h.z);
      m.scale.setScalar(BALL_R * (0.2 + 0.8 * age));
      _trailColor.setHSL(h.s > 13 ? 0.5 : 0.45, 0.08, 0.62);
      m.material.color.copy(_trailColor);
      m.material.opacity = age * 0.5;
    });
  });

  return (
    <group>
      {Array.from({ length: TRAIL_LEN }).map((_, i) => (
        <mesh key={i} ref={trailRef.current[i]} visible={false}>
          <sphereGeometry args={[BALL_R, 6, 6]} />
          <meshBasicMaterial transparent opacity={0} />
        </mesh>
      ))}
      <mesh ref={meshRef} castShadow>
        <sphereGeometry args={[BALL_R, 32, 32]} />
        <meshStandardMaterial color="#E8E8FF" emissive="#8899FF" emissiveIntensity={0.3} metalness={0.95} roughness={0.05} envMapIntensity={2} />
      </mesh>
      <pointLight ref={lightRef} color="#aabbff" intensity={1.5} distance={3} decay={2} />
    </group>
  );
}

// ─── Pole ─────────────────────────────────────────────────────────────────────
const CA3 = new THREE.Color(UI.attract);
const CR3 = new THREE.Color(UI.repel);
const CI_P1  = new THREE.Color("#1A2624");
const CI_BOT = new THREE.Color("#26201C");

function Pole({ side }) {
  const meshRef  = useRef();
  const lightRef = useRef();
  const ringRef  = useRef();
  const emRef    = useRef(new THREE.Color());
  const isP1     = side === "p1";

  useFrame((_, dt) => {
    const pole = isP1 ? useStore.getState().p1 : useStore.getState().bot;
    const active  = pole.mode !== "NONE";
    const attract = pole.mode === "ATTRACT";
    emRef.current.lerp(active ? (attract ? CA3 : CR3) : (isP1 ? CI_P1 : CI_BOT), Math.min(1, dt * 12));

    if (meshRef.current) {
      meshRef.current.position.set(pole.x, POLE_R * 0.5, pole.z);
      meshRef.current.material.emissive.copy(emRef.current);
      meshRef.current.material.emissiveIntensity = active ? 1.1 : 0.1;
    }
    if (lightRef.current) {
      lightRef.current.position.set(pole.x, 1.0, pole.z);
      lightRef.current.color.copy(active ? (attract ? CA3 : CR3) : new THREE.Color(0, 0, 0));
      lightRef.current.intensity = active ? 3.2 : 0;
    }
    if (ringRef.current) {
      const pulse = active ? 1 + 0.3 * Math.sin(Date.now() * 0.006) : 0;
      ringRef.current.scale.setScalar(Math.max(pulse, 0.001));
      ringRef.current.material.opacity = active ? 0.32 : 0;
      ringRef.current.material.color.copy(attract ? CA3 : CR3);
    }
  });

  return (
    <group>
      <mesh ref={meshRef} castShadow position={[isP1 ? -5.5 : 5.5, POLE_R * 0.5, 0]}>
        <cylinderGeometry args={[POLE_R, POLE_R * 0.85, POLE_R, 32]} />
        <meshStandardMaterial
          color={isP1 ? "#1E2A28" : "#2A2420"}
          emissive={isP1 ? "#1A2624" : "#26201C"}
          emissiveIntensity={0.12} metalness={0.75} roughness={0.3}
        />
      </mesh>
      <mesh ref={ringRef} position={[isP1 ? -5.5 : 5.5, POLE_R + 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[POLE_R * 0.6, POLE_R * 2, 32]} />
        <meshBasicMaterial transparent opacity={0} color="#00FFFF" side={THREE.DoubleSide} />
      </mesh>
      <pointLight ref={lightRef} intensity={0} distance={5} decay={2} />
    </group>
  );
}

// ─── Ghost poles ──────────────────────────────────────────────────────────────
function GhostPoles() {
  const refs   = useRef([]);
  const lights = useRef([]);
  const count  = 3;

  useFrame(({ clock }) => {
    const { ghosts, phase } = useStore.getState();
    if (phase !== "PLAYING") return;
    const t = clock.elapsedTime;
    ghosts.forEach((g, i) => {
      const gr = refs.current[i];
      const lr = lights.current[i];
      if (!gr) return;
      if (g.mode === "NONE") { gr.visible = false; if (lr) lr.intensity = 0; return; }
      gr.visible = true;
      gr.position.set(g.x, 0.35, g.z);
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.8 + g.x * 3);
      const col   = g.mode === "ATTRACT" ? CA3 : CR3;
      gr.rotation.y = t * (g.mode === "ATTRACT" ? 0.8 : -0.8);
      gr.rotation.x = Math.sin(t * 0.4 + i) * 0.3;
      gr.children.forEach(c => {
        if (c.isMesh) {
          c.material.color.copy(col);
          c.material.emissive.copy(col);
          c.material.emissiveIntensity = 0.2 + pulse * 0.4;
          c.material.opacity = 0.25 + pulse * 0.35;
        }
      });
      if (lr) { lr.position.set(g.x, 0.5, g.z); lr.color.copy(col); lr.intensity = 0.25 + pulse * 0.5; }
    });
  });

  return (
    <group>
      {Array.from({ length: count }).map((_, i) => (
        <group key={i} ref={el => refs.current[i] = el} visible={false}>
          <mesh>
            <torusGeometry args={[POLE_R * 0.9, 0.05, 8, 32]} />
            <meshStandardMaterial color={UI.attract} emissive={UI.attract} emissiveIntensity={0.5} transparent opacity={0.38} />
          </mesh>
          <mesh>
            <torusGeometry args={[POLE_R * 1.7, 0.03, 8, 32]} />
            <meshStandardMaterial color={UI.attract} emissive={UI.attract} emissiveIntensity={0.3} transparent opacity={0.22} />
          </mesh>
          <mesh>
            <sphereGeometry args={[0.06, 8, 8]} />
            <meshStandardMaterial color={UI.bone} emissive={UI.bone} emissiveIntensity={0.9} transparent opacity={0.6} />
          </mesh>
        </group>
      ))}
      {Array.from({ length: count }).map((_, i) => (
        <pointLight key={i} ref={el => lights.current[i] = el} intensity={0} distance={3} decay={2} />
      ))}
    </group>
  );
}

// ─── Vector field ─────────────────────────────────────────────────────────────
const dummy    = new THREE.Object3D();
const fieldCol = new THREE.Color();

function buildArrow() {
  const shaft = new THREE.CylinderGeometry(0.022, 0.022, 0.28, 5);
  shaft.translate(0, 0.14, 0);
  const head = new THREE.ConeGeometry(0.058, 0.12, 5);
  head.translate(0, 0.34, 0);
  const pos = [], nor = [];
  for (const g of [shaft, head]) {
    const p = g.attributes.position.array;
    const n = g.attributes.normal?.array || [];
    for (let i = 0; i < p.length; i++) pos.push(p[i]);
    for (let i = 0; i < n.length; i++) nor.push(n[i]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  if (nor.length) geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  return geo;
}

function VectorField() {
  const meshRef = useRef();
  const geoRef  = useRef();
  if (!geoRef.current) geoRef.current = buildArrow();

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const { p1, bot, ghosts, phase } = useStore.getState();
    if (phase !== "PLAYING") return;

    for (let i = 0; i < FIELD_COUNT; i++) {
      const wx = fieldX[i], wz = fieldZ[i];
      const pt = { x: wx, z: wz };
      const fp = magForce(p1, pt, p1.mode);
      const fb = magForce(bot, pt, bot.mode);
      const fg = ghosts.reduce((a, g) => { const f = ghostF(g, pt); return { fx: a.fx + f.fx, fz: a.fz + f.fz }; }, { fx: 0, fz: 0 });
      const fx = fp.fx + fb.fx + fg.fx;
      const fz = fp.fz + fb.fz + fg.fz;
      const mag = Math.sqrt(fx * fx + fz * fz);

      dummy.position.set(wx, 0.02, wz);
      if (mag < 0.04) { dummy.scale.setScalar(0.001); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix); continue; }
      dummy.rotation.set(0, Math.atan2(fx, fz), 0);
      dummy.scale.set(1, clamp(mag * 0.26, 0.1, 1.3), 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      const hA = p1.mode === "ATTRACT" || bot.mode === "ATTRACT" || ghosts.some(g => g.mode === "ATTRACT");
      const hR = p1.mode === "REPEL"   || bot.mode === "REPEL"   || ghosts.some(g => g.mode === "REPEL");
      const alpha = clamp(mag * 0.07, 0.05, 0.8);
      if (hA && hR) fieldCol.setHSL(0.5, 0.12, 0.55);
      else if (hA)  fieldCol.set(UI.attract);
      else if (hR)  fieldCol.set(UI.repel);
      else          fieldCol.setHSL(0.5, 0.06, 0.22);
      fieldCol.multiplyScalar(alpha * 1.6);
      mesh.setColorAt(i, fieldCol);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[geoRef.current, undefined, FIELD_COUNT]}>
      <meshBasicMaterial vertexColors />
    </instancedMesh>
  );
}

// --- HUD ----------------------------------------------------------------------
const mc = m => m === "ATTRACT" ? UI.attract : m === "REPEL" ? UI.repel : UI.hazeDim;
const ml = m => m === "ATTRACT" ? "ATTRACT" : m === "REPEL" ? "REPEL" : "STANDBY";
const pad2 = n => String(n).padStart(2, "0");

function ModeDot({ mode }) {
  const active = mode !== "NONE";
  const color  = mc(mode);
  return (
    <div style={{ display:"flex", alignItems:"center", gap:5 }}>
      <div style={{
        width:5, height:5, borderRadius:"50%",
        background: active ? color : UI.silt,
        boxShadow: active ? `0 0 6px ${color}, 0 0 1px ${color}` : "none",
        transition:"all 0.15s",
      }} />
      <span style={{
        color: active ? color : UI.ghost,
        fontSize:7, letterSpacing:"0.2em",
        fontFamily:"'Courier New',monospace",
        transition:"color 0.15s",
      }}>{ml(mode)}</span>
    </div>
  );
}

function HUD() {
  const score    = useStore(s => s.score);
  const p1Mode   = useStore(s => s.p1.mode);
  const botMode  = useStore(s => s.bot.mode);
  const gameMode = useStore(s => s.gameMode);
  return (
    <div style={{ position:"fixed", inset:0, pointerEvents:"none", fontFamily:"'Courier New',monospace", zIndex:10 }}>
      <div style={{
        display:"flex", justifyContent:"space-between", alignItems:"center",
        padding:"7px 14px",
        background:`linear-gradient(180deg, ${UI.depth1}E8 0%, ${UI.void}D0 100%)`,
        borderBottom:`1px solid ${UI.silt}`,
        boxShadow:`inset 0 -1px 0 rgba(0,0,0,0.4)`,
        position:"relative",
      }}>
        <div style={{ display:"flex", flexDirection:"column", gap:3, minWidth:78 }}>
          <span style={{ color:UI.hazeDim, fontSize:7, letterSpacing:"0.25em", opacity:0.8 }}>PLAYER_1</span>
          <span style={{
            color:UI.bone, fontSize:22, fontWeight:"bold", lineHeight:1,
            letterSpacing:"0.03em",
            textShadow:`0 0 14px ${UI.attract}55, 0 1px 0 rgba(0,0,0,0.6)`,
          }}>{pad2(score.p1)}</span>
          <ModeDot mode={p1Mode} />
        </div>

        <div style={{ textAlign:"center" }}>
          <div style={{ color:UI.haze, fontSize:10, letterSpacing:"0.35em", fontWeight:"bold" }}>MAG&middot;PHYS</div>
          <div style={{ color:UI.ghost, fontSize:7, letterSpacing:"0.2em", marginTop:2 }}>
            {gameMode==="2P"?"LOCAL 2P":"VS BOT"} &middot; 3D
          </div>
        </div>

        <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:3, minWidth:78 }}>
          <span style={{ color:UI.hazeDim, fontSize:7, letterSpacing:"0.25em", opacity:0.8 }}>
            {gameMode==="2P"?"PLAYER_2":"SYS_BOT"}
          </span>
          <span style={{
            color:UI.bone, fontSize:22, fontWeight:"bold", lineHeight:1,
            letterSpacing:"0.03em",
            textShadow:`0 0 14px ${UI.repel}55, 0 1px 0 rgba(0,0,0,0.6)`,
          }}>{pad2(score.bot)}</span>
          <ModeDot mode={botMode} />
        </div>
      </div>
    </div>
  );
}

// --- Controls -------------------------------------------------------------------
function SwitchButton({ label, color, onPress, onRelease }) {
  const [pressed, setPressed] = useState(false);
  return (
    <button
      onPointerDown={() => { setPressed(true);  onPress(); }}
      onPointerUp={()   => { setPressed(false); onRelease(); }}
      onPointerLeave={() => { setPressed(false); onRelease(); }}
      style={{
        flex:1, padding:"11px 0",
        background: pressed
          ? `linear-gradient(180deg, ${color}1A 0%, ${color}28 100%)`
          : `linear-gradient(180deg, ${UI.depth2} 0%, ${UI.depth1} 100%)`,
        border:`1px solid ${pressed ? color : UI.silt}`,
        borderBottom: pressed ? `1px solid ${color}99` : `3px solid ${UI.void}`,
        borderRadius:2,
        color: pressed ? color : UI.hazeDim,
        fontSize:9, letterSpacing:"0.2em",
        fontFamily:"'Courier New',monospace",
        cursor:"pointer", touchAction:"none", userSelect:"none",
        transform: pressed ? "translateY(2px)" : "translateY(0)",
        boxShadow: pressed
          ? `inset 0 2px 5px rgba(0,0,0,0.5)`
          : `0 2px 0 ${UI.void}`,
        transition:"transform 0.05s, box-shadow 0.05s, border-color 0.1s, color 0.1s",
      }}
    >{label}</button>
  );
}

function SliderRail({ value, onChange, color, label }) {
  const pct = (value + 1) / 2 * 100;
  return (
    <div style={{ display:"flex", alignItems:"center", gap:9, flex:1 }}>
      <span style={{ color:UI.hazeDim, fontSize:7, letterSpacing:"0.25em", whiteSpace:"nowrap" }}>{label}</span>
      <div style={{
        flex:1, height:2, position:"relative", borderRadius:1,
        background:`linear-gradient(90deg, ${color}40 0%, ${color}65 ${pct}%, ${UI.silt} ${pct}%)`,
      }}>
        <input type="range" min="-100" max="100" value={Math.round(value*100)}
          onChange={e => onChange(parseInt(e.target.value)/100)}
          style={{ position:"absolute", inset:"-9px 0", opacity:0, cursor:"pointer", width:"100%", height:"calc(100% + 18px)" }}
        />
        <div style={{
          position:"absolute", left:`${pct}%`, top:"50%", transform:"translate(-50%,-50%)",
          width:9, height:15,
          background:`linear-gradient(180deg, ${color}BB 0%, ${color}55 100%)`,
          border:`1px solid ${color}`, borderRadius:1,
          pointerEvents:"none",
        }} />
      </div>
    </div>
  );
}

function Controls({ keysRef, s1Ref, s2Ref }) {
  const [sv1, setSv1] = useState(0);
  const [sv2, setSv2] = useState(0);
  const gameMode = useStore(s => s.gameMode);
  const press   = k => { keysRef.current[k] = true; };
  const release = k => { keysRef.current[k] = false; };

  return (
    <div style={{
      position:"fixed", bottom:0, left:0, right:0,
      background:`linear-gradient(180deg, ${UI.depth1}E8 0%, ${UI.void}F2 100%)`,
      backdropFilter:"blur(10px)",
      borderTop:`1px solid ${UI.silt}`,
      boxShadow:"inset 0 1px 0 rgba(255,255,255,0.02)",
      padding:"7px 11px 11px", display:"flex",
      flexDirection: gameMode==="2P" ? "row" : "column",
      gap:8, zIndex:20, fontFamily:"'Courier New',monospace",
    }}>
      <div style={{ flex:1, display:"flex", flexDirection:"column", gap:6,
        borderRight: gameMode==="2P" ? `1px solid ${UI.silt}` : "none",
        paddingRight: gameMode==="2P" ? 11 : 0 }}>
        <SliderRail value={sv1} onChange={v=>{setSv1(v);s1Ref.current=v;}} color={UI.attract} label="P1 &middot; Z" />
        <div style={{ display:"flex", gap:8 }}>
          <SwitchButton label="&minus; ATTRACT" color={UI.attract} onPress={()=>press("q")} onRelease={()=>release("q")} />
          <SwitchButton label="+ REPEL"   color={UI.repel}   onPress={()=>press("a")} onRelease={()=>release("a")} />
        </div>
      </div>
      {gameMode==="2P" && (
        <div style={{ flex:1, display:"flex", flexDirection:"column", gap:6, paddingLeft:11 }}>
          <SliderRail value={sv2} onChange={v=>{setSv2(v);s2Ref.current=v;}} color={UI.repel} label="P2 &middot; Z" />
          <div style={{ display:"flex", gap:8 }}>
            <SwitchButton label="&minus; ATTRACT" color={UI.attract} onPress={()=>press("o")} onRelease={()=>release("o")} />
            <SwitchButton label="+ REPEL"   color={UI.repel}   onPress={()=>press("p")} onRelease={()=>release("p")} />
          </div>
        </div>
      )}
    </div>
  );
}

// --- Overlays ---------------------------------------------------------------------
function MenuOverlay() {
  const { startGame, gameMode } = useStore(s => ({ startGame:s.startGame, gameMode:s.gameMode }));
  return (
    <div style={{
      position:"fixed", inset:0, zIndex:30,
      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
      background: UI.void,
      fontFamily:"'Courier New',monospace",
    }}>
      <div style={{ color:UI.ghost, fontSize:9, letterSpacing:"0.45em", marginBottom:7 }}>MAGNETIC ARCADE</div>
      <div style={{
        color:UI.bone, fontSize:30, fontWeight:"bold", letterSpacing:"0.3em", marginBottom:5,
        animation:"titlePulse 4s ease-in-out infinite",
      }}>MAG&middot;PHYS</div>
      <div style={{ color:UI.hazeDim, fontSize:9, letterSpacing:"0.3em", marginBottom:30 }}>3D SIMULATOR</div>

      <div style={{ display:"flex", gap:14, marginBottom:24 }}>
        <SwitchButton label="VS BOT"   color={UI.attract} onPress={()=>{}} onRelease={()=>startGame("BOT")} />
        <SwitchButton label="LOCAL 2P" color={UI.repel}   onPress={()=>{}} onRelease={()=>startGame("2P")} />
      </div>

      <div style={{ color:UI.ghost, fontSize:9, lineHeight:2, textAlign:"center", marginBottom:5 }}>
        {gameMode==="BOT"
          ? <>W/S move &middot; Q attract &middot; A repel</>
          : <>W/S &middot; Q/A &nbsp; P1 | P2 &nbsp; &uarr;/&darr; &middot; O/P</>
        }
      </div>
      <div style={{ color:UI.ghost, fontSize:8, opacity:0.6 }}>FIRST TO {SCORE_LIMIT}</div>
    </div>
  );
}

function GameOverOverlay() {
  const { score, winner, gameMode, startGame, setPhase } = useStore(s => ({
    score:s.score, winner:s.winner, gameMode:s.gameMode, startGame:s.startGame, setPhase:s.setPhase,
  }));
  const wc = winner==="PLAYER" ? UI.attract : UI.repel;
  const wl = winner==="PLAYER" ? "PLAYER 1" : gameMode==="2P" ? "PLAYER 2" : "SYS&middot;BOT";
  return (
    <div style={{
      position:"fixed", inset:0, zIndex:30,
      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
      background: UI.void,
      boxShadow:`inset 0 0 160px ${wc}18`,
      fontFamily:"'Courier New',monospace",
    }}>
      <div style={{ color:UI.ghost, fontSize:9, letterSpacing:"0.35em", marginBottom:16 }}>MATCH COMPLETE</div>
      <div style={{
        color:wc, fontSize:30, fontWeight:"bold", letterSpacing:"0.18em", marginBottom:7,
        textShadow:`0 0 24px ${wc}55`,
      }} dangerouslySetInnerHTML={{ __html: wl }} />
      <div style={{ color:UI.hazeDim, fontSize:9, letterSpacing:"0.25em", marginBottom:10 }}>FIELD DOMINANCE</div>
      <div style={{ fontSize:24, marginBottom:30, letterSpacing:"0.05em" }}>
        <span style={{ color:UI.attract }}>{String(score.p1).padStart(2,"0")}</span>
        <span style={{ color:UI.ghost, margin:"0 12px" }}>:</span>
        <span style={{ color:UI.repel }}>{String(score.bot).padStart(2,"0")}</span>
      </div>
      <div style={{ display:"flex", gap:14 }}>
        <SwitchButton label="REMATCH" color={UI.attract} onPress={()=>{}} onRelease={()=>startGame(gameMode)} />
        <SwitchButton label="MENU"    color={UI.hazeDim} onPress={()=>{}} onRelease={()=>setPhase("MENU")} />
      </div>
    </div>
  );
}

// ─── Scene (inside Canvas) ────────────────────────────────────────────────────
function Scene({ keysRef, s1Ref, s2Ref, modeRef }) {
  const phase = useStore(s => s.phase);
  return (
    <>
      <CameraRig />
      <PhysicsController keysRef={keysRef} s1Ref={s1Ref} s2Ref={s2Ref} modeRef={modeRef} />
      <ambientLight intensity={0.12} />
      <pointLight position={[0, 7, 0]} intensity={0.5} color="#ffffff" decay={2} />
      <Environment preset="night" />
      <Arena />
      {phase === "PLAYING" && <>
        <Ball />
        <Pole side="p1" />
        <Pole side="bot" />
        <GhostPoles />
        <VectorField />
      </>}
      <EffectComposer>
        <Bloom intensity={0.6} luminanceThreshold={0.42} luminanceSmoothing={0.95} mipmapBlur />
      </EffectComposer>
    </>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function MagPhys3D() {
  const phase    = useStore(s => s.phase);
  const gameMode = useStore(s => s.gameMode);
  const keysRef  = useRef({});
  const s1Ref    = useRef(0);
  const s2Ref    = useRef(0);
  const modeRef  = useRef("BOT");

  useEffect(() => { modeRef.current = gameMode; }, [gameMode]);

  useEffect(() => {
    const dn = e => { keysRef.current[e.key] = true;  if (["ArrowUp","ArrowDown"," "].includes(e.key)) e.preventDefault(); };
    const up = e => { keysRef.current[e.key] = false; };
    window.addEventListener("keydown", dn);
    window.addEventListener("keyup",   up);
    return () => { window.removeEventListener("keydown", dn); window.removeEventListener("keyup", up); };
  }, []);

  return (
    <div style={{ position:"fixed", inset:0, width:"100%", height:"100dvh", background:UI.void, overflow:"hidden" }}>
      <Canvas
        camera={{ position:[0, 8, 2.5], fov:60, near:0.1, far:100 }}
        gl={{ antialias:true, alpha:false, powerPreference:"high-performance" }}
        shadows
        style={{ position:"absolute", inset:0 }}
      >
        <Scene keysRef={keysRef} s1Ref={s1Ref} s2Ref={s2Ref} modeRef={modeRef} />
      </Canvas>

      {phase === "PLAYING"  && <HUD />}
      {phase === "PLAYING"  && <Controls keysRef={keysRef} s1Ref={s1Ref} s2Ref={s2Ref} />}
      {phase === "MENU"     && <MenuOverlay />}
      {phase === "GAMEOVER" && <GameOverOverlay />}

      {/* Heavy vignette -- murky underwater falloff toward all edges */}
      <div style={{
        position:"fixed", inset:0, zIndex:90, pointerEvents:"none",
        background:"radial-gradient(ellipse at 50% 50%, transparent 32%, rgba(6,8,9,0.55) 78%, rgba(4,5,6,0.88) 100%)",
      }} />

      {/* Deep film grain -- animated noise texture */}
      <div style={{
        position:"fixed", inset:0, zIndex:91, pointerEvents:"none",
        opacity:0.1, mixBlendMode:"overlay",
        backgroundImage:`url('data:image/svg+xml,%3Csvg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"%3E%3Cfilter id="n"%3E%3CfeTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="4" stitchTiles="stitch"/%3E%3C/filter%3E%3Crect width="100%25" height="100%25" filter="url(%23n)"/%3E%3C/svg%3E')`,
        animation:"grainShift 0.6s steps(4) infinite",
      }} />

      {/* Soft chromatic haze -- low-contrast murk over everything */}
      <div style={{
        position:"fixed", inset:0, zIndex:89, pointerEvents:"none",
        background:`linear-gradient(180deg, ${UI.void}22 0%, transparent 18%, transparent 82%, ${UI.void}30 100%)`,
      }} />

      <style>{`
        *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
        html, body { overflow:hidden; height:100%; touch-action:none; background:${UI.void}; }
        input[type=range] { height:4px; cursor:pointer; }
        input[type=range]::-webkit-slider-thumb { width:20px; height:20px; border-radius:50%; }
        button:active { opacity:0.7; }
        canvas { display:block; }
        @keyframes titlePulse {
          0%, 100% { text-shadow: 0 0 18px ${UI.attract}33; }
          50%       { text-shadow: 0 0 34px ${UI.attract}55, 0 0 60px ${UI.attract}18; }
        }
        @keyframes grainShift {
          0%   { transform: translate(0,0); }
          25%  { transform: translate(-1%,1%); }
          50%  { transform: translate(1%,-1%); }
          75%  { transform: translate(-1%,-1%); }
          100% { transform: translate(0,0); }
        }
      `}</style>
    </div>
  );
}
