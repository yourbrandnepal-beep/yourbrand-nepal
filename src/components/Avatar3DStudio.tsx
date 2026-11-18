import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Check, Save, Shield, Sparkles } from 'lucide-react';
import { rrApi } from '../lib/api';
import { DEFAULT_IDENTITY_3D, type Identity3DConfig, type UserProfile } from '../lib/types';

const isSoftwareGl = (() => {
  if (typeof document === 'undefined') return false;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
})();

const FINISH_COLORS: Record<Identity3DConfig['finish'], { color: number; metalness: number; roughness: number }> = {
  obsidian: { color: 0x18181b, metalness: 0.9, roughness: 0.2 },
  silver: { color: 0xe2e8f0, metalness: 0.96, roughness: 0.14 },
  titanium: { color: 0x52525b, metalness: 0.88, roughness: 0.28 },
};

const AURA_COLORS: Record<Identity3DConfig['auraColor'], { hex: number; emissive: number }> = {
  purple: { hex: 0xa855f7, emissive: 0x581c87 },
  violet: { hex: 0x8b5cf6, emissive: 0x4c1d95 },
  silver: { hex: 0xe2e8f0, emissive: 0x475569 },
  emerald: { hex: 0x10b981, emissive: 0x064e3b },
};

export const BADGE_LABELS: Record<Identity3DConfig['badge'], string> = {
  none: 'No Username Badge',
  zero_phone: 'Zero-Phone Verified',
  vault_guard: 'Vault Guardian',
  verified_node: 'Trusted E2EE Node',
};

interface Avatar3DCanvasProps {
  config: Identity3DConfig;
  size?: number;
}

export const Avatar3DCanvas: React.FC<Avatar3DCanvasProps> = ({ config, size = 240 }) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const pointerRef = useRef({ x: 0, y: 0, active: false });

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 50);
    camera.position.set(0, 0.2, 4.6);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: !isSoftwareGl,
        alpha: true,
        powerPreference: 'high-performance',
      });
    } catch {
      return;
    }

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.setSize(size, size);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = `${size}px`;
    renderer.domElement.style.height = `${size}px`;
    container.appendChild(renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;
    pmrem.dispose();

    const finishSpec = FINISH_COLORS[config.finish] ?? FINISH_COLORS.obsidian;
    const auraSpec = AURA_COLORS[config.auraColor] ?? AURA_COLORS.purple;

    const hemi = new THREE.HemisphereLight(0xf1f5f9, 0x09090b, 0.85);
    scene.add(hemi);
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.3);
    keyLight.position.set(3, 4, 4);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(auraSpec.hex, 2.2);
    rimLight.position.set(-3, -2, -2);
    scene.add(rimLight);

    // 5-part composite 3D Avatar Group
    const rootGroup = new THREE.Group();
    scene.add(rootGroup);

    const disposables: Array<{ dispose: () => void }> = [];

    const shellMat = new THREE.MeshStandardMaterial({
      color: finishSpec.color,
      metalness: finishSpec.metalness,
      roughness: finishSpec.roughness,
    });
    const auraMat = new THREE.MeshPhysicalMaterial({
      color: auraSpec.hex,
      emissive: auraSpec.emissive,
      emissiveIntensity: 0.75,
      metalness: 0.2,
      roughness: 0.1,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
    });
    const chromeMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      metalness: 0.96,
      roughness: 0.14,
    });
    disposables.push(shellMat, auraMat, chromeMat);

    // Part 1: Selectable primary hero shell
    let shellGeo: THREE.BufferGeometry;
    if (config.form === 'orbital') {
      shellGeo = new THREE.TorusKnotGeometry(0.58, 0.16, 96, 16, 2, 3);
    } else if (config.form === 'helm') {
      shellGeo = new THREE.DodecahedronGeometry(0.82, 0);
    } else {
      shellGeo = new THREE.IcosahedronGeometry(0.84, 0);
    }
    disposables.push(shellGeo);
    const shellMesh = new THREE.Mesh(shellGeo, shellMat);
    rootGroup.add(shellMesh);

    // Part 2: Glowing internal crystal core
    const coreGeo = new THREE.OctahedronGeometry(0.45, 0);
    disposables.push(coreGeo);
    const coreMesh = new THREE.Mesh(coreGeo, auraMat);
    rootGroup.add(coreMesh);

    // Part 3: Primary tilted silver gyroscopic ring
    const ring1Geo = new THREE.TorusGeometry(1.18, 0.032, 14, 64);
    disposables.push(ring1Geo);
    const ring1Mesh = new THREE.Mesh(ring1Geo, chromeMat);
    ring1Mesh.rotation.x = Math.PI / 3;
    rootGroup.add(ring1Mesh);

    // Part 4: Counter-angled aura halo ring
    const ring2Geo = new THREE.TorusGeometry(1.34, 0.022, 12, 64);
    disposables.push(ring2Geo);
    const ring2Mesh = new THREE.Mesh(ring2Geo, auraMat);
    ring2Mesh.rotation.y = Math.PI / 2.6;
    ring2Mesh.rotation.x = -Math.PI / 4;
    rootGroup.add(ring2Mesh);

    // Part 5: 6 Instanced satellite encryption nodes orbiting the avatar
    const satGeo = new THREE.OctahedronGeometry(0.08, 0);
    disposables.push(satGeo);
    const satellites = new THREE.InstancedMesh(satGeo, chromeMat, 6);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      dummy.position.set(Math.cos(a) * 1.18, Math.sin(a) * 0.22, Math.sin(a) * 1.18);
      dummy.updateMatrix();
      satellites.setMatrixAt(i, dummy.matrix);
    }
    satellites.instanceMatrix.needsUpdate = true;
    satellites.computeBoundingSphere();
    rootGroup.add(satellites);

    const clock = new THREE.Clock();
    let frameId = 0;
    let disposed = false;

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync?.(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!sync) {
        frameId = window.setTimeout(cb, 80);
        return;
      }
      gl.flush();
      const poll = () => {
        if (disposed) return;
        const state = gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

    function tick() {
      if (disposed) return;
      const dt = Math.min(clock.getDelta(), 0.1);
      const t = clock.getElapsedTime();

      const targetX = pointerRef.current.active ? pointerRef.current.y * 0.45 : Math.sin(t * 0.7) * 0.12;
      const targetY = pointerRef.current.active
        ? pointerRef.current.x * 0.65
        : config.effect === 'static'
          ? 0.4
          : t * (config.effect === 'orbit' ? 0.55 : 0.25);

      rootGroup.rotation.x = THREE.MathUtils.damp(rootGroup.rotation.x, targetX, 5, dt);
      rootGroup.rotation.y = THREE.MathUtils.damp(rootGroup.rotation.y, targetY, 5, dt);

      if (config.effect === 'pulse') {
        const s = 1 + Math.sin(t * 2.4) * 0.06;
        coreMesh.scale.set(s, s, s);
      } else if (config.effect === 'orbit') {
        ring1Mesh.rotation.z += dt * 0.45;
        ring2Mesh.rotation.z -= dt * 0.35;
        satellites.rotation.y += dt * 0.6;
      }

      renderer.render(scene, camera);
      if (isSoftwareGl) {
        afterDraw(tick);
      } else {
        frameId = requestAnimationFrame(tick);
      }
    }

    tick();

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      for (const d of disposables) d.dispose();
      envRT.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [config.form, config.finish, config.auraColor, config.effect, size]);

  return (
    <div
      ref={mountRef}
      onPointerMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        pointerRef.current = {
          x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
          y: ((e.clientY - rect.top) / rect.height) * 2 - 1,
          active: true,
        };
      }}
      onPointerLeave={() => {
        pointerRef.current.active = false;
      }}
      className="mx-auto cursor-grab active:cursor-grabbing select-none"
      style={{ width: size, height: size }}
    />
  );
};

