import { useRef, useEffect, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, Text, Billboard } from "@react-three/drei";
import { EffectComposer, Bloom, ChromaticAberration } from "@react-three/postprocessing";
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
const TRAIL_LEN      = 20;

// Increased density for "Vector Sea"
const FIELD_COLS     = 60;
const FIELD_ROWS     = 40;
const FIELD_COUNT    = FIELD_COLS * FIELD_ROWS;

const C_ATTRACT = "#00FFFF";
const C_REPEL   = "#FF00FF";

// Cyber-Electric Neon-Noir Palette
const UI = {
  void:     "#020406",
  depth1:   "#080E14",
  depth2:   "#101824",
  silt:     "rgba(0,255,255,0.16)",
  siltSoft: "rgba(0,255,255,0.08)",
  haze:     "rgba(255,255,255,0.55)",
  hazeDim:  "rgba(255,255,255,0.30)",
  ghost:    "rgba(255,255,255,0.16)",
  bone:     "#F0F4FF",
  attract:  "#00FFFF",
  repel:    "#FF00FF",
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
const _camPos    = new THREE.Vector3();
const _camLook   = new THREE.Vector3();
const _curPos    = new THREE.Vector3(0, 13, 7);
const _curLook   = new THREE.Vector3(0, 0, 0);

function CameraRig({ modeRef }) {
  const { camera } = useThree();

  useFrame(() => {
    const { cameraShake, p1 } = useStore.getState();
    const mobile = window.innerWidth < 768;
    const mode   = modeRef.current;

    let fov;
    if (mode === "BOT") {
      const followZ = clamp(p1.z * 0.42, -1.7, 1.7);
      _camPos.set(mobile ? -11.2 : -9.6, mobile ? 8.6 : 6.2, followZ);
      _camLook.set(1.6, -0.1, followZ * 0.22);
      fov = mobile ? 85 : 75; // Increased for speed effect
    } else {
      _camPos.set(0, mobile ? 10.2 : 8.4, mobile ? 6.4 : 5.1);
      _camLook.set(0, -0.1, 0);
      fov = mobile ? 80 : 70;
    }

    _curPos.lerp(_camPos, 0.055);
    _curLook.lerp(_camLook, 0.07);

    if (Math.abs(camera.fov - fov) > 0.1) {
      camera.fov += (fov - camera.fov) * 0.05;
      camera.updateProjectionMatrix();
    }

    const sh = cameraShake * 0.13;
    camera.position.set(
      _curPos.x + (Math.random() - 0.5) * sh,
      _curPos.y + (Math.random() - 0.5) * sh * 0.4,
      _curPos.z + (Math.random() - 0.5) * sh * 0.6
    );
    camera.lookAt(_curLook.x, _curLook.y, _curLook.z);
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
        <meshStandardMaterial color="#020406" metalness={0.9} roughness={0.08} />
      </mesh>

      {/* Top / bottom walls */}
      {[1, -1].map(s => (
        <mesh key={s} position={[0, 0.2, s * (hH + 0.09)]}>
          <boxGeometry args={[ARENA_W + 0.36, 0.4, 0.18]} />
          <meshStandardMaterial color="#0A1522" metalness={0.7} roughness={0.3} />
        </mesh>
      ))}

      {/* Left wall segments */}
      {[1, -1].map(s => (
        <mesh key={s} position={[-(hW + 0.09), 0.2, s * (hH / 2 + gH / 2)]}>
          <boxGeometry args={[0.18, 0.4, seg]} />
          <meshStandardMaterial color="#0A1522" metalness={0.7} roughness={0.3} emissive={UI.attract} emissiveIntensity={0.15} />
        </mesh>
      ))}

      {/* Right wall segments */}
      {[1, -1].map(s => (
        <mesh key={s} position={[(hW + 0.09), 0.2, s * (hH / 2 + gH / 2)]}>
          <boxGeometry args={[0.18, 0.4, seg]} />
          <meshStandardMaterial color="#0A1522" metalness={0.7} roughness={0.3} emissive={UI.repel} emissiveIntensity={0.15} />
        </mesh>
      ))}

      {/* Center line */}
      <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.03, ARENA_H]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.05} />
      </mesh>

      {/* Goal lights */}
      <pointLight position={[-hW - 0.5, 0.5, 0]} color={UI.attract} intensity={2.5 + goalFlash * 7} distance={4.5} decay={2} />
      <pointLight position={[ hW + 0.5, 0.5, 0]} color={UI.repel} intensity={2.5 + goalFlash * 7} distance={4.5} decay={2} />
    </group>
  );
}

