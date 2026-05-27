"use client";

import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export default function HeroCoin() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const flipRef = useRef(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current || !canvasRef.current) return;

    let animationFrameId: number;
    let coinGroup: THREE.Group | null = null;

    // Mouse tracking for coin tilt
    let mouseX = 0;
    let mouseY = 0;
    let targetRotX = 0;
    let targetRotZ = 0;
    let currentRotX = 0;
    let currentRotZ = 0;

    // Click-to-flip tracking
    let extraRotX = 0;

    const handleMouseMove = (e: MouseEvent) => {
      // Normalize to -1 to +1
      mouseX = (e.clientX / window.innerWidth) * 2 - 1;
      mouseY = (e.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener("mousemove", handleMouseMove);

    // 1. Initialize Scene, Camera, and Renderer
    const scene = new THREE.Scene();

    const width = containerRef.current.clientWidth || 400;
    const height = containerRef.current.clientHeight || 400;

    // Perspective camera with good depth
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.z = 6;

    const renderer = new THREE.WebGLRenderer({
      canvas: canvasRef.current,
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = false;

    // 2. Intense daytime sunlight — coin must be bright
    // Strong ambient fill so nothing goes dark
    const ambientLight = new THREE.AmbientLight(0xffffff, 3.0);
    scene.add(ambientLight);

    // Main sun — extremely bright warm yellow from above
    const sunLight = new THREE.DirectionalLight(0xfff8dd, 6.0);
    sunLight.position.set(0, 6, 3);
    scene.add(sunLight);

    // Strong front fill so the face is fully illuminated
    const fillLight = new THREE.DirectionalLight(0xffffff, 4.0);
    fillLight.position.set(0, 2, 6);
    scene.add(fillLight);

    // Bright point light very close to the coin
    const popLight = new THREE.PointLight(0xfff0cc, 8, 8);
    popLight.position.set(0, 2, 3);
    scene.add(popLight);

    // 3. Load the GLB Coin Model
    const loader = new GLTFLoader();

    loader.load(
      "/usdc-3d.glb",
      (gltf) => {
        coinGroup = gltf.scene;

        // Assign colors to meshes (GLB may export with default white materials)
        const meshes: THREE.Mesh[] = [];
        coinGroup.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            mesh.castShadow = false;
            mesh.receiveShadow = false;
            meshes.push(mesh);
          }
        });

        // Find largest mesh by volume → coin body
        let bodyMesh: THREE.Mesh | null = null;
        let maxVol = 0;
        meshes.forEach((m) => {
          const b = new THREE.Box3().setFromObject(m);
          const s = b.getSize(new THREE.Vector3());
          const vol = s.x * s.y * s.z;
          if (vol > maxVol) {
            maxVol = vol;
            bodyMesh = m;
          }
        });

        // Color: body = USDC blue, symbols = white
        meshes.forEach((m) => {
          const isBody = m === bodyMesh;
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          const cloned = mats.map((mat) => {
            const c = mat.clone();
            if ('color' in c) {
              (c as { color: { set: (v: string) => void } }).color.set(isBody ? '#2775CA' : '#ffffff');
            }
            return c;
          });
          m.material = cloned.length === 1 ? cloned[0] : cloned;
        });

        // Center and scale the model automatically
        const box = new THREE.Box3().setFromObject(coinGroup);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());

        // Center the geometry inside its parent coordinate space
        coinGroup.position.x = -center.x;
        coinGroup.position.y = -center.y;
        coinGroup.position.z = -center.z;

        // Rotate the model so it stands upright (Fusion 360 Z-up to Three.js Y-up adjustment)
        coinGroup.rotation.x = Math.PI / 2;

        // Wrap in a main pivoting group to rotate around center cleanly
        const pivotGroup = new THREE.Group();
        pivotGroup.add(coinGroup);
        scene.add(pivotGroup);

        // Adjust scale relative to the size of the box so it is standard across all displays
        const maxDim = Math.max(size.x, size.y, size.z);
        const scaleFactor = 2.4 / maxDim; // Target visual size of 2.4 units in scene
        pivotGroup.scale.set(scaleFactor, scaleFactor, scaleFactor);

        coinGroup = pivotGroup; // re-reference for animation loop
      },
      undefined,
      (err) => {
        console.error("Error loading GLB 3D coin asset:", err);
        setError("Failed to load 3D coin asset");
      }
    );

    // 4. Animation Loop
    const clock = new THREE.Clock();
    const sunRadius = 6;
    const sunSpeed = 0.3;

    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);

      const elapsedTime = clock.getElapsedTime();

      // Sun orbits around the coin
      sunLight.position.x = Math.sin(elapsedTime * sunSpeed) * sunRadius;
      sunLight.position.z = Math.cos(elapsedTime * sunSpeed) * sunRadius;
      sunLight.position.y = 4 + Math.sin(elapsedTime * sunSpeed * 0.5) * 2;

      // Gentle hover — tilt oscillation + vertical bob + mouse follow
      if (coinGroup) {
        // Mouse-influenced target tilt (max ~15°)
        targetRotX = mouseY * 0.25;
        targetRotZ = -mouseX * 0.25;

        // Smooth interpolation (lerp) for natural feel
        currentRotX += (targetRotX - currentRotX) * 0.05;
        currentRotZ += (targetRotZ - currentRotZ) * 0.05;

        // Click-to-flip lerp
        extraRotX += (flipRef.current - extraRotX) * 0.08;

        // Combine with gentle oscillation + flip
        coinGroup.rotation.x = Math.sin(elapsedTime * 0.5) * 0.1 + currentRotX + extraRotX;
        coinGroup.rotation.z = Math.cos(elapsedTime * 0.5) * 0.03 + currentRotZ;

        // Vertically bob/float the coin
        coinGroup.position.y = Math.sin(elapsedTime * 1.5) * 0.12;
      }

      renderer.render(scene, camera);
    };

    animate();

    // 5. Handle Resize
    const handleResize = () => {
      if (!containerRef.current || !canvasRef.current) return;
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;

      camera.aspect = w / h;
      camera.updateProjectionMatrix();

      renderer.setSize(w, h);
    };

    window.addEventListener("resize", handleResize);

    // 6. Cleanup
    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("mousemove", handleMouseMove);
      
      // Dispose Three.js objects
      scene.traverse((object) => {
        if (!(object instanceof THREE.Object3D)) return;
        
        if ((object as THREE.Mesh).isMesh) {
          const mesh = object as THREE.Mesh;
          mesh.geometry.dispose();
          
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach((mat) => mat.dispose());
          } else {
            mesh.material.dispose();
          }
        }
      });
      renderer.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="hero-coin-wrapper"
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        zIndex: 30,
        width: "clamp(300px, 70vw, 650px)",
        height: "clamp(300px, 70vw, 650px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "auto",
        cursor: "pointer",
      }}
      onClick={() => {
        flipRef.current += Math.PI * 2;
      }}
    >
      {/* Warm sun glow behind the coin */}
      <div style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        width: "clamp(230px, 54vw, 500px)",
        height: "clamp(230px, 54vw, 500px)",
        borderRadius: "50%",
        background: "radial-gradient(circle, rgba(255,240,200,0.45) 0%, rgba(255,220,150,0.2) 40%, transparent 70%)",
        transform: "translate(-50%, -50%)",
        zIndex: 1,
        pointerEvents: "none",
        animation: "breathe-glow 4s ease-in-out infinite",
      }} />

      {/* Canvas Element */}
      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height: "100%",
          zIndex: 2,
          display: "block",
          filter: "drop-shadow(0 10px 30px rgba(39,117,202,0.15))", // Subtle shadow on white
        }}
      />

      {/* Error Fallback */}
      {error && (
        <div style={{
          position: "absolute",
          color: "#ef4444",
          fontFamily: "sans-serif",
          fontSize: "12px",
          zIndex: 3,
        }}>
          {error}
        </div>
      )}
    </div>
  );
}
