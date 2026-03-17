import clsx from "clsx";
import { readPsd } from "ag-psd";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FilePreview, ImagePreviewSource } from "../../features/repositories/api";
import { formatFileSize } from "../utils/formatters";

type ChannelMode = "rgba" | "rgb" | "r" | "g" | "b" | "a";
type ViewerMode = { kind: "single"; sourceKey: string } | { kind: "compare"; presetKey: string };
type ImageViewport = { scale: number; offsetX: number; offsetY: number };

const DEFAULT_VIEWPORT: ImageViewport = { scale: 1, offsetX: 0, offsetY: 0 };
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

const CHANNEL_OPTIONS: Array<{ value: ChannelMode; label: string }> = [
  { value: "rgba", label: "RGBA" },
  { value: "rgb", label: "RGB" },
  { value: "r", label: "R" },
  { value: "g", label: "G" },
  { value: "b", label: "B" },
  { value: "a", label: "A" },
];

export function ImagePreviewCompare({ preview }: { preview: FilePreview }) {
  const sourceMap = useMemo(() => new Map(preview.imageSources.map((source) => [source.key, source])), [preview.imageSources]);
  const defaultSingleSourceKey = sourceMap.has("workingTree") ? "workingTree" : preview.imageSources[0]?.key ?? null;
  const [singleChannelMode, setSingleChannelMode] = useState<ChannelMode>("rgba");
  const [compareChannelMode, setCompareChannelMode] = useState<ChannelMode>("rgba");
  const [singleViewport, setSingleViewport] = useState<ImageViewport>(DEFAULT_VIEWPORT);
  const [compareViewport, setCompareViewport] = useState<ImageViewport>(DEFAULT_VIEWPORT);
  const [viewerMode, setViewerMode] = useState<ViewerMode | null>(() => {
    if (preview.defaultImageComparisonPresetKey) {
      return { kind: "compare", presetKey: preview.defaultImageComparisonPresetKey };
    }

    return defaultSingleSourceKey ? { kind: "single", sourceKey: defaultSingleSourceKey } : null;
  });

  useEffect(() => {
    if (preview.defaultImageComparisonPresetKey) {
      setViewerMode({ kind: "compare", presetKey: preview.defaultImageComparisonPresetKey });
      return;
    }

    if (defaultSingleSourceKey) {
      setViewerMode({ kind: "single", sourceKey: defaultSingleSourceKey });
      return;
    }

    setViewerMode(null);
  }, [defaultSingleSourceKey, preview.defaultImageComparisonPresetKey, preview.relativePath]);

  const activePreset = viewerMode?.kind === "compare"
    ? preview.imageComparisonPresets.find((preset) => preset.key === viewerMode.presetKey) ?? null
    : null;
  const singleSource = viewerMode?.kind === "single"
    ? sourceMap.get(viewerMode.sourceKey) ?? null
    : null;

  useEffect(() => {
    setSingleChannelMode("rgba");
    setSingleViewport(DEFAULT_VIEWPORT);
  }, [singleSource?.key]);

  useEffect(() => {
    setCompareChannelMode("rgba");
    setCompareViewport(DEFAULT_VIEWPORT);
  }, [activePreset?.key]);

  if (preview.imageSources.length === 0) {
    return (
      <div className="preview-frame preview-frame--placeholder">
        <p>{preview.supportHint}</p>
      </div>
    );
  }

  return (
    <div className="image-preview-workbench">
      <div className="image-preview-toolbar">
        {defaultSingleSourceKey ? (
          <button
            className={clsx("ghost-button", viewerMode?.kind === "single" && viewerMode.sourceKey === defaultSingleSourceKey && "ghost-button--active")}
            onClick={() => setViewerMode({ kind: "single", sourceKey: defaultSingleSourceKey })}
          >
            Current image
          </button>
        ) : null}
        {preview.imageComparisonPresets.map((preset) => (
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
        <div className="image-compare-grid">
          <ImagePane
            source={sourceMap.get(activePreset.leftSourceKey) ?? null}
            caption={activePreset.description}
            channelMode={compareChannelMode}
            onChannelModeChange={setCompareChannelMode}
            viewport={compareViewport}
            onViewportChange={setCompareViewport}
          />
          <ImagePane
            source={sourceMap.get(activePreset.rightSourceKey) ?? null}
            caption={activePreset.description}
            channelMode={compareChannelMode}
            onChannelModeChange={setCompareChannelMode}
            viewport={compareViewport}
            onViewportChange={setCompareViewport}
          />
        </div>
      ) : singleSource ? (
        <div className="image-single-grid">
          <ImagePane
            source={singleSource}
            channelMode={singleChannelMode}
            onChannelModeChange={setSingleChannelMode}
            viewport={singleViewport}
            onViewportChange={setSingleViewport}
          />
        </div>
      ) : null}
    </div>
  );
}

function ImagePane({
  source,
  caption,
  channelMode,
  onChannelModeChange,
  viewport,
  onViewportChange,
}: {
  source: ImagePreviewSource | null;
  caption?: string;
  channelMode: ChannelMode;
  onChannelModeChange: (value: ChannelMode) => void;
  viewport: ImageViewport;
  onViewportChange: (value: ImageViewport) => void;
}) {
  const [imageData, setImageData] = useState<ImageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ pointerId: number; startX: number; startY: number; offsetX: number; offsetY: number } | null>(null);

  useEffect(() => {
    if (!source) {
      setImageData(null);
      setError("Preview source is unavailable.");
      setLoading(false);
      return;
    }

    let cancelled = false;

    const loadImage = async () => {
      setLoading(true);
      setError(null);

      try {
        const nextImageData = await decodeImageSource(source);
        if (!cancelled) {
          setImageData(nextImageData);
        }
      } catch (reason) {
        if (!cancelled) {
          setImageData(null);
          setError(reason instanceof Error ? reason.message : "Image preview failed.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadImage();

    return () => {
      cancelled = true;
    };
  }, [source]);

  const renderedImageData = useMemo(() => (imageData ? applyChannelMode(imageData, channelMode) : null), [channelMode, imageData]);

  useEffect(() => {
    if (!canvasRef.current || !renderedImageData) {
      return;
    }

    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");

    if (!context) {
      return;
    }

    canvas.width = renderedImageData.width;
    canvas.height = renderedImageData.height;
    context.putImageData(renderedImageData, 0, 0);
  }, [renderedImageData]);

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.altKey) {
      return;
    }

    event.preventDefault();

    const bounds = surfaceRef.current?.getBoundingClientRect();
    if (!bounds) {
      return;
    }

    const zoomFactor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const nextScale = clamp(viewport.scale * zoomFactor, MIN_ZOOM, MAX_ZOOM);

    if (nextScale === viewport.scale) {
      return;
    }

    const pointerX = event.clientX - bounds.left;
    const pointerY = event.clientY - bounds.top;
    const scaleRatio = nextScale / viewport.scale;

    onViewportChange({
      scale: nextScale,
      offsetX: pointerX - (pointerX - viewport.offsetX) * scaleRatio,
      offsetY: pointerY - (pointerY - viewport.offsetY) * scaleRatio,
    });
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: viewport.offsetX,
      offsetY: viewport.offsetY,
    };

    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    onViewportChange({
      scale: viewport.scale,
      offsetX: dragState.offsetX + (event.clientX - dragState.startX),
      offsetY: dragState.offsetY + (event.clientY - dragState.startY),
    });
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId === event.pointerId) {
      dragStateRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleDoubleClick = () => {
    onViewportChange(DEFAULT_VIEWPORT);
  };

  return (
    <div className="image-pane-card">
      <div className="preview-panel__header image-pane-card__header">
        <div>
          <strong>{source?.label ?? "Preview"}</strong>
          {caption ? <p className="preview-panel__meta image-pane-card__caption">{caption}</p> : null}
        </div>
        {source ? <span className="preview-panel__meta">{formatFileSize(source.byteSize)}</span> : null}
      </div>

      <div className="image-channel-toolbar">
        {CHANNEL_OPTIONS.map((option) => (
          <button
            key={option.value}
            className={clsx("ghost-button", channelMode === option.value && "ghost-button--active")}
            onClick={() => onChannelModeChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {loading ? <p className="muted">Loading image preview...</p> : null}
      {error ? <p className="muted">{error}</p> : null}

      {!loading && !error ? (
        <div
          ref={surfaceRef}
          className={clsx("preview-frame image-pane-card__frame", dragStateRef.current && "image-pane-card__frame--dragging")}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onDoubleClick={handleDoubleClick}
        >
          <div
            className="image-preview-transform"
            style={{
              transform: `translate(${viewport.offsetX}px, ${viewport.offsetY}px) scale(${viewport.scale})`,
            }}
          >
            <canvas ref={canvasRef} className="image-preview-canvas" />
          </div>
        </div>
      ) : null}
    </div>
  );
}

async function decodeImageSource(source: ImagePreviewSource): Promise<ImageData> {
  const bytes = decodeBase64(source.encodedBytesBase64);

  if (source.isPsd) {
    const psd = readPsd(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const imageData = (psd as { imageData?: ImageData }).imageData;

    if (imageData) {
      return cloneImageData(imageData);
    }

    const canvas = (psd as { canvas?: HTMLCanvasElement }).canvas;
    if (canvas) {
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("PSD preview canvas could not be initialized.");
      }

      return context.getImageData(0, 0, canvas.width, canvas.height);
    }

    throw new Error("PSD preview data is unavailable for this file.");
  }

  const blob = new Blob([bytes], { type: source.mimeType || "application/octet-stream" });
  const bitmap = await createImageBitmap(blob);

  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Image preview canvas could not be initialized.");
    }

    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, canvas.width, canvas.height);
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

function cloneImageData(imageData: ImageData) {
  return new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
}

function applyChannelMode(imageData: ImageData, channelMode: ChannelMode) {
  if (channelMode === "rgba") {
    return cloneImageData(imageData);
  }

  const next = new Uint8ClampedArray(imageData.data);

  for (let index = 0; index < next.length; index += 4) {
    const red = imageData.data[index];
    const green = imageData.data[index + 1];
    const blue = imageData.data[index + 2];
    const alpha = imageData.data[index + 3];

    switch (channelMode) {
      case "rgb":
        next[index] = red;
        next[index + 1] = green;
        next[index + 2] = blue;
        next[index + 3] = 255;
        break;
      case "r":
        next[index] = red;
        next[index + 1] = 0;
        next[index + 2] = 0;
        next[index + 3] = 255;
        break;
      case "g":
        next[index] = 0;
        next[index + 1] = green;
        next[index + 2] = 0;
        next[index + 3] = 255;
        break;
      case "b":
        next[index] = 0;
        next[index + 1] = 0;
        next[index + 2] = blue;
        next[index + 3] = 255;
        break;
      case "a":
        next[index] = alpha;
        next[index + 1] = alpha;
        next[index + 2] = alpha;
        next[index + 3] = 255;
        break;
      default:
        break;
    }
  }

  return new ImageData(next, imageData.width, imageData.height);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}