// ─── Ball & Breadcrumb Trail ──────────────────────────────────────────────────
const _trailColor = new THREE.Color();

function BallTrail() {
  const meshRef = useRef();
  const trailRef = useRef(Array.from({ length: 20 }, () => ({ x: 0, z: 0, spd: 0 })));
  const dummyPlane = new THREE.Object3D();
  
  useFrame(() => {
    const { ball, phase } = useStore.getState();
    const mesh = meshRef.current;
    if (!mesh || phase !== "PLAYING") return;
    
    const tr = trailRef.current;
    for (let i = tr.length - 1; i > 0; i--) {
      tr[i].x = tr[i - 1].x;
      tr[i].z = tr[i - 1].z;
      tr[i].spd = tr[i - 1].spd;
    }
    const spd = Math.sqrt(ball.vx**2 + ball.vz**2);
    tr[0].x = ball.x;
    tr[0].z = ball.z;
    tr[0].spd = spd;
    
    for (let i = 0; i < 20; i++) {
      const p = tr[i];
      dummyPlane.position.set(p.x, BALL_R, p.z);
      const scale = Math.max(0, 1 - i / 20);
      if (i > 0) {
        dummyPlane.rotation.set(-Math.PI/2, 0, Math.atan2(tr[i-1].x - p.x, tr[i-1].z - p.z));
      } else {
        dummyPlane.rotation.set(-Math.PI/2, 0, Math.atan2(ball.vx, ball.vz));
      }
      const sclX = clamp(p.spd * 0.08, 0.3, 1.2) * scale;
      const sclY = clamp(p.spd * 0.08, 0.6, 2.5) * scale;
      dummyPlane.scale.set(sclX, sclY, 1);
      dummyPlane.updateMatrix();
      mesh.setMatrixAt(i, dummyPlane.matrix);
      
      _trailColor.setHSL(p.spd > 13 ? 0.83 : 0.53, 1, 0.68);
      _trailColor.multiplyScalar(scale * 1.5);
      mesh.setColorAt(i, _trailColor);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[null, null, 20]}>
      <planeGeometry args={[0.3, 1]} />
      <meshBasicMaterial vertexColors transparent opacity={0.9} depthWrite={false} blending={THREE.AdditiveBlending} />
    </instancedMesh>
  );
}

function Ball() {
  const meshRef  = useRef();
  const shellRef = useRef();
  const lightRef = useRef();

  useFrame(() => {
    const { ball, phase } = useStore.getState();
    if (phase !== "PLAYING") return;

    const spd  = Math.sqrt(ball.vx ** 2 + ball.vz ** 2);
    const spdN = Math.min(spd / MAX_SPEED, 1);

    if (meshRef.current) {
      meshRef.current.position.set(ball.x, BALL_R, ball.z);
      meshRef.current.material.emissiveIntensity = 0.5 + spdN * 1.5;
    }
    if (shellRef.current) {
      shellRef.current.position.set(ball.x, BALL_R, ball.z);
      shellRef.current.material.opacity = 0.2 + spdN * 0.4;
      shellRef.current.material.color.setHSL(spd > 13 ? 0.83 : 0.53, 1, 0.68);
    }
    if (lightRef.current) {
      lightRef.current.position.set(ball.x, BALL_R + 0.3, ball.z);
      lightRef.current.intensity = 2.0 + spdN * 4;
    }
  });

  return (
    <group>
      <BallTrail />
      <mesh ref={meshRef} castShadow>
        <sphereGeometry args={[BALL_R, 32, 32]} />
        {/* High metalness, zero roughness for hyper-polished look */}
        <meshStandardMaterial color="#E8E8FF" emissive="#8899FF" emissiveIntensity={0.5} metalness={1.0} roughness={0.0} envMapIntensity={3} />
      </mesh>
      <mesh ref={shellRef}>
        <sphereGeometry args={[BALL_R * 1.2, 32, 32]} />
        {/* Fresnel rim fake */}
        <meshStandardMaterial transparent opacity={0.3} blending={THREE.AdditiveBlending} depthWrite={false} emissive={UI.attract} emissiveIntensity={0.5} />
      </mesh>
      <pointLight ref={lightRef} color="#aabbff" intensity={2.0} distance={4} decay={2} />
    </group>
  );
}

// ─── Pole & Magnetic Aura ─────────────────────────────────────────────────────
const CA3 = new THREE.Color(UI.attract);
const CR3 = new THREE.Color(UI.repel);
const CI_P1  = new THREE.Color("#003344");
const CI_BOT = new THREE.Color("#330033");

function MagneticAura({ isP1 }) {
  const groupRef = useRef();
  const ringsRef = useRef([]);

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const t = clock.elapsedTime;
    const pole = isP1 ? useStore.getState().p1 : useStore.getState().bot;
    const active = pole.mode !== "NONE";
    const attract = pole.mode === "ATTRACT";
    
    if (active) {
      groupRef.current.visible = true;
      const jitterX = Math.sin(t * 40) * 0.04;
      const jitterZ = Math.cos(t * 35) * 0.04;
      groupRef.current.position.set(pole.x + jitterX, 0.02, pole.z + jitterZ);
      
      const speed = 7;
      ringsRef.current.forEach((r, i) => {
        if (!r) return;
        // Elastic outward expansion cycle
        const rawPhase = (t * speed * 0.2 + i * 0.33) % 1.0; 
        const scale = 0.5 + Math.pow(rawPhase, 0.4) * 2.8;
        r.scale.setScalar(scale);
        r.material.opacity = (1 - rawPhase) * 0.7;
        r.material.color.copy(attract ? CA3 : CR3);
      });
    } else {
      groupRef.current.visible = false;
    }
  });

  return (
    <group ref={groupRef} visible={false}>
      {[0, 1, 2].map(i => (
        <mesh key={i} ref={el => ringsRef.current[i] = el} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[POLE_R * 0.8, POLE_R * 0.95, 32]} />
          <meshBasicMaterial transparent opacity={0} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} color="#FFFFFF" />
        </mesh>
      ))}
    </group>
  );
}

