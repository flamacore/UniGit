import clsx from "clsx";
import { Ban, CheckCircle2, ChevronRight, Copy, LoaderCircle, Trash2, X, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ActivityEntry, CommandEntry } from "../hooks/useActivityLog";

type LogsPanelProps = {
  entries: ActivityEntry[];
  logFilePath: string | null;
  onClear: () => void;
  onCancel: (commandId: number) => Promise<void>;
  onClose: () => void;
};

type Filter = "all" | "commands" | "problems";

// Past this, a running command is probably waiting on something (a lock, the network, a prompt).
const SLOW_AFTER_MS = 15_000;

export function LogsPanel({ entries, logFilePath, onClear, onCancel, onClose }: LogsPanelProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [cancelling, setCancelling] = useState<Set<number>>(new Set());
  const [now, setNow] = useState(Date.now());
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const running = useMemo(
    () => entries.filter((entry): entry is CommandEntry => entry.kind === "command" && entry.state === "running"),
    [entries],
  );

  useEffect(() => {
    if (running.length === 0) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running.length]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (filter === "commands" && entry.kind !== "command") {
        return false;
      }
      if (filter === "problems" && !isProblem(entry)) {
        return false;
      }
      if (!needle) {
        return true;
      }
      const haystack = entry.kind === "command"
        ? [entry.command, entry.detail, ...entry.lines].join("\n")
        : [entry.scope, entry.message, entry.detail].join("\n");
      return haystack.toLowerCase().includes(needle);
    });
  }, [entries, filter, query]);

  useEffect(() => {
    const list = listRef.current;
    if (list && stickToBottomRef.current) {
      list.scrollTop = list.scrollHeight;
    }
  }, [visible]);

  const toggle = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const cancel = async (commandId: number) => {
    setCancelling((current) => new Set(current).add(commandId));
    try {
      await onCancel(commandId);
    } finally {
      setCancelling((current) => {
        const next = new Set(current);
        next.delete(commandId);
        return next;
      });
    }
  };

  const copyVisible = () => {
    const text = visible.map(formatEntry).join("\n\n");
    void navigator.clipboard?.writeText(text);
  };

  return (
    <aside className="panel logs-panel" aria-label="Logs">
      <div className="logs-panel__header">
        <div>
          <p className="eyebrow">Logs</p>
          <h3>Git activity</h3>
        </div>
        <span className="logs-panel__header-actions">
          <button className="icon-button" onClick={copyVisible} title="Copy the visible entries" aria-label="Copy the visible entries">
            <Copy size={14} />
          </button>
          <button className="icon-button" onClick={onClear} title="Clear finished entries" aria-label="Clear finished entries">
            <Trash2 size={14} />
          </button>
          <button className="icon-button" onClick={onClose} title="Close logs" aria-label="Close logs">
            <X size={14} />
          </button>
        </span>
      </div>

      {running.length > 0 ? (
        <div className="logs-panel__running">
          <p className="eyebrow">Running now</p>
          {running.map((entry) => {
            const elapsed = now - entry.startedAt;
            const latest = entry.progress ?? entry.lines[entry.lines.length - 1];
            return (
              <div key={entry.key} className={clsx("logs-running", elapsed > SLOW_AFTER_MS && "logs-running--slow")}>
                <LoaderCircle size={14} className="logs-spin" />
                <div className="logs-running__text">
                  <code title={entry.command}>{shortCommand(entry.command)}</code>
                  <small>
                    {formatDuration(elapsed)}
                    {latest ? ` · ${latest}` : ""}
                  </small>
                  {elapsed > SLOW_AFTER_MS ? (
                    <small className="logs-running__hint">
                      Taking long. Git may be downloading (LFS), waiting on a locked file (close Unity) or on a sign-in window.
                    </small>
                  ) : null}
                </div>
                <button
                  className="ghost-button ghost-button--danger"
                  disabled={cancelling.has(entry.commandId)}
                  onClick={() => void cancel(entry.commandId)}
                  title="Stop this git process and anything it started"
                >
                  <Ban size={13} />
                  Cancel
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="logs-panel__toolbar">
        <span className="segmented">
          {(["all", "commands", "problems"] as Filter[]).map((option) => (
            <button key={option} className={clsx(filter === option && "segmented__active")} onClick={() => setFilter(option)}>
              {option === "all" ? "All" : option === "commands" ? "Git commands" : "Problems"}
            </button>
          ))}
        </span>
        <input className="logs-panel__search" placeholder="Filter" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>

      <div
        ref={listRef}
        className="logs-panel__list panel-scroll"
        onScroll={(event) => {
          const list = event.currentTarget;
          stickToBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
        }}
      >
        {visible.length === 0 ? (
          <p className="muted logs-panel__empty">
            {entries.length === 0 ? "Nothing yet. Git commands appear here as they run." : "No entries match."}
          </p>
        ) : null}
        {visible.map((entry) => {
          const open = expanded.has(entry.key);
          const body = entry.kind === "command"
            ? [...entry.lines, entry.progress, entry.detail].filter(Boolean).join("\n")
            : entry.detail ?? "";

          return (
            <div key={entry.key} className={clsx("logs-entry", isProblem(entry) && "logs-entry--problem")}>
              <button className="logs-entry__row" onClick={() => body && toggle(entry.key)} disabled={!body}>
                <ChevronRight size={12} className={clsx("logs-entry__chevron", open && "logs-entry__chevron--open", !body && "logs-entry__chevron--hidden")} />
                <span className="logs-entry__time">{formatTime(entry.kind === "command" ? entry.startedAt : entry.at)}</span>
                {entry.kind === "command" ? (
                  <>
                    <StateIcon state={entry.state} />
                    <code className="logs-entry__text" title={entry.command}>{shortCommand(entry.command)}</code>
                    <span className="logs-entry__meta">
                      {entry.state === "running" ? formatDuration(now - entry.startedAt) : entry.durationMs !== null ? formatDuration(entry.durationMs) : ""}
                    </span>
                  </>
                ) : (
                  <>
                    <span className={clsx("logs-entry__scope", entry.source === "frontend" && "logs-entry__scope--action")}>{entry.scope}</span>
                    <span className="logs-entry__text" title={entry.message}>{entry.message}</span>
                  </>
                )}
              </button>
              {open && body ? <pre className="logs-entry__body">{body}</pre> : null}
            </div>
          );
        })}
      </div>

      {logFilePath ? <p className="logs-panel__footer" title={logFilePath}>Full history: {logFilePath}</p> : null}
    </aside>
  );
}

function StateIcon({ state }: { state: CommandEntry["state"] }) {
  switch (state) {
    case "running":
      return <LoaderCircle size={13} className="logs-spin logs-state logs-state--running" />;
    case "ok":
      return <CheckCircle2 size={13} className="logs-state logs-state--ok" />;
    case "cancelled":
      return <Ban size={13} className="logs-state logs-state--cancelled" />;
    default:
      return <XCircle size={13} className="logs-state logs-state--failed" />;
  }
}

function isProblem(entry: ActivityEntry) {
  return entry.kind === "command"
    ? entry.state === "failed" || entry.state === "cancelled"
    : /error|fail/i.test(entry.scope);
}

/** "git -C E:\\Project switch dev" reads better as "git switch dev"; the full text is in the tooltip. */
function shortCommand(command: string) {
  return command.replace(/^git -C (?:"[^"]*"|\S+) /, "git ");
}

function formatDuration(ms: number) {
  if (ms < 1000) {
    return `${ms} ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  }
  return `${Math.floor(seconds / 60)} m ${Math.round(seconds % 60)} s`;
}

function formatTime(at: number) {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

function formatEntry(entry: ActivityEntry) {
  if (entry.kind === "message") {
    return [`[${formatTime(entry.at)}] ${entry.scope}: ${entry.message}`, entry.detail].filter(Boolean).join("\n");
  }
  return [
    `[${formatTime(entry.startedAt)}] ${entry.command} -> ${entry.state}${entry.durationMs !== null ? ` in ${formatDuration(entry.durationMs)}` : ""}`,
    ...entry.lines,
    entry.detail,
  ].filter(Boolean).join("\n");
}
