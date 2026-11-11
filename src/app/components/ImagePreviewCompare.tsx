import clsx from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FilePreview, ImagePreviewSource } from "../../features/repositories/api";
import { formatFileSize } from "../utils/formatters";
import { decodeBase64, decodeImageBytes } from "../utils/previewDecode";
import { clamp } from "../utils/threePreview";

type ChannelMode = "rgba" | "rgb" | "r" | "g" | "b" | "a";
type ViewerMode = { kind: "single"; sourceKey: string } | { kind: "compare"; presetKey: string };
type CompareLayout = "side" | "difference";
type ImageViewport = { scale: number; offsetX: number; offsetY: number };
type DecodedImage = { imageData: ImageData | null; error: string | null; loading: boolean };

const DEFAULT_VIEWPORT: ImageViewport = { scale: 1, offsetX: 0, offsetY: 0 };
const MIN_ZOOM = 1;
const MAX_ZOOM = 16;

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
  const [channelMode, setChannelMode] = useState<ChannelMode>("rgba");
  const [viewport, setViewport] = useState<ImageViewport>(DEFAULT_VIEWPORT);
  const [compareLayout, setCompareLayout] = useState<CompareLayout>("side");
  const [viewerMode, setViewerMode] = useState<ViewerMode | null>(null);

  useEffect(() => {
    if (preview.defaultImageComparisonPresetKey) {
      setViewerMode({ kind: "compare", presetKey: preview.defaultImageComparisonPresetKey });
    } else {
      setViewerMode(defaultSingleSourceKey ? { kind: "single", sourceKey: defaultSingleSourceKey } : null);
    }
  }, [defaultSingleSourceKey, preview.defaultImageComparisonPresetKey, preview.relativePath]);

  const activePreset = viewerMode?.kind === "compare"
    ? preview.imageComparisonPresets.find((preset) => preset.key === viewerMode.presetKey) ?? null
    : null;
  const beforeSource = activePreset ? sourceMap.get(activePreset.leftSourceKey) ?? null : null;
  const currentSource = activePreset
    ? sourceMap.get(activePreset.rightSourceKey) ?? null
    : viewerMode?.kind === "single" ? sourceMap.get(viewerMode.sourceKey) ?? null : null;

  const before = useDecodedImage(beforeSource);
  const current = useDecodedImage(currentSource);
  const difference = useMemo(
    () => (activePreset && before.imageData && current.imageData ? diffImages(before.imageData, current.imageData) : null),
    [activePreset, before.imageData, current.imageData],
  );

  useEffect(() => {
    setChannelMode("rgba");
    setViewport(DEFAULT_VIEWPORT);
  }, [viewerMode]);

  if (preview.imageSources.length === 0) {
    return (
      <div className="preview-frame preview-frame--placeholder">
        <p>{preview.supportHint}</p>
      </div>
    );
  }

  const paneProps = { channelMode, viewport, onViewportChange: setViewport };

  return (
    <div className="image-preview-workbench">
      <div className="image-preview-toolbar">
        {defaultSingleSourceKey ? (
          <button
            className={clsx("ghost-button", viewerMode?.kind === "single" && "ghost-button--active")}
            onClick={() => setViewerMode({ kind: "single", sourceKey: defaultSingleSourceKey })}
          >
            Current image
          </button>
        ) : null}
        {preview.imageComparisonPresets.map((preset) => (
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

        {activePreset ? (
          <span className="segmented">
            <button className={clsx(compareLayout === "side" && "segmented__active")} onClick={() => setCompareLayout("side")}>Side by side</button>
            <button className={clsx(compareLayout === "difference" && "segmented__active")} onClick={() => setCompareLayout("difference")}>Difference</button>
          </span>
        ) : null}
        <span className="segmented" title="Show a single colour channel">
          {CHANNEL_OPTIONS.map((option) => (
            <button
              key={option.value}
              className={clsx(channelMode === option.value && "segmented__active")}
              onClick={() => setChannelMode(option.value)}
            >
              {option.label}
            </button>
          ))}
        </span>
      </div>

      {activePreset && difference ? (
        <p className="preview-note">
          {difference.sameSize
            ? difference.changedPixels === 0
              ? "The pixels are identical. Only metadata or compression changed."
              : `${formatPercent(difference.changedPixels / difference.totalPixels)} of pixels changed (${difference.changedPixels.toLocaleString()} px), strongest channel shift ${difference.maxDelta}/255.`
            : `Size changed from ${before.imageData?.width} x ${before.imageData?.height} to ${current.imageData?.width} x ${current.imageData?.height}; a pixel difference needs equal sizes.`}
        </p>
      ) : null}

      {activePreset && compareLayout === "difference" && difference?.sameSize ? (
        <div className="image-single-grid">
          <ImagePane
            title="Difference"
            caption="Changed pixels are highlighted from yellow (subtle) to red (strong) over a dimmed copy of the new image."
            decoded={{ imageData: difference.imageData, error: null, loading: false }}
            {...paneProps}
            channelMode="rgba"
          />
        </div>
      ) : activePreset ? (
        <div className="image-compare-grid">
          <ImagePane title={beforeSource?.label ?? "Before"} source={beforeSource} decoded={before} {...paneProps} />
          <ImagePane title={currentSource?.label ?? "After"} source={currentSource} decoded={current} baseline={beforeSource} {...paneProps} />
        </div>
      ) : currentSource ? (
        <div className="image-single-grid">
          <ImagePane title={currentSource.label} source={currentSource} decoded={current} {...paneProps} />
        </div>
      ) : null}
    </div>
  );
}

function useDecodedImage(source: ImagePreviewSource | null): DecodedImage {
  const [state, setState] = useState<DecodedImage>({ imageData: null, error: null, loading: false });

  useEffect(() => {
    if (!source) {
      setState({ imageData: null, error: null, loading: false });
      return;
    }

    let cancelled = false;
    setState({ imageData: null, error: null, loading: true });

    decodeImageBytes(decodeBase64(source.encodedBytesBase64), source.format, source.mimeType)
      .then((imageData) => {
        if (!cancelled) {
          setState({ imageData, error: null, loading: false });
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setState({
            imageData: null,
            error: reason instanceof Error ? reason.message : "This image could not be decoded.",
            loading: false,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [source]);

  return state;
}

function ImagePane({
  title,
  caption,
  source,
  baseline,
  decoded,
  channelMode,
  viewport,
  onViewportChange,
}: {
  title: string;
  caption?: string;
  source?: ImagePreviewSource | null;
  baseline?: ImagePreviewSource | null;
  decoded: DecodedImage;
  channelMode: ChannelMode;
  viewport: ImageViewport;
  onViewportChange: (value: ImageViewport) => void;
}) {
  const { imageData, error, loading } = decoded;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ pointerId: number; startX: number; startY: number; offsetX: number; offsetY: number } | null>(null);

  const renderedImageData = useMemo(() => (imageData ? applyChannelMode(imageData, channelMode) : null), [channelMode, imageData]);
  const facts = useMemo(() => (imageData && source ? describeImage(imageData) : []), [imageData, source]);
  const sizeDelta = source && baseline ? source.byteSize - baseline.byteSize : 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");

    if (!canvas || !context || !renderedImageData) {
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

    const nextScale = clamp(viewport.scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12), MIN_ZOOM, MAX_ZOOM);
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

  return (
    <div className="image-pane-card">
      <div className="preview-panel__header image-pane-card__header">
        <div>
          <strong>{title}</strong>
          {caption ? <p className="preview-panel__meta image-pane-card__caption">{caption}</p> : null}
        </div>
        {source ? (
          <span className="preview-panel__meta">
            {formatFileSize(source.byteSize)}
            {sizeDelta !== 0 ? ` (${sizeDelta > 0 ? "+" : "-"}${formatFileSize(Math.abs(sizeDelta))})` : ""}
          </span>
        ) : null}
      </div>

      {facts.length > 0 ? (
        <div className="preview-chips">
          {facts.map((fact) => <span key={fact} className="preview-chip">{fact}</span>)}
        </div>
      ) : null}

      {loading ? <p className="muted">Decoding image...</p> : null}
      {error ? <p className="preview-note preview-note--warning">{error}</p> : null}

      {!loading && !error ? (
        <div
          ref={surfaceRef}
          className="preview-frame image-pane-card__frame"
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onDoubleClick={() => onViewportChange(DEFAULT_VIEWPORT)}
        >
          <div
            className="image-preview-transform"
            style={{ transform: `translate(${viewport.offsetX}px, ${viewport.offsetY}px) scale(${viewport.scale})` }}
          >
            <canvas
              ref={canvasRef}
              className={clsx("image-preview-canvas", viewport.scale >= 4 && "image-preview-canvas--pixelated")}
            />
          </div>
          {viewport.scale !== 1 ? <span className="preview-frame__badge">{Math.round(viewport.scale * 100)}%</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Facts a game artist checks first: size, power-of-two (matters for compression and mips), alpha. */
function describeImage(imageData: ImageData) {
  const { width, height, data } = imageData;
  const isPowerOfTwo = (value: number) => (value & (value - 1)) === 0;
  let hasAlpha = false;

  for (let index = 3; index < data.length; index += 4) {
    if (data[index] !== 255) {
      hasAlpha = true;
      break;
    }
  }

  return [
    `${width} x ${height} px`,
    isPowerOfTwo(width) && isPowerOfTwo(height) ? "Power of two" : "Non power of two",
    hasAlpha ? "Has transparency" : "Opaque",
    `${((width * height) / 1_000_000).toFixed(2)} MP`,
  ];
}

function diffImages(before: ImageData, after: ImageData) {
  const totalPixels = after.width * after.height;

  if (before.width !== after.width || before.height !== after.height) {
    return { sameSize: false, changedPixels: 0, totalPixels, maxDelta: 0, imageData: null };
  }

  const output = new Uint8ClampedArray(after.data.length);
  let changedPixels = 0;
  let maxDelta = 0;

  for (let index = 0; index < output.length; index += 4) {
    const delta = Math.max(
      Math.abs(after.data[index] - before.data[index]),
      Math.abs(after.data[index + 1] - before.data[index + 1]),
      Math.abs(after.data[index + 2] - before.data[index + 2]),
      Math.abs(after.data[index + 3] - before.data[index + 3]),
    );

    if (delta === 0) {
      const gray = (after.data[index] * 0.3 + after.data[index + 1] * 0.59 + after.data[index + 2] * 0.11) * 0.25;
      output[index] = gray;
      output[index + 1] = gray;
      output[index + 2] = gray;
    } else {
      changedPixels += 1;
      maxDelta = Math.max(maxDelta, delta);
      // Yellow for a faint change, through to red for a full-range one.
      output[index] = 255;
      output[index + 1] = 220 - (delta / 255) * 220;
      output[index + 2] = (delta / 255) * 60;
    }
    output[index + 3] = 255;
  }

  return { sameSize: true, changedPixels, totalPixels, maxDelta, imageData: new ImageData(output, after.width, after.height) };
}

function formatPercent(ratio: number) {
  const percent = ratio * 100;
  return percent > 0 && percent < 0.01 ? "<0.01%" : `${percent.toFixed(percent < 10 ? 2 : 1)}%`;
}

function applyChannelMode(imageData: ImageData, channelMode: ChannelMode) {
  if (channelMode === "rgba") {
    return imageData;
  }

  const next = new Uint8ClampedArray(imageData.data);

  for (let index = 0; index < next.length; index += 4) {
    const alpha = imageData.data[index + 3];

    if (channelMode === "a") {
      next[index] = alpha;
      next[index + 1] = alpha;
      next[index + 2] = alpha;
    } else if (channelMode !== "rgb") {
      next[index] = channelMode === "r" ? imageData.data[index] : 0;
      next[index + 1] = channelMode === "g" ? imageData.data[index + 1] : 0;
      next[index + 2] = channelMode === "b" ? imageData.data[index + 2] : 0;
    }
    next[index + 3] = 255;
  }

  return new ImageData(next, imageData.width, imageData.height);
}