function Pole({ side, label }) {
  const meshRef    = useRef();
  const lightRef   = useRef();
  const symbolRef  = useRef();
  const labelRef   = useRef();
  const emRef      = useRef(new THREE.Color());
  const isP1       = side === "p1";
  const px         = isP1 ? -5.5 : 5.5;

  const mode    = useStore(s => (isP1 ? s.p1.mode : s.bot.mode));
  const active  = mode !== "NONE";
  const attract = mode === "ATTRACT";
  const symColor = active ? (attract ? UI.attract : UI.repel) : (isP1 ? UI.attract : UI.repel);

  useFrame((_, dt) => {
    const pole = isP1 ? useStore.getState().p1 : useStore.getState().bot;
    const activeF  = pole.mode !== "NONE";
    const attractF = pole.mode === "ATTRACT";
    emRef.current.lerp(activeF ? (attractF ? CA3 : CR3) : (isP1 ? CI_P1 : CI_BOT), Math.min(1, dt * 12));

    if (meshRef.current) {
      meshRef.current.position.set(pole.x, POLE_R * 0.5, pole.z);
      meshRef.current.material.emissive.copy(emRef.current);
      meshRef.current.material.emissiveIntensity = activeF ? 2.8 : 0.12;
    }
    if (lightRef.current) {
      lightRef.current.position.set(pole.x, 1.0, pole.z);
      lightRef.current.color.copy(activeF ? (attractF ? CA3 : CR3) : new THREE.Color(0, 0, 0));
      lightRef.current.intensity = activeF ? 12 : 0;
    }
    if (symbolRef.current) symbolRef.current.position.set(pole.x, POLE_R + 0.42, pole.z);
    if (labelRef.current)  labelRef.current.position.set(pole.x, POLE_R + 0.18, pole.z);
  });

  return (
    <group>
      <mesh ref={meshRef} castShadow position={[px, POLE_R * 0.5, 0]}>
        <cylinderGeometry args={[POLE_R, POLE_R * 0.85, POLE_R, 32]} />
        <meshStandardMaterial
          color={isP1 ? "#004455" : "#440033"}
          emissive={isP1 ? "#003344" : "#330033"}
          emissiveIntensity={0.15} metalness={0.9} roughness={0.1}
        />
      </mesh>
      
      <MagneticAura isP1={isP1} />
      
      <pointLight ref={lightRef} intensity={0} distance={6} decay={2} />

      <Billboard ref={symbolRef} position={[px, POLE_R + 0.42, 0]}>
        <Text fontSize={0.34} anchorX="center" anchorY="middle" color={symColor} fillOpacity={active ? 1 : 0}>
          {attract ? "\u2212" : "+"}
        </Text>
      </Billboard>
      <Billboard ref={labelRef} position={[px, POLE_R + 0.18, 0]}>
        <Text fontSize={0.13} anchorX="center" anchorY="middle" color="rgba(255,255,255,0.6)">
          {label}
        </Text>
      </Billboard>
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
      if (lr) { lr.position.set(g.x, 0.5, g.z); lr.color.copy(col); lr.intensity = 0.8 + pulse * 1.5; }
    });
  });

  return (
    <group>
      {Array.from({ length: count }).map((_, i) => (
        <group key={i} ref={el => refs.current[i] = el} visible={false}>
          <mesh>
            <torusGeometry args={[POLE_R * 0.9, 0.05, 8, 32]} />
            <meshStandardMaterial color={UI.attract} emissive={UI.attract} emissiveIntensity={1} transparent opacity={0.5} />
          </mesh>
          <mesh>
            <torusGeometry args={[POLE_R * 1.7, 0.03, 8, 32]} />
            <meshStandardMaterial color={UI.attract} emissive={UI.attract} emissiveIntensity={0.6} transparent opacity={0.3} />
          </mesh>
          <mesh>
            <sphereGeometry args={[0.06, 8, 8]} />
            <meshStandardMaterial color={UI.bone} emissive={UI.bone} emissiveIntensity={2} transparent opacity={0.8} />
          </mesh>
        </group>
      ))}
      {Array.from({ length: count }).map((_, i) => (
        <pointLight key={i} ref={el => lights.current[i] = el} intensity={0} distance={4} decay={2} />
      ))}
    </group>
  );
}

