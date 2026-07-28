import "@tanstack/react-start/client-only";

import {useEffect, useRef} from "react";
import type {MutableRefObject} from "react";
import * as THREE from "three";

export type MapaeRenderState = "loading" | "ready" | "fallback";

type MapaeSceneProps = {
    stageRef: MutableRefObject<number>;
    progressRef: MutableRefObject<number>;
    pointerRef: MutableRefObject<{x: number; y: number}>;
    burstRef: MutableRefObject<number>;
    onRenderState: (state: MapaeRenderState) => void;
};

function makePointTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) return;
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.22, "rgba(255,255,255,0.96)");
    gradient.addColorStop(0.55, "rgba(255,255,255,0.34)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

function random(seed: number) {
    let value = seed >>> 0;
    return () => {
        value += 0x6d2b79f5;
        let next = value;
        next = Math.imul(next ^ (next >>> 15), next | 1);
        next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
        return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296;
    };
}

/**
 * The canvas owns atmosphere, not identity.
 *
 * The medallion remains a crisp DOM asset while the particle shell expresses
 * the delegated authority around it. That separation keeps the mark legible on
 * small phones and lets the GPU spend its budget on the one thing raster art
 * cannot do: turn a compact permission into an expanding field.
 */
export function MapaeScene({
    stageRef,
    progressRef,
    pointerRef,
    burstRef,
    onRenderState,
}: MapaeSceneProps) {
    const canvasHost = useRef<HTMLSpanElement>(null);

    useEffect(() => {
        const host = canvasHost.current;
        if (!host) return;

        let frame = 0;
        let disposed = false;
        let resizeObserver: ResizeObserver | undefined;
        let renderer: THREE.WebGLRenderer | undefined;

        try {
            renderer = new THREE.WebGLRenderer({
                alpha: true,
                antialias: true,
                powerPreference: "high-performance",
            });
        } catch {
            onRenderState("fallback");
            return;
        }

        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.45));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.08;
        renderer.domElement.className = "ritual-canvas";
        renderer.domElement.setAttribute("aria-hidden", "true");
        host.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 40);
        camera.position.z = 8.4;

        const energy = new THREE.Group();
        scene.add(energy);

        const pointTexture = makePointTexture();
        const seeded = random(7710);
        const shellCount = window.innerWidth < 620 ? 1_350 : 2_200;
        const shellPositions = new Float32Array(shellCount * 3);
        const shellColors = new Float32Array(shellCount * 3);
        const ivory = new THREE.Color(0xf0d8b8);
        const bronze = new THREE.Color(0xc58a52);
        const red = new THREE.Color(0xef5444);
        const color = new THREE.Color();

        for (let index = 0; index < shellCount; index += 1) {
            const y = 1 - (index / Math.max(shellCount - 1, 1)) * 2;
            const radiusAtY = Math.sqrt(Math.max(1 - y * y, 0));
            const theta = Math.PI * (3 - Math.sqrt(5)) * index + (seeded() - 0.5) * 0.18;
            const radius = 2.2 + (seeded() - 0.5) * 0.18;
            shellPositions[index * 3] = Math.cos(theta) * radiusAtY * radius;
            shellPositions[index * 3 + 1] = y * radius;
            shellPositions[index * 3 + 2] = Math.sin(theta) * radiusAtY * radius;

            const tint = seeded();
            color.copy(tint > 0.94 ? red : tint > 0.58 ? bronze : ivory);
            color.multiplyScalar(0.72 + seeded() * 0.28);
            shellColors[index * 3] = color.r;
            shellColors[index * 3 + 1] = color.g;
            shellColors[index * 3 + 2] = color.b;
        }

        const shellGeometry = new THREE.BufferGeometry();
        shellGeometry.setAttribute("position", new THREE.BufferAttribute(shellPositions, 3));
        shellGeometry.setAttribute("color", new THREE.BufferAttribute(shellColors, 3));
        const shellMaterial = new THREE.PointsMaterial({
            map: pointTexture,
            size: window.innerWidth < 620 ? 0.038 : 0.032,
            vertexColors: true,
            transparent: true,
            opacity: 0.68,
            alphaTest: 0.02,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });
        const shell = new THREE.Points(shellGeometry, shellMaterial);
        energy.add(shell);

        const fieldCount = window.innerWidth < 620 ? 260 : 460;
        const fieldPositions = new Float32Array(fieldCount * 3);
        for (let index = 0; index < fieldCount; index += 1) {
            const angle = seeded() * Math.PI * 2;
            const radius = 2.8 + seeded() * 3.9;
            fieldPositions[index * 3] = Math.cos(angle) * radius;
            fieldPositions[index * 3 + 1] = Math.sin(angle) * radius;
            fieldPositions[index * 3 + 2] = (seeded() - 0.5) * 4;
        }
        const fieldGeometry = new THREE.BufferGeometry();
        fieldGeometry.setAttribute("position", new THREE.BufferAttribute(fieldPositions, 3));
        const fieldMaterial = new THREE.PointsMaterial({
            map: pointTexture,
            color: 0xd4a36f,
            size: 0.025,
            transparent: true,
            opacity: 0,
            alphaTest: 0.02,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });
        const field = new THREE.Points(fieldGeometry, fieldMaterial);
        energy.add(field);

        const rings = [
            {radius: 1.24, color: 0xef5444},
            {radius: 1.62, color: 0xc58a52},
            {radius: 2.02, color: 0xf0d8b8},
        ].map(({radius, color}, index) => {
            const material = new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: 0.07,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
            });
            const mesh = new THREE.Mesh(
                new THREE.TorusGeometry(radius, index === 0 ? 0.012 : 0.008, 8, 160),
                material,
            );
            mesh.rotation.x = (index - 1) * 0.16;
            mesh.rotation.y = (1 - index) * 0.11;
            energy.add(mesh);
            return {mesh, material};
        });

        const resize = () => {
            if (!renderer) return;
            const width = Math.max(host.clientWidth, 1);
            const height = Math.max(host.clientHeight, 1);
            renderer.setSize(width, height, false);
            camera.aspect = width / height;
            camera.position.z = width < 520 ? 8.9 : 8.4;
            camera.updateProjectionMatrix();
        };
        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(host);
        resize();

        const timer = new THREE.Timer();
        timer.connect(document);
        let smoothStage = 0;
        let smoothProgress = 0;
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const render = () => {
            if (!renderer || disposed) return;
            timer.update();
            const elapsed = timer.getElapsed();
            const stage = stageRef.current;
            const progress = progressRef.current;
            smoothStage += (stage - smoothStage) * 0.07;
            smoothProgress += (progress - smoothProgress) * 0.055;
            burstRef.current *= 0.93;

            const drift = reducedMotion ? 0 : elapsed;
            energy.rotation.y +=
                (pointerRef.current.x * 0.09 + drift * 0.035 - energy.rotation.y) * 0.025;
            energy.rotation.x +=
                (pointerRef.current.y * -0.07 + Math.sin(drift * 0.22) * 0.035 - energy.rotation.x) *
                0.035;
            energy.rotation.z = Math.sin(drift * 0.12) * 0.035;
            const expansion = 1 + smoothProgress * 0.48 + burstRef.current * 0.035;
            energy.scale.setScalar(expansion);

            rings.forEach(({mesh, material}, index) => {
                const active = Math.abs(smoothStage - (index + 1)) < 0.72 ? 1 : 0;
                const breathing = reducedMotion
                    ? 0
                    : Math.sin(elapsed * (0.52 + index * 0.08) + index) * 0.018;
                material.opacity =
                    0.045 + active * 0.18 + smoothProgress * 0.05 + burstRef.current * 0.22;
                mesh.scale.setScalar(1 + breathing + smoothProgress * index * 0.025);
            });

            shell.rotation.y = drift * 0.018;
            shell.rotation.z = -drift * 0.008;
            shellMaterial.opacity = 0.68 - smoothProgress * 0.13 + burstRef.current * 0.14;
            fieldMaterial.opacity = Math.max(0, smoothProgress - 0.22) * 0.56;
            field.rotation.z = -drift * 0.012;

            renderer.render(scene, camera);
            frame = requestAnimationFrame(render);
        };

        onRenderState("ready");
        render();

        return () => {
            disposed = true;
            cancelAnimationFrame(frame);
            resizeObserver?.disconnect();
            timer.dispose();
            pointTexture?.dispose();
            shellGeometry.dispose();
            shellMaterial.dispose();
            fieldGeometry.dispose();
            fieldMaterial.dispose();
            rings.forEach(({mesh, material}) => {
                mesh.geometry.dispose();
                material.dispose();
            });
            renderer?.dispose();
            renderer?.domElement.remove();
        };
    }, [burstRef, onRenderState, pointerRef, progressRef, stageRef]);

    return <span className="ritual-canvas-host" ref={canvasHost} aria-hidden="true" />;
}
