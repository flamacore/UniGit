import clsx from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type {
  FilePreview,
  UnityColorValue,
  UnityMaterialPreviewSource,
  UnityMaterialProperty,
  UnityMaterialTexturePreview,
} from "../../features/repositories/api";
import { decodeBase64, decodeImageBytes, imageDataToCanvas } from "../utils/previewDecode";
import { applyStudioLighting, clamp, disposeMaterial } from "../utils/threePreview";

type ViewerMode = { kind: "single"; sourceKey: string } | { kind: "compare"; presetKey: string };
type PreviewShape = "sphere" | "box" | "cylinder" | "plane";
type OrbitState = { rotationX: number; rotationY: number; distance: number };

const DEFAULT_ORBIT: OrbitState = { rotationX: 0.28, rotationY: -0.55, distance: 3.2 };
const MIN_DISTANCE = 1.6;
const MAX_DISTANCE = 7;
const SHAPES: PreviewShape[] = ["sphere", "box", "cylinder", "plane"];
const BLEND_LABELS: Record<string, string> = {
  opaque: "Opaque",
  cutout: "Alpha cutout",
  alpha: "Alpha blended",
  premultiply: "Premultiplied alpha",
  additive: "Additive",
  multiply: "Multiply",
};
const ROLE_LABELS: Record<string, string> = {
  baseMap: "base map",
  baseColor: "base color",
  normalMap: "normal map",
  emissionMap: "emission map",
  emissionColor: "emission",
  metallicMap: "metallic map",
  maskMap: "mask map",
  occlusionMap: "occlusion",
  metallic: "metallic",
  smoothness: "smoothness",
  roughness: "roughness",
  cutoff: "alpha cutoff",
  normalScale: "normal strength",
  occlusionStrength: "occlusion strength",
};

