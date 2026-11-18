import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

interface Logo3DProps {
  size?: 'badge' | 'hero';
  className?: string;
}

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

export const Logo3D: React.FC<Logo3DProps> = ({ size = 'badge', className = '' }) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const pointerTargetRef = useRef({ x: 0, y: 0, hovering: false });

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const pxSize = size === 'hero' ? 168 : 34;
    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 50);
    camera.position.set(0, 0.15, 4.4);

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
    renderer.toneMappingExposure = 1.2;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.setSize(pxSize, pxSize);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = `${pxSize}px`;
    renderer.domElement.style.height = `${pxSize}px`;
    container.appendChild(renderer.domElement);

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const envRT = pmremGenerator.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;
    pmremGenerator.dispose();

    // Brushed silver key + neon purple rim lighting
    const hemi = new THREE.HemisphereLight(0xe2e8f0, 0x09090b, 0.85);
    scene.add(hemi);
    const keyLight = new THREE.DirectionalLight(0xf8fafc, 2.3);
    keyLight.position.set(3, 4, 4);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0xa855f7, 2.0);
    rimLight.position.set(-3, -2, -2);
    scene.add(rimLight);

    // Composite 4-part procedural 3D emblem group
    const emblemGroup = new THREE.Group();
    scene.add(emblemGroup);

    // 1. Primary silhouette: Obsidian & brushed silver hexagonal shield frame
    const hexOuter = new THREE.Shape();
    const outerR = 1.08;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(a) * outerR;
      const y = Math.sin(a) * outerR;
      if (i === 0) hexOuter.moveTo(x, y);
      else hexOuter.lineTo(x, y);
    }
    hexOuter.closePath();

    const hexHole = new THREE.Path();
    const innerR = 0.72;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(a) * innerR;
      const y = Math.sin(a) * innerR;
      if (i === 0) hexHole.moveTo(x, y);
      else hexHole.lineTo(x, y);
    }
    hexHole.closePath();
    hexOuter.holes.push(hexHole);

    const shieldGeo = new THREE.ExtrudeGeometry(hexOuter, {
      depth: 0.22,
      bevelEnabled: true,
      bevelSegments: 3,
      steps: 1,
      bevelSize: 0.06,
      bevelThickness: 0.06,
    });
    shieldGeo.center();

    const obsidianMat = new THREE.MeshStandardMaterial({
      color: 0x18181b,
      metalness: 0.9,
      roughness: 0.22,
    });
    const shieldMesh = new THREE.Mesh(shieldGeo, obsidianMat);
    emblemGroup.add(shieldMesh);

    // 2. Secondary inner neon purple cryptographic crystal core
    const coreGeo = new THREE.OctahedronGeometry(0.46, 0);
    const coreMat = new THREE.MeshPhysicalMaterial({
      color: 0xa855f7,
      emissive: 0x581c87,
      emissiveIntensity: 0.65,
      metalness: 0.18,
      roughness: 0.1,
      clearcoat: 1.0,
      clearcoatRoughness: 0.06,
    });
    const coreMesh = new THREE.Mesh(coreGeo, coreMat);
    emblemGroup.add(coreMesh);

    // 3. Accent chrome silver orbital ring
    const ringGeo = new THREE.TorusGeometry(1.24, 0.036, 14, 64);
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      metalness: 0.95,
      roughness: 0.12,
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.rotation.x = Math.PI / 3;
    ringMesh.rotation.y = Math.PI / 6;
    emblemGroup.add(ringMesh);

    // 4. Precision neon-tipped silver vertex studs on the 6 shield vertices
    const studGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.36, 12);
    studGeo.rotateX(Math.PI / 2);
    const studMat = new THREE.MeshStandardMaterial({
      color: 0xcbd5e1,
      metalness: 0.96,
      roughness: 0.25,
    });
    const studs = new THREE.InstancedMesh(studGeo, studMat, 6);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
      dummy.position.set(Math.cos(a) * 0.9, Math.sin(a) * 0.9, 0);
      dummy.updateMatrix();
      studs.setMatrixAt(i, dummy.matrix);
    }
    studs.instanceMatrix.needsUpdate = true;
    studs.computeBoundingSphere();
    emblemGroup.add(studs);

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
      const elapsed = clock.getElapsedTime();

      const targetX = pointerTargetRef.current.hovering
        ? pointerTargetRef.current.y * 0.45
        : Math.sin(elapsed * 0.8) * 0.12;
      const targetY = pointerTargetRef.current.hovering ? pointerTargetRef.current.x * 0.55 : elapsed * 0.55;

      emblemGroup.rotation.x = THREE.MathUtils.damp(emblemGroup.rotation.x, targetX, 6, dt);
      emblemGroup.rotation.y = THREE.MathUtils.damp(emblemGroup.rotation.y, targetY, 6, dt);
      coreMesh.rotation.y -= dt * 0.9;
      ringMesh.rotation.z += dt * 0.4;

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
      shieldGeo.dispose();
      obsidianMat.dispose();
      coreGeo.dispose();
      coreMat.dispose();
      ringGeo.dispose();
      ringMat.dispose();
      studGeo.dispose();
      studMat.dispose();
      envRT.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [size]);

  return (
    <div
      ref={mountRef}
      aria-label="RRchat 1 3D Cryptographic Emblem"
      onPointerMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        pointerTargetRef.current = {
          x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
          y: ((e.clientY - rect.top) / rect.height) * 2 - 1,
          hovering: true,
        };
      }}
      onPointerLeave={() => {
        pointerTargetRef.current.hovering = false;
      }}
      className={`shrink-0 cursor-pointer select-none ${className}`}
      style={{ width: size === 'hero' ? 168 : 34, height: size === 'hero' ? 168 : 34 }}
    />
  );
};
