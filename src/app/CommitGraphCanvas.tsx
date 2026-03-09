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

const ROW_HEIGHT = 92;
const OVERSCAN = 8;
const LANE_SPACING = 34;
const GRAPH_LEFT = 34;
const GRAPH_TOP = 44;
const CARD_WIDTH = 248;
const CARD_OFFSET = 22;

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
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
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

  const graphWidth = GRAPH_LEFT + laneCount * LANE_SPACING + 56;
  const contentWidth = GRAPH_LEFT + laneCount * LANE_SPACING + CARD_OFFSET + CARD_WIDTH + 120;
  const totalHeight = rows.length * ROW_HEIGHT + GRAPH_TOP * 2;

  const visibleRange = useMemo(() => {
    const viewportHeight = Math.max(viewportSize.height, ROW_HEIGHT * 4);
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(
      rows.length,
      Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
    );

    return { start, end };
  }, [rows.length, scrollTop, viewportSize.height]);

  const visibleRows = useMemo(() => {
    return rows.slice(visibleRange.start, visibleRange.end).map((row, localIndex) => ({
      row,
      index: visibleRange.start + localIndex,
    }));
  }, [rows, visibleRange.end, visibleRange.start]);

  const rowIndexByHash = useMemo(() => {
    return new Map(rows.map((row, index) => [row.hash, index]));
  }, [rows]);

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

    const width = Math.max(viewportSize.width, 320);
    const height = Math.max(viewportSize.height, 320);
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
      const x = GRAPH_LEFT + lane * LANE_SPACING - scrollLeft;
      context.strokeStyle = `${getLaneColor(lane)}18`;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }

    for (const { row, index } of visibleRows) {
      const y = GRAPH_TOP + index * ROW_HEIGHT - scrollTop;
      const nodeX = GRAPH_LEFT + row.lane * LANE_SPACING - scrollLeft;
      const rowTop = y - ROW_HEIGHT / 2;
      const rowBottom = y + ROW_HEIGHT / 2;

      for (const lane of row.activeLanes) {
        const x = GRAPH_LEFT + lane * LANE_SPACING - scrollLeft;
        context.strokeStyle = `${getLaneColor(lane)}55`;
        context.lineWidth = lane === row.lane ? 2.5 : 1.5;
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
          ? GRAPH_TOP + targetIndex * ROW_HEIGHT - scrollTop
          : height + ROW_HEIGHT;
        const targetX = GRAPH_LEFT + parentLane * LANE_SPACING - scrollLeft;

        context.strokeStyle = `${getLaneColor(parentLane)}c8`;
        context.lineWidth = parentIndex === 0 ? 2.4 : 1.8;
        context.beginPath();
        context.moveTo(nodeX, y);
        context.bezierCurveTo(
          nodeX,
          y + 26,
          targetX,
          targetY - 26,
          targetX,
          targetY,
        );
        context.stroke();
      });

      context.fillStyle = getLaneColor(row.lane);
      context.beginPath();
      context.arc(nodeX, y, row.mergeCommit ? 6.5 : 5.5, 0, Math.PI * 2);
      context.fill();

      context.strokeStyle = "rgba(7, 12, 23, 0.95)";
      context.lineWidth = 2;
      context.beginPath();
      context.arc(nodeX, y, row.mergeCommit ? 8 : 7, 0, Math.PI * 2);
      context.stroke();
    }
  }, [laneCount, rowIndexByHash, rows, scrollLeft, scrollTop, viewportSize.height, viewportSize.width, visibleRows]);

  useEffect(() => {
    drawGraph();
  }, [drawGraph]);

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;

    if (!viewport) {
      return;
    }

    setScrollTop(viewport.scrollTop);
    setScrollLeft(viewport.scrollLeft);

    const nearBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - ROW_HEIGHT * 8;

    if (nearBottom && hasMore && !loadingRef.current) {
      onLoadMore();
    }
  }, [hasMore, onLoadMore]);

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
        <span>{hasMore ? "Paged history active" : "End of loaded history"}</span>
      </div>

      <div
        ref={viewportRef}
        className="graph-viewport"
        onScroll={handleScroll}
      >
        <canvas ref={canvasRef} className="graph-canvas" />

        <div
          className="graph-space"
          style={{ width: contentWidth, height: totalHeight } as CSSProperties}
        >
          {visibleRows.map(({ row, index }) => {
            const refs = row.decorations
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean);
            const top = GRAPH_TOP + index * ROW_HEIGHT - 34;
            const left = GRAPH_LEFT + row.lane * LANE_SPACING + CARD_OFFSET;

            return (
              <article
                key={row.hash}
                className="graph-card"
                style={{ top, left, width: CARD_WIDTH } as CSSProperties}
              >
                <div className="graph-card__top">
                  <strong title={row.subject}>{row.subject}</strong>
                  <span>{row.shortHash}</span>
                </div>
                <div className="graph-card__meta">
                  <span>{row.authorName}</span>
                  <span>{formatRelativeTime(row.authoredAt)}</span>
                </div>
                <div className="graph-card__footer">
                  <span className="graph-card__lane" style={{ color: getLaneColor(row.lane) }}>
                    lane {row.lane + 1}
                  </span>
                  <span className="muted">
                    {row.parentHashes.length > 1
                      ? `${row.parentHashes.length} parents`
                      : row.parentHashes.length === 1
                        ? "1 parent"
                        : "root"}
                  </span>
                </div>
                {refs.length ? (
                  <div className="history-ref-list">
                    {refs.map((ref) => (
                      <span key={`${row.hash}-${ref}`} className="history-ref-pill">
                        {ref}
                      </span>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}