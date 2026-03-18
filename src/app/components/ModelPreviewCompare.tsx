import clsx from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import type { FilePreview, ModelPreviewSource } from "../../features/repositories/api";

type ViewerMode = { kind: "single"; sourceKey: string } | { kind: "compare"; presetKey: string };
type OrbitState = { rotationX: number; rotationY: number; distance: number };

const DEFAULT_ORBIT: OrbitState = { rotationX: 0.3, rotationY: -0.55, distance: 4.2 };
const MIN_DISTANCE = 1.8;
const MAX_DISTANCE = 12;

export function ModelPreviewCompare({ preview }: { preview: FilePreview }) {
  const sourceMap = useMemo(() => new Map(preview.modelSources.map((source) => [source.key, source])), [preview.modelSources]);
  const defaultSingleSourceKey = sourceMap.has("workingTree") ? "workingTree" : preview.modelSources[0]?.key ?? null;
  const [singleOrbit, setSingleOrbit] = useState<OrbitState>(DEFAULT_ORBIT);
  const [compareOrbit, setCompareOrbit] = useState<OrbitState>(DEFAULT_ORBIT);
  const [viewerMode, setViewerMode] = useState<ViewerMode | null>(() => {
    if (preview.defaultModelComparisonPresetKey) {
      return { kind: "compare", presetKey: preview.defaultModelComparisonPresetKey };
    }

    return defaultSingleSourceKey ? { kind: "single", sourceKey: defaultSingleSourceKey } : null;
  });

  useEffect(() => {
    if (preview.defaultModelComparisonPresetKey) {
      setViewerMode({ kind: "compare", presetKey: preview.defaultModelComparisonPresetKey });
      return;
    }

    if (defaultSingleSourceKey) {
      setViewerMode({ kind: "single", sourceKey: defaultSingleSourceKey });
      return;
    }

    setViewerMode(null);
  }, [defaultSingleSourceKey, preview.defaultModelComparisonPresetKey, preview.relativePath]);

  const activePreset = viewerMode?.kind === "compare"
    ? preview.modelComparisonPresets.find((preset) => preset.key === viewerMode.presetKey) ?? null
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

  if (preview.modelSources.length === 0) {
    return (
      <div className="preview-frame preview-frame--placeholder">
        <p>{preview.supportHint}</p>
      </div>
    );
  }

  return (
    <div className="model-preview-workbench">
      <div className="model-preview-toolbar">
        {defaultSingleSourceKey ? (
          <button
            className={clsx("ghost-button", viewerMode?.kind === "single" && viewerMode.sourceKey === defaultSingleSourceKey && "ghost-button--active")}
            onClick={() => setViewerMode({ kind: "single", sourceKey: defaultSingleSourceKey })}
          >
            Current model
          </button>
        ) : null}
        {preview.modelComparisonPresets.map((preset) => (
          <button
            key={preset.key}
            className={clsx("ghost-button", viewerMode?.kind === "compare" && viewerMode.presetKey === preset.key && "ghost-button--active")}
            onClick={() => setViewerMode({ kind: "compare", presetKey: preset.key })}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {activePreset ? (
        <div className="model-compare-grid">
          <ModelPane source={sourceMap.get(activePreset.leftSourceKey) ?? null} caption={activePreset.description} orbit={compareOrbit} onOrbitChange={setCompareOrbit} />
          <ModelPane source={sourceMap.get(activePreset.rightSourceKey) ?? null} caption={activePreset.description} orbit={compareOrbit} onOrbitChange={setCompareOrbit} />
        </div>
      ) : singleSource ? (
        <div className="model-single-grid">
          <ModelPane source={singleSource} orbit={singleOrbit} onOrbitChange={setSingleOrbit} />
        </div>
      ) : null}
    </div>
  );
}

function ModelPane({
  source,
  caption,
  orbit,
  onOrbitChange,
}: {
  source: ModelPreviewSource | null;
  caption?: string;
  orbit: OrbitState;
  onOrbitChange: (value: OrbitState) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const objectRef = useRef<THREE.Object3D | null>(null);
  const renderRef = useRef<(() => void) | null>(null);
  const orbitRef = useRef(orbit);
  const dragStateRef = useRef<{ pointerId: number; startX: number; startY: number; rotationX: number; rotationY: number } | null>(null);
  const resourceUrlsRef = useRef<string[]>([]);
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
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);

    const ambient = new THREE.AmbientLight(0xffffff, 0.82);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.35);
    keyLight.position.set(4, 5, 6);
    const rimLight = new THREE.DirectionalLight(0x7fb5ff, 0.55);
    rimLight.position.set(-4, 3, -5);
    scene.add(ambient, keyLight, rimLight);

    const grid = new THREE.GridHelper(8, 16, 0x2f4c7c, 0x1d2636);
    grid.position.y = -1.4;
    scene.add(grid);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;

    const renderScene = () => {
      const localRenderer = rendererRef.current;
      const localCamera = cameraRef.current;
      const localScene = sceneRef.current;
      const localObject = objectRef.current;
      const localCanvas = canvasRef.current;
      if (!localRenderer || !localCamera || !localScene || !localCanvas) {
        return;
      }

      const width = localCanvas.clientWidth || 320;
      const height = localCanvas.clientHeight || 320;
      localRenderer.setSize(width, height, false);
      localCamera.aspect = width / height;
      localCamera.updateProjectionMatrix();
      localCamera.position.set(0, 0.6, orbitRef.current.distance);
      localCamera.lookAt(0, 0, 0);

      if (localObject) {
        localObject.rotation.x = orbitRef.current.rotationX;
        localObject.rotation.y = orbitRef.current.rotationY;
      }

      localRenderer.render(localScene, localCamera);
    };

    renderRef.current = renderScene;
    renderScene();

    const resizeObserver = new ResizeObserver(() => renderScene());
    resizeObserver.observe(canvas);

    return () => {
      resizeObserver.disconnect();
      clearObject(scene, objectRef.current);
      objectRef.current = null;
      revokeResourceUrls(resourceUrlsRef.current);
      resourceUrlsRef.current = [];
      renderer.dispose();
      renderRef.current = null;
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

    const loadModel = async () => {
      setLoading(true);
      setError(null);
      revokeResourceUrls(resourceUrlsRef.current);
      resourceUrlsRef.current = [];

      try {
        const object = await loadModelSource(source, resourceUrlsRef.current);
        if (cancelled) {
          disposeObject3D(object);
          revokeResourceUrls(resourceUrlsRef.current);
          resourceUrlsRef.current = [];
          return;
        }

        clearObject(scene, objectRef.current);
        const normalizedObject = fitObjectToPreview(object);
        scene.add(normalizedObject);
        objectRef.current = normalizedObject;
        renderRef.current?.();
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Model preview failed.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadModel();

    return () => {
      cancelled = true;
    };
  }, [source]);

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.altKey) {
      return;
    }

    event.preventDefault();
    onOrbitChange({ ...orbit, distance: clamp(orbit.distance + (event.deltaY > 0 ? 0.28 : -0.28), MIN_DISTANCE, MAX_DISTANCE) });
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

  const handleDoubleClick = () => onOrbitChange(DEFAULT_ORBIT);

  return (
    <div className="model-pane-card">
      <div className="preview-panel__header model-pane-card__header">
        <div>
          <strong>{source?.assetLabel ?? "Model preview"}</strong>
          <p className="preview-panel__meta model-pane-card__meta">
            {[source?.format?.toUpperCase(), caption].filter(Boolean).join(" • ")}
          </p>
        </div>
      </div>

      {source?.notes.length ? <p className="muted">{source.notes[0]}</p> : null}
      {loading ? <p className="muted">Loading model preview...</p> : null}
      {error ? <p className="muted">{error}</p> : null}

      <div
        className="preview-frame model-pane-card__frame"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
      >
        <canvas ref={canvasRef} className="model-preview-canvas" />
      </div>
    </div>
  );
}

async function loadModelSource(source: ModelPreviewSource, resourceUrls: string[]) {
  const bytes = decodeBase64(source.encodedBytesBase64);

  switch (source.format) {
    case "glb":
    case "gltf":
      return loadGltf(bytes, source, resourceUrls);
    case "fbx":
      return loadFbx(bytes, source, resourceUrls);
    case "obj":
      return loadObj(bytes, source, resourceUrls);
    default:
      throw new Error(`${source.format.toUpperCase()} preview is not available in this slice.`);
  }
}

async function loadGltf(bytes: Uint8Array, source: ModelPreviewSource, resourceUrls: string[]) {
  const resourceMap = createResourceUrlMap(source.externalResources, resourceUrls);
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => resourceMap.get(url) ?? resourceMap.get(decodeURIComponent(url)) ?? url);
  const loader = new GLTFLoader(manager);

  return new Promise<THREE.Object3D>((resolve, reject) => {
    loader.parse(toOwnedArrayBuffer(bytes), "", (gltf) => resolve(gltf.scene || gltf.scenes[0]), reject);
  });
}

async function loadFbx(bytes: Uint8Array, _source: ModelPreviewSource, _resourceUrls: string[]) {
  const loader = new FBXLoader();
  return loader.parse(toOwnedArrayBuffer(bytes), "") as THREE.Object3D;
}

async function loadObj(bytes: Uint8Array, source: ModelPreviewSource, resourceUrls: string[]) {
  const resourceMap = createResourceUrlMap(source.externalResources, resourceUrls);
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => resourceMap.get(url) ?? resourceMap.get(decodeURIComponent(url)) ?? url);

  const objText = new TextDecoder().decode(bytes);
  const mtlResource = source.externalResources.find((resource) => resource.uri.toLowerCase().endsWith(".mtl"));
  const objLoader = new OBJLoader(manager);

  if (mtlResource) {
    const mtlLoader = new MTLLoader(manager);
    const materials = mtlLoader.parse(new TextDecoder().decode(decodeBase64(mtlResource.encodedBytesBase64)), "");
    materials.preload();
    objLoader.setMaterials(materials);
  }

  return objLoader.parse(objText);
}

