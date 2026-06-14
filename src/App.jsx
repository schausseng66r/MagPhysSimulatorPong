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
          <meshStandardMaterial color="#1A2535" metalness={0.6} roughness={0.4} emissive="#00FFFF" emissiveIntensity={0.05} />
        </mesh>
      ))}

      {/* Right wall segments */}
      {[1, -1].map(s => (
        <mesh key={s} position={[(hW + 0.09), 0.2, s * (hH / 2 + gH / 2)]}>
          <boxGeometry args={[0.18, 0.4, seg]} />
          <meshStandardMaterial color="#1A2535" metalness={0.6} roughness={0.4} emissive="#FF00FF" emissiveIntensity={0.05} />
        </mesh>
      ))}

      {/* Center line */}
      <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.03, ARENA_H]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.07} />
      </mesh>

      {/* Goal lights */}
      <pointLight position={[-hW - 0.5, 0.5, 0]} color="#00FFFF" intensity={2 + goalFlash * 6} distance={4} decay={2} />
      <pointLight position={[ hW + 0.5, 0.5, 0]} color="#FF00FF" intensity={2 + goalFlash * 6} distance={4} decay={2} />
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
      meshRef.current.material.emissiveIntensity = 0.3 + spdN * 1.4;
    }
    if (lightRef.current) {
      lightRef.current.position.set(ball.x, BALL_R + 0.3, ball.z);
      lightRef.current.intensity = 1.5 + spdN * 4;
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
      _trailColor.setHSL(h.s > 13 ? 0.83 : 0.53, 1, 0.65);
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
const CA3 = new THREE.Color(C_ATTRACT);
const CR3 = new THREE.Color(C_REPEL);
const CI_P1  = new THREE.Color("#003344");
const CI_BOT = new THREE.Color("#330033");

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
      meshRef.current.material.emissiveIntensity = active ? 2.8 : 0.12;
    }
    if (lightRef.current) {
      lightRef.current.position.set(pole.x, 1.0, pole.z);
      lightRef.current.color.copy(active ? (attract ? CA3 : CR3) : new THREE.Color(0, 0, 0));
      lightRef.current.intensity = active ? 9 : 0;
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
          color={isP1 ? "#004455" : "#440033"}
          emissive={isP1 ? "#003344" : "#330033"}
          emissiveIntensity={0.12} metalness={0.9} roughness={0.1}
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
          c.material.emissiveIntensity = 0.4 + pulse * 0.8;
          c.material.opacity = 0.25 + pulse * 0.35;
        }
      });
      if (lr) { lr.position.set(g.x, 0.5, g.z); lr.color.copy(col); lr.intensity = 0.5 + pulse; }
    });
  });

  return (
    <group>
      {Array.from({ length: count }).map((_, i) => (
        <group key={i} ref={el => refs.current[i] = el} visible={false}>
          <mesh>
            <torusGeometry args={[POLE_R * 0.9, 0.05, 8, 32]} />
            <meshStandardMaterial color="#00FFFF" emissive="#00FFFF" emissiveIntensity={1} transparent opacity={0.5} />
          </mesh>
          <mesh>
            <torusGeometry args={[POLE_R * 1.7, 0.03, 8, 32]} />
            <meshStandardMaterial color="#00FFFF" emissive="#00FFFF" emissiveIntensity={0.6} transparent opacity={0.3} />
          </mesh>
          <mesh>
            <sphereGeometry args={[0.06, 8, 8]} />
            <meshStandardMaterial color="#fff" emissive="#fff" emissiveIntensity={2} transparent opacity={0.8} />
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
      if (hA && hR) fieldCol.setHSL(0.75, 1, 0.5);
      else if (hA)  fieldCol.set(C_ATTRACT);
      else if (hR)  fieldCol.set(C_REPEL);
      else          fieldCol.setHSL(0.6, 0.4, 0.15);
      fieldCol.multiplyScalar(alpha * 2.2);
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

// ─── HUD ──────────────────────────────────────────────────────────────────────
const mc = m => m === "ATTRACT" ? C_ATTRACT : m === "REPEL" ? C_REPEL : "rgba(255,255,255,0.22)";
const ml = m => m === "ATTRACT" ? "ATTRACT" : m === "REPEL" ? "REPEL" : "STANDBY";

function HUD() {
  const score    = useStore(s => s.score);
  const p1Mode   = useStore(s => s.p1.mode);
  const botMode  = useStore(s => s.bot.mode);
  const gameMode = useStore(s => s.gameMode);
  return (
    <div style={{ position:"fixed", inset:0, pointerEvents:"none", fontFamily:"'Courier New',monospace", zIndex:10 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"5px 12px", background:"rgba(0,0,0,0.55)", borderBottom:"1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ display:"flex", flexDirection:"column", gap:2, minWidth:80 }}>
          <span style={{ color:C_ATTRACT, fontSize:8, letterSpacing:3, opacity:0.7 }}>PLAYER_1</span>
          <span style={{ color:C_ATTRACT, fontSize:18, fontWeight:"bold", lineHeight:1 }}>{score.p1}</span>
          <span style={{ color:mc(p1Mode), fontSize:7, letterSpacing:2, padding:"1px 4px", border:`1px solid ${mc(p1Mode)}`, display:"inline-block", opacity:p1Mode!=="NONE"?1:0.3 }}>{ml(p1Mode)}</span>
        </div>
        <div style={{ textAlign:"center" }}>
          <div style={{ color:"rgba(255,255,255,0.85)", fontSize:11, letterSpacing:5, fontWeight:"bold" }}>MAG·PHYS</div>
          <div style={{ color:"rgba(255,255,255,0.2)", fontSize:7, letterSpacing:3, marginTop:1 }}>{gameMode==="2P"?"LOCAL 2P":"VS BOT"} · 3D</div>
        </div>
        <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:2, minWidth:80 }}>
          <span style={{ color:C_REPEL, fontSize:8, letterSpacing:3, opacity:0.7 }}>{gameMode==="2P"?"PLAYER_2":"SYS_BOT"}</span>
          <span style={{ color:C_REPEL, fontSize:18, fontWeight:"bold", lineHeight:1 }}>{score.bot}</span>
          <span style={{ color:mc(botMode), fontSize:7, letterSpacing:2, padding:"1px 4px", border:`1px solid ${mc(botMode)}`, display:"inline-block", opacity:botMode!=="NONE"?1:0.3 }}>{ml(botMode)}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Controls ─────────────────────────────────────────────────────────────────
function Controls({ keysRef, s1Ref, s2Ref }) {
  const [sv1, setSv1] = useState(0);
  const [sv2, setSv2] = useState(0);
  const gameMode = useStore(s => s.gameMode);
  const press   = k => { keysRef.current[k] = true; };
  const release = k => { keysRef.current[k] = false; };
  const btn = (label, color, k) => (
    <button
      onPointerDown={() => press(k)} onPointerUp={() => release(k)} onPointerLeave={() => release(k)}
      style={{ flex:1, padding:"10px 0", background:color===C_ATTRACT?"rgba(0,255,255,0.07)":"rgba(255,0,255,0.07)", border:`1px solid ${color}`, color, fontSize:9, letterSpacing:2, fontFamily:"'Courier New',monospace", cursor:"pointer", touchAction:"none", userSelect:"none" }}
    >{label}</button>
  );
  return (
    <div style={{ position:"fixed", bottom:0, left:0, right:0, background:"rgba(0,0,0,0.78)", backdropFilter:"blur(12px)", borderTop:"1px solid rgba(255,255,255,0.06)", padding:"6px 10px 10px", display:"flex", flexDirection:gameMode==="2P"?"row":"column", gap:8, zIndex:20, fontFamily:"'Courier New',monospace" }}>
      {/* P1 */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", gap:6, borderRight:gameMode==="2P"?"1px solid rgba(255,255,255,0.07)":"none", paddingRight:gameMode==="2P"?10:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ color:C_ATTRACT, fontSize:7, letterSpacing:3, opacity:0.7, whiteSpace:"nowrap" }}>P1 · Z</span>
          <input type="range" min="-100" max="100" value={Math.round(sv1*100)} onChange={e=>{const v=parseInt(e.target.value)/100;setSv1(v);s1Ref.current=v;}} style={{ flex:1, accentColor:C_ATTRACT }} />
        </div>
        <div style={{ display:"flex", gap:8 }}>
          {btn("− ATTRACT", C_ATTRACT, "q")}
          {btn("+ REPEL",   C_REPEL,   "a")}
        </div>
      </div>
      {/* P2 */}
      {gameMode==="2P" && (
        <div style={{ flex:1, display:"flex", flexDirection:"column", gap:6, paddingLeft:10 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ color:C_REPEL, fontSize:7, letterSpacing:3, opacity:0.7, whiteSpace:"nowrap" }}>P2 · Z</span>
            <input type="range" min="-100" max="100" value={Math.round(sv2*100)} onChange={e=>{const v=parseInt(e.target.value)/100;setSv2(v);s2Ref.current=v;}} style={{ flex:1, accentColor:C_REPEL }} />
          </div>
          <div style={{ display:"flex", gap:8 }}>
            {btn("− ATTRACT", C_ATTRACT, "o")}
            {btn("+ REPEL",   C_REPEL,   "p")}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Overlays ─────────────────────────────────────────────────────────────────
function MenuOverlay() {
  const { startGame, gameMode, setGameMode } = useStore(s => ({ startGame:s.startGame, gameMode:s.gameMode, setGameMode:s.setGameMode }));
  const mbtn = (label, mode, color) => (
    <button onClick={() => startGame(mode)}
      style={{ background:gameMode===mode?color+"22":"transparent", border:`1px solid ${gameMode===mode?color:"rgba(255,255,255,0.2)"}`, color:gameMode===mode?color:"rgba(255,255,255,0.4)", padding:"10px 26px", fontSize:11, letterSpacing:3, cursor:"pointer", fontFamily:"'Courier New',monospace" }}
      onMouseEnter={()=>setGameMode(mode)}
    >{label}</button>
  );
  return (
    <div style={{ position:"fixed", inset:0, zIndex:30, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", background:"rgba(2,5,9,0.92)", fontFamily:"'Courier New',monospace" }}>
      <div style={{ color:"rgba(0,255,255,0.4)", fontSize:9, letterSpacing:8, marginBottom:6 }}>MAGNETIC ARCADE</div>
      <div style={{ color:"#fff", fontSize:30, fontWeight:"bold", letterSpacing:8, marginBottom:4, textShadow:`0 0 30px ${C_ATTRACT}` }}>MAG·PHYS</div>
      <div style={{ color:"rgba(255,255,255,0.2)", fontSize:9, letterSpacing:4, marginBottom:28 }}>3D SIMULATOR</div>
      <div style={{ display:"flex", gap:12, marginBottom:22 }}>
        {mbtn("VS BOT",    "BOT", C_ATTRACT)}
        {mbtn("LOCAL 2P",  "2P",  C_REPEL)}
      </div>
      <div style={{ color:"rgba(255,255,255,0.3)", fontSize:9, lineHeight:2, textAlign:"center", marginBottom:4 }}>
        {gameMode==="BOT"
          ? <><span style={{color:C_ATTRACT}}>W/S</span> move &nbsp;·&nbsp; <span style={{color:C_ATTRACT}}>Q</span> attract &nbsp;·&nbsp; <span style={{color:C_REPEL}}>A</span> repel</>
          : <><span style={{color:C_ATTRACT}}>W/S · Q/A</span> &nbsp; P1 &nbsp;|&nbsp; P2 &nbsp; <span style={{color:C_REPEL}}>↑/↓ · O/P</span></>
        }
      </div>
      <div style={{ color:"rgba(255,255,255,0.18)", fontSize:8 }}>First to {SCORE_LIMIT}</div>
    </div>
  );
}

function GameOverOverlay() {
  const { score, winner, gameMode, startGame, setPhase } = useStore(s => ({ score:s.score, winner:s.winner, gameMode:s.gameMode, startGame:s.startGame, setPhase:s.setPhase }));
  const wc = winner==="PLAYER" ? C_ATTRACT : C_REPEL;
  const wl = winner==="PLAYER" ? "PLAYER 1" : gameMode==="2P" ? "PLAYER 2" : "SYS·BOT";
  return (
    <div style={{ position:"fixed", inset:0, zIndex:30, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", background:"rgba(2,5,9,0.92)", fontFamily:"'Courier New',monospace" }}>
      <div style={{ color:"rgba(255,255,255,0.35)", fontSize:9, letterSpacing:6, marginBottom:14 }}>MATCH COMPLETE</div>
      <div style={{ color:wc, fontSize:26, fontWeight:"bold", letterSpacing:6, marginBottom:6, textShadow:`0 0 24px ${wc}` }}>{wl}</div>
      <div style={{ color:"rgba(255,255,255,0.4)", fontSize:10, letterSpacing:4, marginBottom:8 }}>FIELD DOMINANCE</div>
      <div style={{ fontSize:22, marginBottom:28 }}>
        <span style={{color:C_ATTRACT}}>{score.p1}</span>
        <span style={{color:"rgba(255,255,255,0.15)",margin:"0 10px"}}>:</span>
        <span style={{color:C_REPEL}}>{score.bot}</span>
      </div>
      <div style={{ display:"flex", gap:12 }}>
        <button onClick={()=>startGame(gameMode)} style={{ background:"transparent", border:`1px solid ${C_ATTRACT}`, color:C_ATTRACT, padding:"10px 26px", fontSize:11, letterSpacing:3, cursor:"pointer", fontFamily:"'Courier New',monospace" }}>REMATCH</button>
        <button onClick={()=>setPhase("MENU")}    style={{ background:"transparent", border:"1px solid rgba(255,255,255,0.25)", color:"rgba(255,255,255,0.5)", padding:"10px 26px", fontSize:11, letterSpacing:3, cursor:"pointer", fontFamily:"'Courier New',monospace" }}>MENU</button>
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
        <Bloom intensity={1.4} luminanceThreshold={0.28} luminanceSmoothing={0.85} mipmapBlur />
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
    <div style={{ position:"fixed", inset:0, width:"100%", height:"100dvh", background:"#070B12", overflow:"hidden" }}>
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

      <style>{`
        *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
        html, body { overflow:hidden; height:100%; touch-action:none; background:#070B12; }
        input[type=range] { height:4px; cursor:pointer; }
        input[type=range]::-webkit-slider-thumb { width:20px; height:20px; border-radius:50%; }
        button:active { opacity:0.7; }
        canvas { display:block; }
      `}</style>
    </div>
  );
}
