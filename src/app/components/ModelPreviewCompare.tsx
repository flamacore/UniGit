import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import type { FilePreview, ModelPreviewSource } from "../../features/repositories/api";
import { decodeBase64, toArrayBuffer } from "../utils/previewDecode";
import { applyStudioLighting, clamp, disposeMaterial } from "../utils/threePreview";

type ViewerMode = { kind: "single"; sourceKey: string } | { kind: "compare"; presetKey: string };
type OrbitState = { rotationX: number; rotationY: number; distance: number };
type LoadedModel = { object: THREE.Object3D; animations: THREE.AnimationClip[] };
type ModelStats = {
  meshes: number;
  vertices: number;
  triangles: number;
  materials: number;
  textures: number;
  bones: number;
  skinnedMeshes: number;
  blendShapes: number;
  animations: Array<{ name: string; duration: number }>;
  size: [number, number, number];
  hasUvs: boolean;
  hasNormals: boolean;
  hasVertexColors: boolean;
};

const DEFAULT_ORBIT: OrbitState = { rotationX: 0.3, rotationY: -0.55, distance: 4.2 };
const MIN_DISTANCE = 1.2;
const MAX_DISTANCE = 14;
// Stand-in for texture files an FBX points at but the repository preview does not load.
const BLANK_PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

export function ModelPreviewCompare({ preview }: { preview: FilePreview }) {
  const sourceMap = useMemo(() => new Map(preview.modelSources.map((source) => [source.key, source])), [preview.modelSources]);
  const defaultSingleSourceKey = sourceMap.has("workingTree") ? "workingTree" : preview.modelSources[0]?.key ?? null;
  const [orbit, setOrbit] = useState<OrbitState>(DEFAULT_ORBIT);
  const [wireframe, setWireframe] = useState(false);
  const [statsByKey, setStatsByKey] = useState<Record<string, ModelStats>>({});
  const [viewerMode, setViewerMode] = useState<ViewerMode | null>(null);

  useEffect(() => {
    if (preview.defaultModelComparisonPresetKey) {
      setViewerMode({ kind: "compare", presetKey: preview.defaultModelComparisonPresetKey });
    } else {
      setViewerMode(defaultSingleSourceKey ? { kind: "single", sourceKey: defaultSingleSourceKey } : null);
    }
    setStatsByKey({});
  }, [defaultSingleSourceKey, preview.defaultModelComparisonPresetKey, preview.relativePath]);

  useEffect(() => {
    setOrbit(DEFAULT_ORBIT);
  }, [viewerMode]);

  const handleStats = useCallback((key: string, stats: ModelStats) => {
    setStatsByKey((current) => ({ ...current, [key]: stats }));
  }, []);

  const activePreset = viewerMode?.kind === "compare"
    ? preview.modelComparisonPresets.find((preset) => preset.key === viewerMode.presetKey) ?? null
    : null;
  const singleSource = viewerMode?.kind === "single" ? sourceMap.get(viewerMode.sourceKey) ?? null : null;

  if (preview.modelSources.length === 0) {
    return (
      <div className="preview-frame preview-frame--placeholder">
        <p>{preview.supportHint}</p>
      </div>
    );
  }

  const paneProps = { orbit, onOrbitChange: setOrbit, wireframe, onStats: handleStats };

  return (
    <div className="model-preview-workbench">
      <div className="model-preview-toolbar">
        {defaultSingleSourceKey ? (
          <button
            className={clsx("ghost-button", viewerMode?.kind === "single" && "ghost-button--active")}
            onClick={() => setViewerMode({ kind: "single", sourceKey: defaultSingleSourceKey })}
          >
            Current model
          </button>
        ) : null}
        {preview.modelComparisonPresets.map((preset) => (
          <button
            key={preset.key}
            className={clsx("ghost-button", viewerMode?.kind === "compare" && viewerMode.presetKey === preset.key && "ghost-button--active")}
            title={preset.description}
            onClick={() => setViewerMode({ kind: "compare", presetKey: preset.key })}
          >
            {preset.label}
          </button>
        ))}
        <span className="preview-toolbar__spacer" />
        <button className={clsx("ghost-button", wireframe && "ghost-button--active")} onClick={() => setWireframe((value) => !value)}>
          Wireframe
        </button>
      </div>

      {activePreset ? (
        <div className="model-compare-grid">
          <ModelPane source={sourceMap.get(activePreset.leftSourceKey) ?? null} stats={statsByKey[activePreset.leftSourceKey]} {...paneProps} />
          <ModelPane
            source={sourceMap.get(activePreset.rightSourceKey) ?? null}
            stats={statsByKey[activePreset.rightSourceKey]}
            baseline={statsByKey[activePreset.leftSourceKey]}
            {...paneProps}
          />
        </div>
      ) : singleSource ? (
        <div className="model-single-grid">
          <ModelPane source={singleSource} stats={statsByKey[singleSource.key]} {...paneProps} />
        </div>
      ) : null}
    </div>
  );
}

