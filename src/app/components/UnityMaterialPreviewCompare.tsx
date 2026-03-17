import clsx from "clsx";
import { readPsd } from "ag-psd";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type {
  FilePreview,
  ImageComparisonPreset,
  UnityColorValue,
  UnityMaterialPreviewSource,
  UnityMaterialTexturePreview,
} from "../../features/repositories/api";

type ViewerMode = { kind: "single"; sourceKey: string } | { kind: "compare"; presetKey: string };
type PreviewShape = "sphere" | "box" | "cylinder";
type OrbitState = { rotationX: number; rotationY: number; distance: number };

const DEFAULT_ORBIT: OrbitState = { rotationX: 0.28, rotationY: -0.55, distance: 3.2 };
const MIN_DISTANCE = 1.6;
const MAX_DISTANCE = 7;

export function UnityMaterialPreviewCompare({ preview }: { preview: FilePreview }) {
  const sourceMap = useMemo(() => new Map(preview.unityMaterialSources.map((source) => [source.key, source])), [preview.unityMaterialSources]);
  const defaultSingleSourceKey = sourceMap.has("workingTree") ? "workingTree" : preview.unityMaterialSources[0]?.key ?? null;
  const [shape, setShape] = useState<PreviewShape>("sphere");
  const [singleOrbit, setSingleOrbit] = useState<OrbitState>(DEFAULT_ORBIT);
  const [compareOrbit, setCompareOrbit] = useState<OrbitState>(DEFAULT_ORBIT);
  const [viewerMode, setViewerMode] = useState<ViewerMode | null>(() => {
    if (preview.defaultUnityMaterialComparisonPresetKey) {
      return { kind: "compare", presetKey: preview.defaultUnityMaterialComparisonPresetKey };
    }

    return defaultSingleSourceKey ? { kind: "single", sourceKey: defaultSingleSourceKey } : null;
  });

  useEffect(() => {
    if (preview.defaultUnityMaterialComparisonPresetKey) {
      setViewerMode({ kind: "compare", presetKey: preview.defaultUnityMaterialComparisonPresetKey });
      return;
    }

    if (defaultSingleSourceKey) {
      setViewerMode({ kind: "single", sourceKey: defaultSingleSourceKey });
      return;
    }

    setViewerMode(null);
  }, [defaultSingleSourceKey, preview.defaultUnityMaterialComparisonPresetKey, preview.relativePath]);

  const activePreset = viewerMode?.kind === "compare"
    ? preview.unityMaterialComparisonPresets.find((preset) => preset.key === viewerMode.presetKey) ?? null
    : null;
  const singleSource = viewerMode?.kind === "single"
    ? sourceMap.get(viewerMode.sourceKey) ?? null
    : null;

  useEffect(() => {
    setSingleOrbit(DEFAULT_ORBIT);
  }, [singleSource?.key]);

  useEffect(() => {
    setCompareOrbit(DEFAULT_ORBIT);
  }, [activePreset?.key]);

  if (preview.unityMaterialSources.length === 0) {
    return (
      <div className="preview-frame preview-frame--placeholder">
        <p>{preview.supportHint}</p>
      </div>
    );
  }

  return (
    <div className="material-preview-workbench">
      <div className="material-preview-toolbar">
        {defaultSingleSourceKey ? (
          <button
            className={clsx("ghost-button", viewerMode?.kind === "single" && viewerMode.sourceKey === defaultSingleSourceKey && "ghost-button--active")}
            onClick={() => setViewerMode({ kind: "single", sourceKey: defaultSingleSourceKey })}
          >
            Current material
          </button>
        ) : null}
        {preview.unityMaterialComparisonPresets.map((preset) => (
          <button
            key={preset.key}
            className={clsx("ghost-button", viewerMode?.kind === "compare" && viewerMode.presetKey === preset.key && "ghost-button--active")}
            onClick={() => setViewerMode({ kind: "compare", presetKey: preset.key })}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="material-shape-toolbar">
        {(["sphere", "box", "cylinder"] as PreviewShape[]).map((option) => (
          <button
            key={option}
            className={clsx("ghost-button", shape === option && "ghost-button--active")}
            onClick={() => setShape(option)}
          >
            {option[0].toUpperCase()}{option.slice(1)}
          </button>
        ))}
      </div>

      {activePreset ? (
        <div className="material-compare-grid">
          <MaterialPane
            source={sourceMap.get(activePreset.leftSourceKey) ?? null}
            caption={activePreset.description}
            shape={shape}
            orbit={compareOrbit}
            onOrbitChange={setCompareOrbit}
          />
          <MaterialPane
            source={sourceMap.get(activePreset.rightSourceKey) ?? null}
            caption={activePreset.description}
            shape={shape}
            orbit={compareOrbit}
            onOrbitChange={setCompareOrbit}
          />
        </div>
      ) : singleSource ? (
        <div className="material-single-grid">
          <MaterialPane source={singleSource} shape={shape} orbit={singleOrbit} onOrbitChange={setSingleOrbit} />
        </div>
      ) : null}
    </div>
  );
}

function MaterialPane({
  source,
  caption,
  shape,
  orbit,
  onOrbitChange,
}: {
  source: UnityMaterialPreviewSource | null;
  caption?: string;
  shape: PreviewShape;
  orbit: OrbitState;
  onOrbitChange: (value: OrbitState) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const renderRef = useRef<(() => void) | null>(null);
  const orbitRef = useRef(orbit);
  const dragStateRef = useRef<{ pointerId: number; startX: number; startY: number; rotationX: number; rotationY: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    orbitRef.current = orbit;
  }, [orbit]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);

    const ambient = new THREE.AmbientLight(0xffffff, 0.7);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.25);
    keyLight.position.set(4, 5, 6);
    const fillLight = new THREE.DirectionalLight(0x7fb5ff, 0.65);
    fillLight.position.set(-5, 2, 4);

    scene.add(ambient, keyLight, fillLight);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;

    const renderScene = () => {
      const localRenderer = rendererRef.current;
      const localCamera = cameraRef.current;
      const localScene = sceneRef.current;
      const localMesh = meshRef.current;
      const localCanvas = canvasRef.current;
      if (!localRenderer || !localCamera || !localScene || !localCanvas) {
        return;
      }

      const width = localCanvas.clientWidth || 320;
      const height = localCanvas.clientHeight || 320;
      localRenderer.setSize(width, height, false);
      localCamera.aspect = width / height;
      localCamera.updateProjectionMatrix();
      localCamera.position.set(0, 0.4, orbitRef.current.distance);
      localCamera.lookAt(0, 0, 0);

      if (localMesh) {
        localMesh.rotation.x = orbitRef.current.rotationX;
        localMesh.rotation.y = orbitRef.current.rotationY;
      }

      localRenderer.render(localScene, localCamera);
    };

    renderRef.current = renderScene;
    renderScene();

    const resizeObserver = new ResizeObserver(() => renderScene());
    resizeObserver.observe(canvas);

    return () => {
      resizeObserver.disconnect();
      renderRef.current = null;
      meshRef.current?.geometry.dispose();
      disposeMaterial(meshRef.current?.material ?? null);
      meshRef.current = null;
      renderer.dispose();
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
    };
  }, []);

  useEffect(() => {
    renderRef.current?.();
  }, [orbit]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !source) {
      return;
    }

    let cancelled = false;

    const loadMaterial = async () => {
      setLoading(true);
      setError(null);

      try {
        const geometry = createPreviewGeometry(shape);
        const material = await buildThreeMaterial(source);
        if (cancelled) {
          geometry.dispose();
          disposeMaterial(material);
          return;
        }

        if (meshRef.current) {
          scene.remove(meshRef.current);
          meshRef.current.geometry.dispose();
          disposeMaterial(meshRef.current.material);
        }

        const mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);
        meshRef.current = mesh;
        renderRef.current?.();
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Material preview failed.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadMaterial();

    return () => {
      cancelled = true;
    };
  }, [shape, source]);

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.altKey) {
      return;
    }

    event.preventDefault();
    const nextDistance = clamp(orbit.distance + (event.deltaY > 0 ? 0.24 : -0.24), MIN_DISTANCE, MAX_DISTANCE);
    onOrbitChange({ ...orbit, distance: nextDistance });
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      rotationX: orbit.rotationX,
      rotationY: orbit.rotationY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;
    onOrbitChange({
      ...orbit,
      rotationX: clamp(dragState.rotationX + deltaY * 0.012, -1.2, 1.2),
      rotationY: dragState.rotationY + deltaX * 0.012,
    });
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId === event.pointerId) {
      dragStateRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleDoubleClick = () => {
    onOrbitChange(DEFAULT_ORBIT);
  };

  return (
    <div className="material-pane-card">
      <div className="preview-panel__header material-pane-card__header">
        <div>
          <strong>{source?.materialName ?? "Material preview"}</strong>
          <p className="preview-panel__meta material-pane-card__meta">
            {[source?.shaderLabel, source?.surfaceKind, caption].filter(Boolean).join(" • ")}
          </p>
        </div>
      </div>

      {source?.notes.length ? <p className="muted">{source.notes[0]}</p> : null}

      {loading ? <p className="muted">Loading material preview...</p> : null}
      {error ? <p className="muted">{error}</p> : null}

      <div
        ref={surfaceRef}
        className="preview-frame material-pane-card__frame"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
      >
        <canvas ref={canvasRef} className="material-preview-canvas" />
      </div>

      {source ? (
        <dl className="preview-details">
          <div>
            <dt>Shader</dt>
            <dd>{source.shaderLabel}</dd>
          </div>
          <div>
            <dt>Surface</dt>
            <dd>{source.surfaceKind}</dd>
          </div>
          <div>
            <dt>Textures</dt>
            <dd>{source.textures.length}</dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}

function createPreviewGeometry(shape: PreviewShape) {
  switch (shape) {
    case "box":
      return new THREE.BoxGeometry(1.65, 1.65, 1.65, 1, 1, 1);
    case "cylinder":
      return new THREE.CylinderGeometry(0.9, 0.9, 1.9, 48, 1, false);
    default:
      return new THREE.SphereGeometry(1.1, 64, 64);
  }
}

async function buildThreeMaterial(source: UnityMaterialPreviewSource) {
  const textures = new Map<string, THREE.Texture>();
  for (const texture of source.textures) {
    const loadedTexture = await decodeTexture(texture);
    if (loadedTexture) {
      textures.set(texture.key, loadedTexture);
    }
  }

  const baseColor = toThreeColor(source.baseColor ?? { r: 0.75, g: 0.75, b: 0.75, a: 1 });
  const transparent = source.surfaceKind === "transparent" || (source.baseColor?.a ?? 1) < 0.999;
  const alphaTest = source.cutoff ?? 0;
  const baseMap = source.baseTextureKey ? textures.get(source.baseTextureKey) ?? null : null;
  const normalMap = source.normalTextureKey ? textures.get(source.normalTextureKey) ?? null : null;
  const emissionMap = source.emissionTextureKey ? textures.get(source.emissionTextureKey) ?? null : null;

  if (source.shaderFamily === "unlit") {
    return new THREE.MeshBasicMaterial({
      color: baseColor,
      map: baseMap ?? undefined,
      transparent,
      opacity: source.baseColor?.a ?? 1,
      alphaTest,
    });
  }

  return new THREE.MeshStandardMaterial({
    color: baseColor,
    map: baseMap ?? undefined,
    normalMap: normalMap ?? undefined,
    emissive: toThreeColor(source.emissionColor ?? { r: 0, g: 0, b: 0, a: 1 }),
    emissiveMap: emissionMap ?? undefined,
    emissiveIntensity: source.emissionColor ? 1 : 0,
    metalness: clamp(source.metallic ?? 0, 0, 1),
    roughness: 1 - clamp(source.smoothness ?? 0.5, 0, 1),
    transparent,
    opacity: source.baseColor?.a ?? 1,
    alphaTest,
  });
}

async function decodeTexture(texture: UnityMaterialTexturePreview) {
  const bytes = decodeBase64(texture.encodedBytesBase64);
  const canvas = texture.isPsd ? decodePsdCanvas(bytes) : await decodeBitmapCanvas(bytes, texture.mimeType);
  if (!canvas) {
    return null;
  }

  const threeTexture = new THREE.CanvasTexture(canvas);
  threeTexture.colorSpace = THREE.SRGBColorSpace;
  threeTexture.wrapS = THREE.RepeatWrapping;
  threeTexture.wrapT = THREE.RepeatWrapping;
  threeTexture.needsUpdate = true;
  return threeTexture;
}

function decodePsdCanvas(bytes: Uint8Array) {
  const psd = readPsd(toOwnedArrayBuffer(bytes));
  const imageData = (psd as { imageData?: ImageData }).imageData;
  if (imageData) {
    const canvas = document.createElement("canvas");
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }
    context.putImageData(imageData, 0, 0);
    return canvas;
  }

  return (psd as { canvas?: HTMLCanvasElement }).canvas ?? null;
}

async function decodeBitmapCanvas(bytes: Uint8Array, mimeType: string) {
  const blob = new Blob([toOwnedUint8Array(bytes)], { type: mimeType || "application/octet-stream" });
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }
    context.drawImage(bitmap, 0, 0);
    return canvas;
  } finally {
    bitmap.close();
  }
}

function decodeBase64(encoded: string) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toOwnedUint8Array(bytes: Uint8Array) {
  return new Uint8Array(bytes);
}

function toOwnedArrayBuffer(bytes: Uint8Array) {
  return toOwnedUint8Array(bytes).buffer;
}

function toThreeColor(color: UnityColorValue) {
  return new THREE.Color(color.r, color.g, color.b);
}

function disposeMaterial(material: THREE.Material | THREE.Material[] | null) {
  if (!material) {
    return;
  }

  if (Array.isArray(material)) {
    material.forEach((entry) => disposeMaterial(entry));
    return;
  }

  for (const value of Object.values(material as unknown as Record<string, unknown>)) {
    if (value instanceof THREE.Texture) {
      value.dispose();
    }
  }

  material.dispose();
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}