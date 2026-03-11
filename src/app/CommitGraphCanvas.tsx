import clsx from "clsx";
import {
  Expand,
  Minimize2,
  RefreshCw,
} from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CommitGraphRow } from "../features/repositories/api";

const BASE_ROW_HEIGHT = 40;
const MIN_ROW_HEIGHT = 36;
const BASE_LANE_SPACING = 16;
const BASE_GRAPH_LEFT = 18;
const BASE_GRAPH_TOP = 28;
const BASE_NODE_RADIUS = 4;
const BASE_MERGE_RADIUS = 5;
const BASE_OFFPAGE_RADIUS = 3.25;
const ROW_CONTENT_OFFSET = 18;
const ROW_CONTENT_SPACE = 2200;

const LANE_COLORS = [
  "#6dd3ff",
  "#6dffb3",
  "#ffb45b",
  "#ff7c97",
  "#b990ff",
  "#7ec8ff",
  "#53e0d1",
  "#ffe270",
];

const getLaneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length];

const normalizeRefLabel = (value: string) => {
  return value.replace(/^HEAD ->\s*/, "").trim();
};

const formatRelativeTime = (iso: string) => {
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60000);

  if (Number.isNaN(minutes)) {
    return iso;
  }

  if (minutes < 1) {
    return "just now";
  }

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 24) {
    return `${hours}h ago`;
  }

  return `${Math.round(hours / 24)}d ago`;
};

type CommitGraphCanvasProps = {
  rows: CommitGraphRow[];
  filter: string;
  onFilterChange: (value: string) => void;
  onLoadMore: () => void;
  hasMore: boolean;
  loading: boolean;
};