function ModelPane({
  source,
  stats,
  baseline,
  orbit,
  onOrbitChange,
  wireframe,
  onStats,
}: {
  source: ModelPreviewSource | null;
  stats?: ModelStats;
  baseline?: ModelStats;
  orbit: OrbitState;
  onOrbitChange: (value: OrbitState) => void;
  wireframe: boolean;
  onStats: (key: string, stats: ModelStats) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const objectRef = useRef<THREE.Object3D | null>(null);
  const renderRef = useRef<(() => void) | null>(null);
  const orbitRef = useRef(orbit);
  const wireframeRef = useRef(wireframe);
  const dragStateRef = useRef<{ pointerId: number; startX: number; startY: number; rotationX: number; rotationY: number } | null>(null);
  const resourceUrlsRef = useRef<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    const disposeLighting = applyStudioLighting(renderer, scene);

    const grid = new THREE.GridHelper(8, 16, 0x4a6aa5, 0x2a3650);
    grid.position.y = -1.25;
    scene.add(grid);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;

    const renderScene = () => {
      const width = canvas.clientWidth || 320;
      const height = canvas.clientHeight || 320;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      camera.position.set(0, 0.6, orbitRef.current.distance);
      camera.lookAt(0, 0, 0);

      if (objectRef.current) {
        objectRef.current.rotation.x = orbitRef.current.rotationX;
        objectRef.current.rotation.y = orbitRef.current.rotationY;
      }

      renderer.render(scene, camera);
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
      disposeLighting();
      renderer.dispose();
      renderRef.current = null;
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
    };
  }, []);

  useEffect(() => {
    orbitRef.current = orbit;
    renderRef.current?.();
  }, [orbit]);

  useEffect(() => {
    wireframeRef.current = wireframe;
    setWireframe(objectRef.current, wireframe);
    renderRef.current?.();
  }, [wireframe]);

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
        const model = await loadModelSource(source, resourceUrlsRef.current);
        if (cancelled) {
          disposeObject3D(model.object);
          return;
        }

        onStats(source.key, measureModel(model));
        clearObject(scene, objectRef.current);
        const fitted = fitObjectToPreview(model.object);
        setWireframe(fitted, wireframeRef.current);
        scene.add(fitted);
        objectRef.current = fitted;
        renderRef.current?.();
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "This model could not be loaded.");
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
  }, [onStats, source]);

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

    onOrbitChange({
      ...orbit,
      rotationX: clamp(dragState.rotationX + (event.clientY - dragState.startY) * 0.012, -1.4, 1.4),
      rotationY: dragState.rotationY + (event.clientX - dragState.startX) * 0.012,
    });
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId === event.pointerId) {
      dragStateRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="model-pane-card">
      <div className="preview-panel__header model-pane-card__header">
        <strong>{source?.label ?? "Model"}</strong>
        <span className="preview-panel__meta">{source ? `${source.assetLabel} (${source.format.toUpperCase()})` : ""}</span>
      </div>

      {loading ? <p className="muted">Loading model...</p> : null}
      {error ? <p className="preview-note preview-note--warning">{error}</p> : null}

      <div
        className="preview-frame model-pane-card__frame"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={() => onOrbitChange(DEFAULT_ORBIT)}
      >
        <canvas ref={canvasRef} className="model-preview-canvas" />
      </div>

      {stats ? <ModelStatsTable stats={stats} baseline={baseline} /> : null}
      {source?.notes.map((note) => <p key={note} className="preview-note">{note}</p>)}
    </div>
  );
}