export function UnityMaterialPreviewCompare({ preview }: { preview: FilePreview }) {
  const sourceMap = useMemo(() => new Map(preview.unityMaterialSources.map((source) => [source.key, source])), [preview.unityMaterialSources]);
  const defaultSingleSourceKey = sourceMap.has("workingTree") ? "workingTree" : preview.unityMaterialSources[0]?.key ?? null;
  const [shape, setShape] = useState<PreviewShape>("sphere");
  const [orbit, setOrbit] = useState<OrbitState>(DEFAULT_ORBIT);
  const [viewerMode, setViewerMode] = useState<ViewerMode | null>(null);

  useEffect(() => {
    if (preview.defaultUnityMaterialComparisonPresetKey) {
      setViewerMode({ kind: "compare", presetKey: preview.defaultUnityMaterialComparisonPresetKey });
    } else {
      setViewerMode(defaultSingleSourceKey ? { kind: "single", sourceKey: defaultSingleSourceKey } : null);
    }

    const hint = preview.unityMaterialSources[0]?.previewShapeHint;
    setShape(SHAPES.includes(hint as PreviewShape) ? (hint as PreviewShape) : "sphere");
  }, [defaultSingleSourceKey, preview.defaultUnityMaterialComparisonPresetKey, preview.relativePath, preview.unityMaterialSources]);

  useEffect(() => {
    setOrbit(DEFAULT_ORBIT);
  }, [viewerMode]);

  const activePreset = viewerMode?.kind === "compare"
    ? preview.unityMaterialComparisonPresets.find((preset) => preset.key === viewerMode.presetKey) ?? null
    : null;
  const beforeSource = activePreset ? sourceMap.get(activePreset.leftSourceKey) ?? null : null;
  const currentSource = activePreset
    ? sourceMap.get(activePreset.rightSourceKey) ?? null
    : viewerMode?.kind === "single" ? sourceMap.get(viewerMode.sourceKey) ?? null : null;

  if (preview.unityMaterialSources.length === 0) {
    return (
      <div className="preview-frame preview-frame--placeholder">
        <p>{preview.supportHint}</p>
      </div>
    );
  }

  const paneProps = { shape, orbit, onOrbitChange: setOrbit };

  return (
    <div className="material-preview-workbench">
      <div className="material-preview-toolbar">
        {defaultSingleSourceKey ? (
          <button
            className={clsx("ghost-button", viewerMode?.kind === "single" && "ghost-button--active")}
            onClick={() => setViewerMode({ kind: "single", sourceKey: defaultSingleSourceKey })}
          >
            Current material
          </button>
        ) : null}
        {preview.unityMaterialComparisonPresets.map((preset) => (
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
        <span className="segmented" title="Preview mesh">
          {SHAPES.map((option) => (
            <button key={option} className={clsx(shape === option && "segmented__active")} onClick={() => setShape(option)}>
              {option[0].toUpperCase()}{option.slice(1)}
            </button>
          ))}
        </span>
      </div>

      {beforeSource && currentSource ? (
        <div className="material-compare-grid">
          <MaterialPane source={beforeSource} {...paneProps} />
          <MaterialPane source={currentSource} {...paneProps} />
        </div>
      ) : currentSource ? (
        <div className="material-single-grid">
          <MaterialPane source={currentSource} {...paneProps} />
        </div>
      ) : null}

      {currentSource?.notes.length ? (
        <div className="preview-notes">
          <strong>Not shown in this preview</strong>
          <ul>
            {currentSource.notes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        </div>
      ) : null}

      {currentSource ? <MaterialPropertyTable current={currentSource} before={beforeSource} /> : null}
    </div>
  );
}

function MaterialPropertyTable({ current, before }: { current: UnityMaterialPreviewSource; before: UnityMaterialPreviewSource | null }) {
  const [showHidden, setShowHidden] = useState(false);
  const beforeByName = useMemo(() => new Map((before?.properties ?? []).map((property) => [property.name, property])), [before]);
  const rows = useMemo(() => {
    const currentNames = new Set(current.properties.map((property) => property.name));
    const removed = (before?.properties ?? []).filter((property) => !currentNames.has(property.name));

    return [
      ...current.properties.map((property) => {
        const previous = beforeByName.get(property.name);
        return { property, previous, changed: Boolean(before) && previous?.value !== property.value };
      }),
      ...removed.map((property) => ({ property: { ...property, value: "removed" }, previous: property, changed: true })),
    ];
  }, [before, beforeByName, current.properties]);

  const changedCount = rows.filter((row) => row.changed).length;
  const hiddenCount = rows.filter((row) => row.property.hidden && !row.changed).length;
  const visibleRows = rows.filter((row) => showHidden || row.changed || !row.property.hidden);

  return (
    <div className="material-properties">
      <div className="preview-panel__header">
        <strong>
          Shader properties
          {before ? <span className="preview-panel__meta"> {changedCount === 0 ? "no changes" : `${changedCount} changed`}</span> : null}
        </strong>
        {hiddenCount > 0 ? (
          <button className="ghost-button" onClick={() => setShowHidden((value) => !value)}>
            {showHidden ? "Hide internal" : `Show internal (${hiddenCount})`}
          </button>
        ) : null}
      </div>
      <div className="material-properties__table" role="table">
        {visibleRows.map(({ property, previous, changed }) => (
          <div key={property.name} role="row" className={clsx("material-property", changed && "material-property--changed", property.isDefault && !changed && "material-property--default")}>
            <div className="material-property__name" title={property.name}>
              <strong>{property.displayName || property.name}</strong>
              <small>
                {property.name}
                {property.role ? <span className="preview-chip preview-chip--accent">{ROLE_LABELS[property.role] ?? property.role}</span> : null}
              </small>
            </div>
            {before ? <PropertyValue property={previous} /> : null}
            <PropertyValue property={property} />
          </div>
        ))}
      </div>
    </div>
  );
}

function PropertyValue({ property }: { property: UnityMaterialProperty | undefined }) {
  if (!property) {
    return <div className="material-property__value muted">not present</div>;
  }

  return (
    <div className="material-property__value" title={property.value}>
      {property.color ? <span className="material-property__swatch" style={{ background: toCssColor(property.color) }} /> : null}
      <span>{property.value}</span>
      {property.isDefault ? <small>default</small> : null}
    </div>
  );
}

function MaterialPane({
  source,
  shape,
  orbit,
  onOrbitChange,
}: {
  source: UnityMaterialPreviewSource;
  shape: PreviewShape;
  orbit: OrbitState;
  onOrbitChange: (value: OrbitState) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const renderRef = useRef<(() => void) | null>(null);
  const orbitRef = useRef(orbit);
  const dragStateRef = useRef<{ pointerId: number; startX: number; startY: number; rotationX: number; rotationY: number } | null>(null);
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
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    const disposeLighting = applyStudioLighting(renderer, scene);
    sceneRef.current = scene;

    const renderScene = () => {
      const width = canvas.clientWidth || 320;
      const height = canvas.clientHeight || 320;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      camera.position.set(0, 0.4, orbitRef.current.distance);
      camera.lookAt(0, 0, 0);

      if (meshRef.current) {
        meshRef.current.rotation.x = orbitRef.current.rotationX;
        meshRef.current.rotation.y = orbitRef.current.rotationY;
      }

      renderer.render(scene, camera);
    };

    renderRef.current = renderScene;
    renderScene();

    const resizeObserver = new ResizeObserver(() => renderScene());
    resizeObserver.observe(canvas);

    return () => {
      resizeObserver.disconnect();
      renderRef.current = null;
      meshRef.current?.geometry.dispose();
      disposeMaterial(meshRef.current?.material);
      meshRef.current = null;
      disposeLighting();
      renderer.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    orbitRef.current = orbit;
    renderRef.current?.();
  }, [orbit]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) {
      return;
    }

    let cancelled = false;

    const loadMaterial = async () => {
      setLoading(true);
      setError(null);

      try {
        const material = await buildThreeMaterial(source);
        if (cancelled) {
          disposeMaterial(material);
          return;
        }

        if (meshRef.current) {
          scene.remove(meshRef.current);
          meshRef.current.geometry.dispose();
          disposeMaterial(meshRef.current.material);
        }

        const mesh = new THREE.Mesh(createPreviewGeometry(shape), material);
        scene.add(mesh);
        meshRef.current = mesh;
        renderRef.current?.();
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "This material could not be previewed.");
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
    onOrbitChange({ ...orbit, distance: clamp(orbit.distance + (event.deltaY > 0 ? 0.24 : -0.24), MIN_DISTANCE, MAX_DISTANCE) });
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
      rotationX: clamp(dragState.rotationX + (event.clientY - dragState.startY) * 0.012, -1.2, 1.2),
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
    <div className="material-pane-card">
      <div className="preview-panel__header material-pane-card__header">
        <strong>{source.label}</strong>
        <span className="preview-panel__meta" title={source.shaderPath ?? undefined}>{source.shaderLabel}</span>
      </div>

      <div className="preview-chips">
        <span className="preview-chip">{source.shaderFamily === "unlit" ? "Unlit" : "Lit"}</span>
        <span className="preview-chip">{BLEND_LABELS[source.surfaceKind] ?? source.surfaceKind}</span>
        {source.doubleSided ? <span className="preview-chip">Two sided</span> : null}
        {source.emissionEnabled ? <span className="preview-chip">Emissive</span> : null}
        <span className="preview-chip">{source.shaderSource === "Not found" ? "Shader not found" : source.shaderSource}</span>
      </div>

      {loading ? <p className="muted">Building material...</p> : null}
      {error ? <p className="preview-note preview-note--warning">{error}</p> : null}

      <div
        className="preview-frame material-pane-card__frame"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={() => onOrbitChange(DEFAULT_ORBIT)}
      >
        <canvas ref={canvasRef} className="material-preview-canvas" />
      </div>
    </div>
  );
}

function createPreviewGeometry(shape: PreviewShape) {
  switch (shape) {
    case "box":
      return new THREE.BoxGeometry(1.65, 1.65, 1.65);
    case "cylinder":
      return new THREE.CylinderGeometry(0.9, 0.9, 1.9, 48);
    case "plane":
      return new THREE.PlaneGeometry(2.2, 2.2);
    default:
      return new THREE.SphereGeometry(1.1, 64, 64);
  }
}

async function buildThreeMaterial(source: UnityMaterialPreviewSource) {
  const [tilingX, tilingY, offsetX, offsetY] = source.baseTiling ?? [1, 1, 0, 0];
  const toTexture = (imageData: ImageData, colorSpace: THREE.ColorSpace) => {
    const texture = new THREE.CanvasTexture(imageDataToCanvas(imageData));
    texture.colorSpace = colorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(tilingX, tilingY);
    texture.offset.set(offsetX, offsetY);
    return texture;
  };
  const decode = async (key: string | null) => {
    const texture = key ? source.textures.find((entry) => entry.key === key) : null;
    return texture ? decodeTexture(texture) : null;
  };

  const [baseImage, normalImage, emissionImage, metallicImage, occlusionImage] = await Promise.all([
    decode(source.baseTextureKey),
    decode(source.normalTextureKey),
    decode(source.emissionTextureKey),
    decode(source.metallicTextureKey),
    decode(source.occlusionTextureKey),
  ]);

  const baseColor = source.baseColor ?? { r: 1, g: 1, b: 1, a: 1 };
  const blended = ["alpha", "premultiply", "additive", "multiply"].includes(source.surfaceKind);
  const shared = {
    color: new THREE.Color().setRGB(baseColor.r, baseColor.g, baseColor.b, THREE.SRGBColorSpace),
    map: baseImage ? toTexture(baseImage, THREE.SRGBColorSpace) : null,
    transparent: blended,
    opacity: source.surfaceKind === "alpha" || source.surfaceKind === "premultiply" ? baseColor.a : 1,
    premultipliedAlpha: source.surfaceKind === "premultiply",
    blending: source.surfaceKind === "additive"
      ? THREE.AdditiveBlending
      : source.surfaceKind === "multiply" ? THREE.MultiplyBlending : THREE.NormalBlending,
    depthWrite: !blended,
    alphaTest: source.cutoff ?? 0,
    side: source.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  };

  if (source.shaderFamily === "unlit") {
    return new THREE.MeshBasicMaterial(shared);
  }

  // Unity packs metallic in R and smoothness in A (plus occlusion in G for HDRP mask maps);
  // three.js reads occlusion from R, roughness from G and metalness from B.
  const smoothnessScale = clamp(source.smoothness ?? 1, 0, 1);
  const packed = metallicImage ? repackChannels(metallicImage, (r, g, _b, a) => [
    source.metallicTextureLayout === "mask" ? g : 255,
    255 - a * smoothnessScale,
    r,
  ]) : null;
  const packedTexture = packed ? toTexture(packed, THREE.NoColorSpace) : null;
  const occlusionTexture = occlusionImage
    ? toTexture(repackChannels(occlusionImage, (_r, g) => [g, g, g]), THREE.NoColorSpace)
    : source.metallicTextureLayout === "mask" ? packedTexture : null;

  const emission = source.emissionEnabled ? source.emissionColor ?? { r: 1, g: 1, b: 1, a: 1 } : null;
  const emissionPeak = emission ? Math.max(emission.r, emission.g, emission.b, 1) : 1;
  const normalScale = source.normalScale ?? 1;

  return new THREE.MeshStandardMaterial({
    ...shared,
    normalMap: normalImage ? toTexture(normalImage, THREE.NoColorSpace) : null,
    normalScale: new THREE.Vector2(normalScale, normalScale),
    metalnessMap: packedTexture,
    roughnessMap: packedTexture,
    aoMap: occlusionTexture,
    aoMapIntensity: clamp(source.occlusionStrength ?? 1, 0, 1),
    // With a packed map Unity ignores the sliders, so the map alone drives the result.
    metalness: packedTexture ? 1 : clamp(source.metallic ?? 0, 0, 1),
    roughness: packedTexture ? 1 : 1 - clamp(source.smoothness ?? 0.5, 0, 1),
    emissive: emission
      ? new THREE.Color(emission.r / emissionPeak, emission.g / emissionPeak, emission.b / emissionPeak)
      : new THREE.Color(0, 0, 0),
    emissiveMap: emission && emissionImage ? toTexture(emissionImage, THREE.SRGBColorSpace) : null,
    emissiveIntensity: emission ? emissionPeak : 0,
  });
}

function decodeTexture(texture: UnityMaterialTexturePreview) {
  return decodeImageBytes(decodeBase64(texture.encodedBytesBase64), texture.format, texture.mimeType);
}

function repackChannels(imageData: ImageData, map: (r: number, g: number, b: number, a: number) => [number, number, number]) {
  const output = new Uint8ClampedArray(imageData.data.length);

  for (let index = 0; index < output.length; index += 4) {
    const [r, g, b] = map(imageData.data[index], imageData.data[index + 1], imageData.data[index + 2], imageData.data[index + 3]);
    output[index] = r;
    output[index + 1] = g;
    output[index + 2] = b;
    output[index + 3] = 255;
  }

  return new ImageData(output, imageData.width, imageData.height);
}

function toCssColor(color: UnityColorValue) {
  const peak = Math.max(color.r, color.g, color.b, 1);
  const channel = (value: number) => Math.round(clamp(value / peak, 0, 1) * 255);
  return `rgb(${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)})`;
}