// ─── Vector field (High Density Sea) ─────────────────────────────────────────
const dummy     = new THREE.Object3D();
const dummySpk  = new THREE.Object3D();
const fieldCol  = new THREE.Color();
const spikeCol  = new THREE.Color();

function mergeIndexed(geometries) {
  const positions = [], normals = [], indices = [];
  let vOffset = 0;
  for (const g of geometries) {
    const posAttr = g.attributes.position;
    const norAttr = g.attributes.normal;
    for (let i = 0; i < posAttr.count; i++) {
      positions.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      if (norAttr) normals.push(norAttr.getX(i), norAttr.getY(i), norAttr.getZ(i));
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) indices.push(g.index.getX(i) + vOffset);
    } else {
      for (let i = 0; i < posAttr.count; i++) indices.push(i + vOffset);
    }
    vOffset += posAttr.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (normals.length) merged.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  merged.setIndex(indices);
  return merged;
}

function buildArrow() {
  const shaftLen = 0.28, headLen = 0.12;
  const shaft = new THREE.CylinderGeometry(0.012, 0.012, shaftLen, 5);
  shaft.rotateX(Math.PI / 2);
  shaft.translate(0, 0, shaftLen / 2);
  const head = new THREE.ConeGeometry(0.04, headLen, 5);
  head.rotateX(Math.PI / 2);
  head.translate(0, 0, shaftLen + headLen / 2);
  return mergeIndexed([shaft, head]);
}

function buildSpike() {
  const geo = new THREE.ConeGeometry(0.03, 1, 4, 1, true);
  geo.translate(0, 0.5, 0);
  return geo;
}