function ModelStatsTable({ stats, baseline }: { stats: ModelStats; baseline?: ModelStats }) {
  const count = (label: string, pick: (value: ModelStats) => number) => {
    const value = pick(stats);
    const delta = baseline ? value - pick(baseline) : 0;

    return (
      <div key={label}>
        <dt>{label}</dt>
        <dd>
          {value.toLocaleString()}
          {delta !== 0 ? <span className={clsx("preview-delta", delta > 0 ? "preview-delta--up" : "preview-delta--down")}>{delta > 0 ? "+" : ""}{delta.toLocaleString()}</span> : null}
        </dd>
      </div>
    );
  };
  const attributes = [stats.hasUvs && "UVs", stats.hasNormals && "normals", stats.hasVertexColors && "vertex colors"].filter(Boolean);

  return (
    <dl className="preview-details">
      {count("Triangles", (value) => value.triangles)}
      {count("Vertices", (value) => value.vertices)}
      {count("Meshes", (value) => value.meshes)}
      {count("Materials", (value) => value.materials)}
      {stats.textures > 0 || baseline?.textures ? count("Textures", (value) => value.textures) : null}
      {stats.bones > 0 || baseline?.bones ? count("Bones", (value) => value.bones) : null}
      {stats.blendShapes > 0 || baseline?.blendShapes ? count("Blend shapes", (value) => value.blendShapes) : null}
      <div>
        <dt>Size (x, y, z)</dt>
        <dd>{stats.size.map((axis) => formatLength(axis)).join(" x ")}</dd>
      </div>
      <div>
        <dt>Vertex data</dt>
        <dd>{attributes.length > 0 ? attributes.join(", ") : "positions only"}</dd>
      </div>
      {stats.animations.length > 0 ? (
        <div className="preview-details__wide">
          <dt>Animations ({stats.animations.length})</dt>
          <dd>{stats.animations.slice(0, 6).map((clip) => `${clip.name || "unnamed"} ${clip.duration.toFixed(2)}s`).join(", ")}{stats.animations.length > 6 ? ", ..." : ""}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function formatLength(value: number) {
  return value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : value.toPrecision(2);
}

function measureModel({ object, animations }: LoadedModel): ModelStats {
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const stats: ModelStats = {
    meshes: 0,
    vertices: 0,
    triangles: 0,
    materials: 0,
    textures: 0,
    bones: 0,
    skinnedMeshes: 0,
    blendShapes: 0,
    animations: animations.map((clip) => ({ name: clip.name, duration: clip.duration })),
    size: [0, 0, 0],
    hasUvs: false,
    hasNormals: false,
    hasVertexColors: false,
  };

  object.updateMatrixWorld(true);
  object.traverse((node) => {
    if ((node as THREE.Bone).isBone) {
      stats.bones += 1;
    }

    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) {
      return;
    }

    const { attributes, index, morphAttributes } = mesh.geometry;
    const vertexCount = attributes.position?.count ?? 0;
    stats.meshes += 1;
    stats.vertices += vertexCount;
    stats.triangles += Math.floor((index ? index.count : vertexCount) / 3);
    stats.skinnedMeshes += (mesh as THREE.SkinnedMesh).isSkinnedMesh ? 1 : 0;
    stats.blendShapes += morphAttributes.position?.length ?? 0;
    stats.hasUvs ||= Boolean(attributes.uv);
    stats.hasNormals ||= Boolean(attributes.normal);
    stats.hasVertexColors ||= Boolean(attributes.color);

    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!material) {
        continue;
      }
      materials.add(material);
      for (const value of Object.values(material as unknown as Record<string, unknown>)) {
        if (value instanceof THREE.Texture) {
          textures.add(value);
        }
      }
    }
  });

  const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
  stats.size = [size.x, size.y, size.z];
  stats.materials = materials.size;
  stats.textures = textures.size;
  return stats;
}

function setWireframe(object: THREE.Object3D | null, enabled: boolean) {
  object?.traverse((node) => {
    const mesh = node as THREE.Mesh;
    for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) {
      (material as THREE.MeshStandardMaterial).wireframe = enabled;
    }
  });
}

async function loadModelSource(source: ModelPreviewSource, resourceUrls: string[]): Promise<LoadedModel> {
  const bytes = decodeBase64(source.encodedBytesBase64);
  const resourceMap = createResourceUrlMap(source.externalResources, resourceUrls);
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith("blob:") || url.startsWith("data:")) {
      return url;
    }
    return resourceMap.get(url) ?? resourceMap.get(decodeURIComponent(url)) ?? BLANK_PIXEL;
  });

  switch (source.format) {
    case "glb":
    case "gltf":
      return new Promise<LoadedModel>((resolve, reject) => {
        new GLTFLoader(manager).parse(
          toArrayBuffer(bytes),
          "",
          (gltf) => resolve({ object: gltf.scene || gltf.scenes[0], animations: gltf.animations ?? [] }),
          (failure) => reject(failure instanceof Error ? failure : new Error("This glTF file could not be parsed.")),
        );
      });
    case "fbx": {
      const object = new FBXLoader(manager).parse(toArrayBuffer(bytes), "");
      return { object, animations: object.animations ?? [] };
    }
    case "obj": {
      const objLoader = new OBJLoader(manager);
      const mtlResource = source.externalResources.find((resource) => resource.uri.toLowerCase().endsWith(".mtl"));

      if (mtlResource) {
        const materials = new MTLLoader(manager).parse(new TextDecoder().decode(decodeBase64(mtlResource.encodedBytesBase64)), "");
        materials.preload();
        objLoader.setMaterials(materials);
      }

      return { object: objLoader.parse(new TextDecoder().decode(bytes)), animations: [] };
    }
    default:
      throw new Error(`${source.format.toUpperCase()} files cannot be previewed.`);
  }
}

function createResourceUrlMap(resources: ModelPreviewSource["externalResources"], resourceUrls: string[]) {
  const resourceMap = new Map<string, string>();
  for (const resource of resources) {
    const blob = new Blob([toArrayBuffer(decodeBase64(resource.encodedBytesBase64))], { type: resource.mimeType || "application/octet-stream" });
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

  const pivot = new THREE.Group();
  pivot.add(object);
  object.position.sub(center);
  pivot.scale.setScalar(2.4 / maxAxis);
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
    mesh.geometry?.dispose();
    disposeMaterial(mesh.material);
  });
}

function revokeResourceUrls(urls: string[]) {
  for (const url of urls) {
    URL.revokeObjectURL(url);
  }
}
