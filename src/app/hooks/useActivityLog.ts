import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LogEvent } from "../../features/repositories/api";

export type CommandEntry = {
  kind: "command";
  key: string;
  commandId: number;
  startedAt: number;
  command: string;
  lines: string[];
  /** Latest progress line (`\r`-terminated output), replaced by the next one. */
  progress: string | null;
  state: "running" | "ok" | "failed" | "cancelled";
  durationMs: number | null;
  detail: string | null;
};

export type MessageEntry = {
  kind: "message";
  key: string;
  at: number;
  source: string;
  scope: string;
  message: string;
  detail: string | null;
};

export type ActivityEntry = CommandEntry | MessageEntry;

const MAX_ENTRIES = 1500;
const MAX_LINES_PER_COMMAND = 400;
const FLUSH_MS = 120;

/**
 * Collects the backend's live log stream from app start, so the Logs window shows history
 * even when opened later. Events are batched: a fetch can emit hundreds of progress lines.
 */
export function useActivityLog() {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const pendingRef = useRef<LogEvent[]>([]);
  // A listener can briefly be registered twice (React re-runs effects in development);
  // without this a duplicated start event leaves a command that looks "running" forever.
  const seenRef = useRef(new Set<number>());

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<LogEvent>("unigit://log", (event) => {
      const seen = seenRef.current;
      if (seen.has(event.payload.seq)) {
        return;
      }
      seen.add(event.payload.seq);
      if (seen.size > 20_000) {
        seen.clear();
        seen.add(event.payload.seq);
      }
      pendingRef.current.push(event.payload);
    }).then((stop) => {
      if (disposed) {
        stop();
      } else {
        unlisten = stop;
      }
    });

    const timer = window.setInterval(() => {
      if (pendingRef.current.length === 0) {
        return;
      }
      const batch = pendingRef.current;
      pendingRef.current = [];
      setEntries((current) => applyEvents(current, batch));
    }, FLUSH_MS);

    return () => {
      disposed = true;
      unlisten?.();
      window.clearInterval(timer);
    };
  }, []);

  const clear = useCallback(() => {
    // Running commands stay: they are still happening and may need cancelling.
    setEntries((current) => current.filter((entry) => entry.kind === "command" && entry.state === "running"));
  }, []);

  return { entries, clear };
}

function applyEvents(current: ActivityEntry[], events: LogEvent[]) {
  const next = [...current];
  const indexById = new Map<number, number>();
  next.forEach((entry, index) => {
    if (entry.kind === "command") {
      indexById.set(entry.commandId, index);
    }
  });

  const updateCommand = (commandId: number, update: (entry: CommandEntry) => CommandEntry) => {
    const index = indexById.get(commandId);
    if (index !== undefined) {
      next[index] = update(next[index] as CommandEntry);
    }
  };

  for (const event of events) {
    if (event.kind === "log") {
      next.push({
        kind: "message",
        key: `m${event.seq}`,
        at: event.atMs,
        source: event.source,
        scope: event.scope,
        message: event.message,
        detail: event.detail,
      });
    } else if (event.kind === "start" && event.commandId !== null) {
      indexById.set(event.commandId, next.length);
      next.push({
        kind: "command",
        key: `c${event.commandId}`,
        commandId: event.commandId,
        startedAt: event.atMs,
        command: event.message,
        lines: [],
        progress: null,
        state: "running",
        durationMs: null,
        detail: null,
      });
    } else if (event.kind === "output" && event.commandId !== null) {
      updateCommand(event.commandId, (entry) => event.transient
        ? { ...entry, progress: event.message }
        : { ...entry, progress: null, lines: [...entry.lines, event.message].slice(-MAX_LINES_PER_COMMAND) });
    } else if (event.kind === "end" && event.commandId !== null) {
      updateCommand(event.commandId, (entry) => ({
        ...entry,
        state: (event.state ?? "ok") as CommandEntry["state"],
        durationMs: event.durationMs,
        detail: event.detail,
        progress: null,
      }));
    }
  }

  return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
}