function VectorField() {
  const meshRef  = useRef();
  const spikeRef = useRef();
  const geoRef   = useRef();
  const spkGeoRef = useRef();
  if (!geoRef.current) geoRef.current = buildArrow();
  if (!spkGeoRef.current) spkGeoRef.current = buildSpike();

  useFrame(() => {
    const mesh  = meshRef.current;
    const spike = spikeRef.current;
    if (!mesh || !spike) return;
    const { p1, bot, ghosts, phase } = useStore.getState();
    if (phase !== "PLAYING") return;

    const t = Date.now() * 0.001;

    for (let i = 0; i < FIELD_COUNT; i++) {
      const wx = fieldX[i], wz = fieldZ[i];
      const pt = { x: wx, z: wz };
      const fp = magForce(p1, pt, p1.mode);
      const fb = magForce(bot, pt, bot.mode);
      const fg = ghosts.reduce((a, g) => { const f = ghostF(g, pt); return { fx: a.fx + f.fx, fz: a.fz + f.fz }; }, { fx: 0, fz: 0 });
      const fx = fp.fx + fb.fx + fg.fx;
      const fz = fp.fz + fb.fz + fg.fz;
      const mag = Math.sqrt(fx * fx + fz * fz);

      const hA = p1.mode === "ATTRACT" || bot.mode === "ATTRACT" || ghosts.some(g => g.mode === "ATTRACT");
      const hR = p1.mode === "REPEL"   || bot.mode === "REPEL"   || ghosts.some(g => g.mode === "REPEL");

      // Magnetic stretching: clamp limits scaling Z-axis based on field strength
      dummy.position.set(wx, 0.025, wz);
      if (mag < 0.08) {
        dummy.scale.setScalar(0.001); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix);
        dummySpk.position.set(wx, 0, wz); dummySpk.scale.setScalar(0.001); dummySpk.updateMatrix();
        spike.setMatrixAt(i, dummySpk.matrix);
        continue;
      }
      dummy.rotation.set(0, Math.atan2(fx, fz), 0);
      dummy.scale.set(1, 1, clamp(mag * 0.45, 0.15, 3.8));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      // Fade out dynamically matching PRD intent (0.1 opacity for far arrows)
      const alpha = clamp(mag * 0.1, 0.03, 1.0);
      if (hA && hR) fieldCol.setHSL(0.75, 1, 0.5);
      else if (hA)  fieldCol.set(UI.attract);
      else if (hR)  fieldCol.set(UI.repel);
      else          fieldCol.setHSL(0.6, 0.4, 0.15);
      fieldCol.multiplyScalar(alpha * 2.5); // Black multiplying essentially controls additive opacity
      mesh.setColorAt(i, fieldCol);

      // Vertical intensity spike
      const shimmer = 0.9 + 0.1 * Math.sin(t * 3 + wx * 1.7 + wz * 1.3);
      const spikeH  = clamp(mag * 0.35, 0.06, 3.8) * shimmer;
      dummySpk.position.set(wx, 0, wz);
      dummySpk.rotation.set(0, 0, 0);
      dummySpk.scale.set(1, spikeH, 1);
      dummySpk.updateMatrix();
      spike.setMatrixAt(i, dummySpk.matrix);

      const spikeAlpha = clamp(mag * 0.07, 0.02, 0.85);
      if (hA && hR) spikeCol.setHSL(0.75, 1, 0.55);
      else if (hA)  spikeCol.set(UI.attract);
      else if (hR)  spikeCol.set(UI.repel);
      else          spikeCol.setHSL(0.6, 0.4, 0.2);
      spikeCol.multiplyScalar(spikeAlpha * 3.5);
      spike.setColorAt(i, spikeCol);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    spike.instanceMatrix.needsUpdate = true;
    if (spike.instanceColor) spike.instanceColor.needsUpdate = true;
  });

  return (
    <group>
      <instancedMesh ref={meshRef} args={[geoRef.current, undefined, FIELD_COUNT]}>
        <meshBasicMaterial vertexColors />
      </instancedMesh>
      <instancedMesh ref={spikeRef} args={[spkGeoRef.current, undefined, FIELD_COUNT]}>
        <meshBasicMaterial vertexColors transparent opacity={0.85} depthWrite={false} blending={THREE.AdditiveBlending} />
      </instancedMesh>
    </group>
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
        boxShadow: active ? `0 0 10px ${color}, 0 0 3px ${color}` : "none",
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
        background:`linear-gradient(180deg, ${UI.depth1}D0 0%, ${UI.void}B0 100%)`,
        borderBottom:`1px solid ${UI.silt}`,
        border:`1px solid rgba(0, 255, 255, 0.15)`,
        boxShadow:`inset 0 -1px 0 rgba(0,0,0,0.4), 0 0 15px rgba(0,255,255,0.05)`,
        backdropFilter:`blur(10px)`,
        position:"relative",
      }}>
        <div style={{ display:"flex", flexDirection:"column", gap:3, minWidth:78 }}>
          <span style={{ color:UI.hazeDim, fontSize:7, letterSpacing:"0.25em", opacity:0.8 }}>PLAYER_1</span>
          <span style={{
            color:UI.bone, fontSize:22, fontWeight:"bold", lineHeight:1,
            letterSpacing:"0.03em",
            textShadow:`0 0 22px ${UI.attract}AA, 0 0 44px ${UI.attract}55, 0 1px 0 rgba(0,0,0,0.6)`,
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
            textShadow:`0 0 22px ${UI.repel}AA, 0 0 44px ${UI.repel}55, 0 1px 0 rgba(0,0,0,0.6)`,
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
          ? `inset 0 2px 5px rgba(0,0,0,0.5), 0 0 18px ${color}88`
          : `0 2px 0 ${UI.void}, 0 0 6px ${color}22`,
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
      borderTop:`1px solid rgba(0, 255, 255, 0.15)`,
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
      backdropFilter:"blur(10px)",
      fontFamily:"'Courier New',monospace",
    }}>
      <div style={{ color:UI.ghost, fontSize:9, letterSpacing:"0.45em", marginBottom:7 }}>MAGNETIC ARCADE</div>
      <div style={{
        color:UI.bone, fontSize:30, fontWeight:"bold", letterSpacing:"0.3em", marginBottom:5,
        animation:"titlePulse 4s ease-in-out infinite",
      }}>MAG&middot;PHYS</div>
      <div style={{ color:UI.hazeDim, fontSize:9, letterSpacing:"0.3em", marginBottom:30 }}>KINETIC OVERHAUL</div>

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
      boxShadow:`inset 0 0 220px ${wc}38`,
      backdropFilter:"blur(10px)",
      fontFamily:"'Courier New',monospace",
    }}>
      <div style={{ color:UI.ghost, fontSize:9, letterSpacing:"0.35em", marginBottom:16 }}>MATCH COMPLETE</div>
      <div style={{
        color:wc, fontSize:30, fontWeight:"bold", letterSpacing:"0.18em", marginBottom:7,
        textShadow:`0 0 36px ${wc}AA, 0 0 70px ${wc}55`,
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

// ─── Post Processing ────────────────────────────────────────────────────────
function PostProcess() {
  const chrRef = useRef();
  
  useFrame(() => {
    const { cameraShake } = useStore.getState();
    if (chrRef.current) {
      const amt = 0.007 * cameraShake;
      chrRef.current.offset.x = amt;
      chrRef.current.offset.y = amt;
    }
  });

  return (
    <EffectComposer disableNormalPass>
      <Bloom intensity={2.5} luminanceThreshold={0.5} luminanceSmoothing={0.9} mipmapBlur />
      <ChromaticAberration ref={chrRef} offset={[0, 0]} radialModulation={false} />
    </EffectComposer>
  );
}

// ─── Scene (inside Canvas) ────────────────────────────────────────────────────
function Scene({ keysRef, s1Ref, s2Ref, modeRef }) {
  const phase    = useStore(s => s.phase);
  const gameMode = useStore(s => s.gameMode);
  return (
    <>
      <CameraRig modeRef={modeRef} />
      <PhysicsController keysRef={keysRef} s1Ref={s1Ref} s2Ref={s2Ref} modeRef={modeRef} />
      <ambientLight intensity={0.12} />
      <pointLight position={[0, 7, 0]} intensity={0.5} color="#ffffff" decay={2} />
      <Environment preset="night" />
      <Arena />
      {phase === "PLAYING" && <>
        <Ball />
        <Pole side="p1"  label="P1" />
        <Pole side="bot" label={gameMode === "2P" ? "P2" : "BOT"} />
        <GhostPoles />
        <VectorField />
      </>}
      <PostProcess />
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
        camera={{ position:[0, 13, 7], fov:56, near:0.1, far:100 }}
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

      {/* Retro-futuristic textures and vignettes */}
      <div style={{
        position:"fixed", inset:0, zIndex:90, pointerEvents:"none",
        background:"radial-gradient(ellipse at 50% 50%, transparent 58%, rgba(0,0,0,0.45) 100%)",
      }} />
      <div style={{
        position:"fixed", inset:0, zIndex:95, pointerEvents:"none",
        background: "repeating-linear-gradient(0deg, transparent, transparent 1px, rgba(0, 0, 0, 0.08) 1px, rgba(0, 0, 0, 0.08) 2px)",
        backgroundSize: "100% 2px",
      }} />

      <style>{`
        *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
        html, body { overflow:hidden; height:100%; touch-action:none; background:${UI.void}; }
        input[type=range] { height:4px; cursor:pointer; }
        input[type=range]::-webkit-slider-thumb { width:20px; height:20px; border-radius:50%; }
        button:active { opacity:0.7; }
        canvas { display:block; }
        @keyframes titlePulse {
          0%, 100% { text-shadow: 0 0 24px ${UI.attract}77, 0 0 50px ${UI.attract}33; }
          50%       { text-shadow: 0 0 44px ${UI.attract}AA, 0 0 90px ${UI.attract}55; }
        }
      `}</style>
    </div>
  );
}