interface Avatar3DStudioProps {
  token: string;
  user: UserProfile;
  onUserRefresh: () => Promise<void>;
}

export const Avatar3DStudio: React.FC<Avatar3DStudioProps> = ({ token, user, onUserRefresh }) => {
  const [config, setConfig] = useState<Identity3DConfig>(user.identity3D ?? DEFAULT_IDENTITY_3D);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (user.identity3D) setConfig(user.identity3D);
  }, [user.identity3D]);

  async function handleSave() {
    setSaving(true);
    setSavedMsg(null);
    setErrorMsg(null);
    try {
      await rrApi.updateIdentity3D(token, config);
      await onUserRefresh();
      setSavedMsg('3D cryptographic avatar and profile identity saved.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save 3D identity.');
    } finally {
      setSaving(false);
    }
  }

  const themeBg =
    config.profileTheme === 'silver_frost'
      ? 'from-zinc-200 via-slate-100 to-purple-100 dark:from-zinc-900 dark:via-slate-900 dark:to-purple-950/60'
      : config.profileTheme === 'midnight_glass'
        ? 'from-slate-900 via-zinc-950 to-indigo-950 text-zinc-100'
        : 'from-zinc-950 via-[#0E0B1A] to-purple-950/80 text-zinc-100';

  return (
    <div className="h-full overflow-y-auto p-6 lg:p-8">
      <div className="max-w-5xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">3D Identity Studio</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
              Craft your procedural 3D cryptographic avatar, metallic finish, neon aura, animated rings, and public
              username badge without exposing private phone or gaming details.
            </p>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={handleSave}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-xl bg-purple-600 hover:bg-purple-500 text-white shadow-sm whitespace-nowrap shrink-0 disabled:opacity-60"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Saving Identity...' : 'Save 3D Identity'}
          </button>
        </div>

        {savedMsg && (
          <div className="p-3.5 rounded-xl bg-purple-50 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800/60 text-purple-900 dark:text-purple-200 text-sm flex items-center gap-2">
            <Check className="w-4 h-4 text-purple-600 dark:text-purple-400" />
            <span>{savedMsg}</span>
          </div>
        )}
        {errorMsg && (
          <div className="p-3.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800/60 text-red-800 dark:text-red-200 text-sm">
            {errorMsg}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Interactive 3D Stage & Live Profile Card */}
          <div className="lg:col-span-5 space-y-4">
            <div
              className={`rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-gradient-to-br ${themeBg} p-6 flex flex-col items-center text-center shadow-lg`}
            >
              {/* WebGL container intentionally has zero backdrop-blur over it */}
              <Avatar3DCanvas config={config} size={236} />
              <div className="mt-3 space-y-1">
                <div className="text-lg font-semibold">{user.displayName}</div>
                <div className="text-xs font-mono opacity-80">@{user.username}</div>
                {config.badge !== 'none' && (
                  <div className="pt-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-purple-400">
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>{BADGE_LABELS[config.badge]}</span>
                  </div>
                )}
              </div>
              <p className="mt-3 text-xs opacity-75 max-w-xs">
                Drag or hover over the 3D emblem to inspect real-time metallic reflections and orbital satellites.
              </p>
            </div>
          </div>

          {/* Customization Controls */}
          <div className="lg:col-span-7 rr-glass border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 space-y-5">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-2">
                3D Silhouette Form
              </label>
              <div className="grid grid-cols-3 gap-2.5">
                {(
                  [
                    { id: 'sentinel', label: 'Sentinel Core' },
                    { id: 'orbital', label: 'Orbital Knot' },
                    { id: 'helm', label: 'Aegis Helm' },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setConfig((c) => ({ ...c, form: item.id }))}
                    className={`px-3 py-2.5 rounded-xl text-xs font-medium border transition-colors ${
                      config.form === item.id
                        ? 'bg-purple-600 text-white border-purple-500'
                        : 'bg-white/70 dark:bg-zinc-900/70 border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:border-purple-500/50'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-2">
                  Metallic Armor Finish
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['obsidian', 'silver', 'titanium'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setConfig((c) => ({ ...c, finish: f }))}
                      className={`px-2.5 py-2 rounded-xl text-xs capitalize border ${
                        config.finish === f
                          ? 'bg-purple-600 text-white border-purple-500'
                          : 'bg-white/70 dark:bg-zinc-900/70 border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300'
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-2">
                  Animated Effect
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['orbit', 'pulse', 'static'] as const).map((eff) => (
                    <button
                      key={eff}
                      type="button"
                      onClick={() => setConfig((c) => ({ ...c, effect: eff }))}
                      className={`px-2.5 py-2 rounded-xl text-xs capitalize border ${
                        config.effect === eff
                          ? 'bg-purple-600 text-white border-purple-500'
                          : 'bg-white/70 dark:bg-zinc-900/70 border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300'
                      }`}
                    >
                      {eff}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-2">
                Core Aura Illumination
              </label>
              <div className="grid grid-cols-4 gap-2">
                {(
                  [
                    { id: 'purple', label: 'Neon Purple' },
                    { id: 'violet', label: 'Deep Violet' },
                    { id: 'silver', label: 'Chrome Silver' },
                    { id: 'emerald', label: 'Cyber Emerald' },
                  ] as const
                ).map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setConfig((c) => ({ ...c, auraColor: a.id }))}
                    className={`px-2.5 py-2 rounded-xl text-xs border ${
                      config.auraColor === a.id
                        ? 'bg-purple-600 text-white border-purple-500'
                        : 'bg-white/70 dark:bg-zinc-900/70 border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300'
                    }`}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-2">
                  Username Badge
                </label>
                <select
                  value={config.badge}
                  onChange={(e) => setConfig((c) => ({ ...c, badge: e.target.value as Identity3DConfig['badge'] }))}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-900 dark:text-zinc-100"
                >
                  {Object.entries(BADGE_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-2">
                  Profile Card Theme
                </label>
                <select
                  value={config.profileTheme}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      profileTheme: e.target.value as Identity3DConfig['profileTheme'],
                    }))
                  }
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-900 dark:text-zinc-100"
                >
                  <option value="obsidian_purple">Obsidian &amp; Neon Purple</option>
                  <option value="silver_frost">Chrome Silver Frost</option>
                  <option value="midnight_glass">Midnight Glass</option>
                </select>
              </div>
            </div>

            <div className="pt-2 border-t border-zinc-200 dark:border-zinc-800/80 flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
              <Shield className="w-4 h-4 text-purple-500 shrink-0" />
              <span>
                Only your non-sensitive 3D avatar configuration and display badge are shared with contacts; private
                contact numbers and gaming IDs stay hidden.
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