export function CommitGraphCanvas({
  rows,
  filter,
  onFilterChange,
  onLoadMore,
  hasMore,
  loading,
}: CommitGraphCanvasProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const loadingRef = useRef(loading);
  const previousRowHeightRef = useRef(BASE_ROW_HEIGHT * 0.55);
  const [laneScale, setLaneScale] = useState(0.55);
  const [laneCropWidth, setLaneCropWidth] = useState(220);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === rootRef.current);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;

    if (!viewport) {
      return;
    }

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];

      if (!entry) {
        return;
      }

      setViewportSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });

    resizeObserver.observe(viewport);
    return () => resizeObserver.disconnect();
  }, []);

  const laneCount = useMemo(() => {
    const highestLane = rows.reduce((maxLane, row) => {
      const laneMax = Math.max(row.lane, ...row.activeLanes);
      return Math.max(maxLane, laneMax);
    }, 0);

    return Math.max(5, highestLane + 1);
  }, [rows]);

  const rowHeight = Math.max(MIN_ROW_HEIGHT, BASE_ROW_HEIGHT);
  const laneSpacing = Math.max(10, Math.round(BASE_LANE_SPACING * laneScale));
  const graphLeft = Math.max(12, Math.round(BASE_GRAPH_LEFT * laneScale));
  const graphTop = BASE_GRAPH_TOP;
  const rowContentOffset = Math.max(10, Math.round(ROW_CONTENT_OFFSET * laneScale));
  const graphNaturalWidth = graphLeft + laneCount * laneSpacing + 24;
  const graphBlockWidth = Math.min(graphNaturalWidth, laneCropWidth);
  const contentWidth = graphBlockWidth + rowContentOffset + ROW_CONTENT_SPACE;
  const totalHeight = rows.length * rowHeight + graphTop * 2;
  const nodeRadius = Math.max(3.5, BASE_NODE_RADIUS * laneScale);
  const mergeRadius = Math.max(4.5, BASE_MERGE_RADIUS * laneScale);
  const offpageRadius = Math.max(2.5, BASE_OFFPAGE_RADIUS * laneScale);

  const rowIndexByHash = useMemo(() => {
    return new Map(rows.map((row, index) => [row.hash, index]));
  }, [rows]);

  const globallyActiveLanes = useMemo(() => {
    const lanes = new Set<number>();

    for (const row of rows) {
      lanes.add(row.lane);
      for (const activeLane of row.activeLanes) {
        lanes.add(activeLane);
      }
    }

    return lanes;
  }, [rows]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const previousRowHeight = previousRowHeightRef.current;

    if (!viewport || previousRowHeight === rowHeight) {
      previousRowHeightRef.current = rowHeight;
      return;
    }

    const relativeIndex = viewport.scrollTop / previousRowHeight;
    viewport.scrollTop = relativeIndex * rowHeight;
    previousRowHeightRef.current = rowHeight;
  }, [rowHeight]);

  const toggleFullscreen = useCallback(async () => {
    if (!rootRef.current) {
      return;
    }

    if (document.fullscreenElement === rootRef.current) {
      await document.exitFullscreen();
      return;
    }

    await rootRef.current.requestFullscreen();
  }, []);

  const drawGraph = useCallback(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const width = Math.max(graphBlockWidth, 120);
    const height = Math.max(totalHeight, 320);
    const dpr = window.devicePixelRatio || 1;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const context = canvas.getContext("2d");

    if (!context) {
      return;
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    context.fillStyle = "rgba(4, 10, 20, 0.72)";
    context.fillRect(0, 0, width, height);

    for (let lane = 0; lane < laneCount; lane += 1) {
      const x = graphLeft + lane * laneSpacing;
      const laneColor = getLaneColor(lane);
      context.strokeStyle = globallyActiveLanes.has(lane)
        ? `${laneColor}44`
        : `${laneColor}18`;
      context.lineWidth = globallyActiveLanes.has(lane) ? Math.max(1, 1.35 * laneScale) : 1;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }

    for (const [index, row] of rows.entries()) {
      const y = graphTop + index * rowHeight;
      const nodeX = graphLeft + row.lane * laneSpacing;
      const snappedY = Math.round(y);
      const snappedNodeX = Math.round(nodeX);
      const rowTop = snappedY - rowHeight / 2;
      const rowBottom = snappedY + rowHeight / 2;

      for (const lane of row.activeLanes) {
        const x = Math.round(graphLeft + lane * laneSpacing) + 0.5;
        context.strokeStyle = `${getLaneColor(lane)}55`;
        context.lineWidth = lane === row.lane ? Math.max(1.35, 2.1 * laneScale) : Math.max(0.9, 1.2 * laneScale);
        context.beginPath();
        context.moveTo(x, rowTop);
        context.lineTo(x, rowBottom);
        context.stroke();
      }

      row.parentHashes.forEach((parentHash, parentIndex) => {
        const targetIndex = rowIndexByHash.get(parentHash);
        const fallbackLane = parentIndex === 0 ? row.lane : row.lane + parentIndex;
        const parentLane = targetIndex !== undefined ? rows[targetIndex]?.lane ?? fallbackLane : fallbackLane;
        const targetY = targetIndex !== undefined
          ? graphTop + targetIndex * rowHeight
          : height - 12;
        const targetX = Math.round(graphLeft + parentLane * laneSpacing);
        const snappedTargetY = Math.round(targetY);

        context.strokeStyle = `${getLaneColor(parentLane)}c8`;
        context.lineWidth = parentIndex === 0 ? Math.max(1.4, 2 * laneScale) : Math.max(1, 1.45 * laneScale);
        context.setLineDash(targetIndex === undefined ? [5 * laneScale, 4 * laneScale] : []);
        context.beginPath();
        context.moveTo(snappedNodeX, snappedY);
        context.bezierCurveTo(
          snappedNodeX,
          snappedY + 18 * laneScale,
          targetX,
          snappedTargetY - 18 * laneScale,
          targetX,
          snappedTargetY,
        );
        context.stroke();
        context.setLineDash([]);

        if (targetIndex === undefined) {
          context.fillStyle = getLaneColor(parentLane);
          context.beginPath();
          context.arc(targetX, height - 12, offpageRadius, 0, Math.PI * 2);
          context.fill();

          context.strokeStyle = "rgba(7, 12, 23, 0.95)";
          context.lineWidth = Math.max(1.1, 1.8 * laneScale);
          context.beginPath();
          context.arc(targetX, height - 12, offpageRadius + 1.5, 0, Math.PI * 2);
          context.stroke();
        }
      });

      context.fillStyle = getLaneColor(row.lane);
      context.beginPath();
      context.arc(snappedNodeX, snappedY, row.mergeCommit ? mergeRadius : nodeRadius, 0, Math.PI * 2);
      context.fill();

      context.strokeStyle = "rgba(7, 12, 23, 0.95)";
      context.lineWidth = Math.max(1.1, 1.8 * laneScale);
      context.beginPath();
      context.arc(snappedNodeX, snappedY, (row.mergeCommit ? mergeRadius : nodeRadius) + 1.5, 0, Math.PI * 2);
      context.stroke();
    }
  }, [globallyActiveLanes, graphBlockWidth, graphLeft, graphTop, laneCount, laneScale, laneSpacing, mergeRadius, nodeRadius, offpageRadius, rowHeight, rowIndexByHash, rows, totalHeight]);

  useEffect(() => {
    drawGraph();
  }, [drawGraph]);

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;

    if (!viewport) {
      return;
    }

    setScrollTop(viewport.scrollTop);

    const nearBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - rowHeight * 10;

    if (nearBottom && hasMore && !loadingRef.current) {
      onLoadMore();
    }
  }, [hasMore, onLoadMore, rowHeight]);

  return (
    <section
      ref={rootRef}
      className={clsx("panel graph-panel", isFullscreen && "graph-panel--fullscreen")}
    >
      <div className="board__header graph-panel__header">
        <div>
          <p className="eyebrow">Graph</p>
          <h3>Commit graph canvas</h3>
        </div>
        <div className="graph-toolbar">
          <label className="graph-control">
            <span>Scale {Math.round(laneScale * 100)}%</span>
            <input
              className="graph-slider"
              type="range"
              min="45"
              max="120"
              onChange={(event) => setLaneScale(Number(event.target.value) / 100)}
            />
          </label>
          <label className="graph-control">
            <span>Lanes {laneCropWidth}px</span>
            <input
              className="graph-slider"
              type="range"
              min="120"
              max="520"
              step="10"
              value={laneCropWidth}
              onChange={(event) => setLaneCropWidth(Number(event.target.value))}
            />
          </label>
          <input
            className="history-filter"
            placeholder="Filter graph"
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
          />
          <button className="ghost-button" onClick={onLoadMore} disabled={!hasMore || loading}>
            <RefreshCw size={15} className={clsx(loading && "spin")}/>
            {hasMore ? "Load more" : "Loaded"}
          </button>
          <button className="ghost-button" onClick={() => void toggleFullscreen()}>
            {isFullscreen ? <Minimize2 size={15} /> : <Expand size={15} />}
            {isFullscreen ? "Window" : "Fullscreen"}
          </button>
        </div>
      </div>

      <div className="graph-status-row">
        <span>{rows.length.toLocaleString()} commits loaded</span>
        <span>{laneCount} active lanes</span>
        <span>{graphBlockWidth}px lane block</span>
        <span>{Math.round(rowHeight)}px rows</span>
        <span>{hasMore ? "Paged history active" : "End of loaded history"}</span>
      </div>

      <div
        ref={viewportRef}
        className="graph-viewport"
        onScroll={handleScroll}
      >
        <div
          className="graph-space"
          style={{ width: contentWidth, height: totalHeight } as CSSProperties}
        >
          <canvas ref={canvasRef} className="graph-canvas" />

          <div
            className="graph-rows"
            style={{
              marginLeft: graphBlockWidth + rowContentOffset,
              paddingTop: graphTop,
            } as CSSProperties}
          >
            {rows.map((row) => {
              const refs = row.decorations
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean)
                .map(normalizeRefLabel);
              const uniqueRefs = Array.from(
                new Set([row.displayBranch, ...refs].filter(Boolean)),
              );

              return (
                <div
                  key={row.hash}
                  className="graph-row"
                  style={{ height: rowHeight } as CSSProperties}
                >
                  <div className="graph-row__main">
                    {uniqueRefs.length ? (
                      <div className="graph-row__refs">
                        {uniqueRefs.map((ref, refIndex) => (
                          <span
                            key={`${row.hash}-${ref}`}
                            className={clsx(
                              "history-ref-pill",
                              refIndex === 0 && "history-ref-pill--primary",
                            )}
                            style={refIndex === 0 ? ({ color: getLaneColor(row.lane) } as CSSProperties) : undefined}
                          >
                            {ref}
                          </span>
                        ))}
                      </div>
                    ) : null}

                    <strong className="graph-row__subject" title={row.subject}>
                      {row.subject}
                    </strong>
                  </div>
                  <div className="graph-row__meta">
                    <span>{row.shortHash}</span>
                    <span>{row.authorName}</span>
                    <span>{formatRelativeTime(row.authoredAt)}</span>
                    <span className="muted">
                      {row.parentHashes.length > 1
                        ? `${row.parentHashes.length} parents`
                        : row.parentHashes.length === 1
                          ? "1 parent"
                          : "root"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}