function createResourceUrlMap(resources: ModelPreviewSource["externalResources"], resourceUrls: string[]) {
  const resourceMap = new Map<string, string>();
  for (const resource of resources) {
    const blob = new Blob([toOwnedUint8Array(decodeBase64(resource.encodedBytesBase64))], { type: resource.mimeType || "application/octet-stream" });
    const objectUrl = URL.createObjectURL(blob);
    resourceUrls.push(objectUrl);
    resourceMap.set(resource.uri, objectUrl);
  }
  return resourceMap;
}

function fitObjectToPreview(object: THREE.Object3D) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxAxis = Math.max(size.x, size.y, size.z) || 1;
  const scale = 2.4 / maxAxis;

  const pivot = new THREE.Group();
  pivot.add(object);
  object.position.sub(center);
  pivot.scale.setScalar(scale);
  return pivot;
}

function clearObject(scene: THREE.Scene, object: THREE.Object3D | null) {
  if (!object) {
    return;
  }
  scene.remove(object);
  disposeObject3D(object);
}

function disposeObject3D(object: THREE.Object3D) {
  object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }

    if (mesh.material) {
      disposeMaterial(mesh.material);
    }
  });
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

function revokeResourceUrls(urls: string[]) {
  for (const url of urls) {
    URL.revokeObjectURL(url);
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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}