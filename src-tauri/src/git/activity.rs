//! Runs git processes so the Logs window can see them: every command reports when it starts,
//! streams its stderr (where git writes progress and prompts) and reports how it ended.
//! Running commands are registered so the window can cancel one that is stuck.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::{Output, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
};

pub const LOG_EVENT: &str = "unigit://log";
const CANCELLED_MESSAGE: &str = "Cancelled from the Logs window.";
const END_DETAIL_LIMIT: usize = 4_000;
/// Progress lines that end in `\r` can arrive hundreds of times a second; one per tick is enough.
const PROGRESS_THROTTLE: Duration = Duration::from_millis(150);

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static NEXT_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static NEXT_COMMAND_ID: AtomicU64 = AtomicU64::new(1);
static RUNNING: OnceLock<Mutex<HashMap<u64, RunningCommand>>> = OnceLock::new();

struct RunningCommand {
    pid: Option<u32>,
    cancelled: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LogEvent {
    pub seq: u64,
    pub at_ms: u64,
    /// `log` for a plain entry; `start`, `output` and `end` describe one git process.
    pub kind: &'static str,
    pub command_id: Option<u64>,
    pub source: String,
    pub scope: String,
    pub message: String,
    pub detail: Option<String>,
    /// For `end`: ok, failed or cancelled.
    pub state: Option<&'static str>,
    pub duration_ms: Option<u64>,
    /// For `output`: a progress line that the next line replaces.
    pub transient: bool,
}

pub fn attach_app_handle(handle: AppHandle) {
    let _ = APP_HANDLE.set(handle);
}

fn running() -> std::sync::MutexGuard<'static, HashMap<u64, RunningCommand>> {
    // A panic elsewhere must never make the registry unusable.
    RUNNING.get_or_init(Default::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_millis() as u64).unwrap_or(0)
}

fn emit(kind: &'static str, command_id: Option<u64>, scope: &str, message: String) -> LogEvent {
    LogEvent {
        seq: NEXT_SEQUENCE.fetch_add(1, Ordering::Relaxed),
        at_ms: now_ms(),
        kind,
        command_id,
        source: "backend".to_string(),
        scope: scope.to_string(),
        message,
        detail: None,
        state: None,
        duration_ms: None,
        transient: false,
    }
}

fn send(event: LogEvent) {
    if let Some(handle) = APP_HANDLE.get() {
        let _ = handle.emit(LOG_EVENT, event);
    }
}

/// Forwards a plain log entry (user actions, errors, notices) to the Logs window.
pub fn publish_log(source: &str, scope: &str, message: &str, detail: Option<&str>) {
    let mut event = emit("log", None, scope, message.to_string());
    event.source = source.to_string();
    event.detail = detail.filter(|value| !value.trim().is_empty()).map(|value| clip(value, END_DETAIL_LIMIT));
    send(event);
}

/// Cuts at a character boundary: slicing a `&str` mid-character panics.
pub fn clip(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }

    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }

    format!("{}\n...[truncated {} bytes]", &value[..end], value.len() - end)
}

pub fn describe(repo_path: Option<&Path>, args: &[String]) -> String {
    match repo_path {
        Some(path) => format!("git -C {} {}", path.display(), args.join(" ")),
        None => format!("git {}", args.join(" ")),
    }
}

/// Spawns `command`, feeds it `input`, and returns its output like `Command::output`,
/// while reporting the run to the Logs window.
pub async fn execute(mut command: Command, description: String, input: Option<Vec<u8>>) -> std::io::Result<Output> {
    command
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn()?;
    let id = NEXT_COMMAND_ID.fetch_add(1, Ordering::Relaxed);
    running().insert(id, RunningCommand { pid: child.id(), cancelled: false });
    send(emit("start", Some(id), "git.command", description));
    let started = Instant::now();

    let stdin_task = match (child.stdin.take(), input) {
        (Some(mut stdin), Some(input)) => Some(tokio::spawn(async move {
            // A process that exits early closes the pipe; its exit status reports the real problem.
            let _ = stdin.write_all(&input).await;
            let _ = stdin.shutdown().await;
        })),
        _ => None,
    };
    let mut stdout = child.stdout.take().expect("stdout is piped");
    let stdout_task = tokio::spawn(async move {
        let mut buffer = Vec::new();
        let _ = stdout.read_to_end(&mut buffer).await;
        buffer
    });
    let stderr_task = tokio::spawn(stream_stderr(id, child.stderr.take().expect("stderr is piped")));

    let status = child.wait().await;
    if let Some(task) = stdin_task {
        let _ = task.await;
    }
    let stdout = stdout_task.await.unwrap_or_default();
    let mut stderr = stderr_task.await.unwrap_or_default();
    let cancelled = running().remove(&id).is_some_and(|entry| entry.cancelled);

    let mut end = emit("end", Some(id), "git.command", String::new());
    end.duration_ms = Some(started.elapsed().as_millis() as u64);

    let status = match status {
        Ok(status) => status,
        Err(error) => {
            end.state = Some("failed");
            end.detail = Some(error.to_string());
            send(end);
            return Err(error);
        }
    };

    if cancelled {
        stderr = CANCELLED_MESSAGE.as_bytes().to_vec();
    }
    end.state = Some(if cancelled {
        "cancelled"
    } else if status.success() {
        "ok"
    } else {
        "failed"
    });
    end.detail = summarize_output(&stdout, &stderr, status.success());
    send(end);

    Ok(Output { status, stdout, stderr })
}

fn summarize_output(stdout: &[u8], stderr: &[u8], success: bool) -> Option<String> {
    // stderr lines were already streamed; on failure repeat them so the reason sits with the result.
    let text = |bytes: &[u8]| {
        if bytes.contains(&0) {
            format!("<{} bytes of binary output>", bytes.len())
        } else {
            String::from_utf8_lossy(bytes).trim().to_string()
        }
    };
    let detail = if success { text(stdout) } else { text(stderr) };
    (!detail.is_empty()).then(|| clip(&detail, END_DETAIL_LIMIT))
}

async fn stream_stderr(id: u64, mut stderr: impl AsyncRead + Unpin) -> Vec<u8> {
    let mut all = Vec::new();
    let mut line = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut last_progress: Option<Instant> = None;

    let flush = |line: &mut Vec<u8>, transient: bool| {
        let text = String::from_utf8_lossy(line).trim_end().to_string();
        line.clear();
        if text.is_empty() {
            return;
        }
        let mut event = emit("output", Some(id), "git.command", text);
        event.transient = transient;
        send(event);
    };

    loop {
        let read = match stderr.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        all.extend_from_slice(&chunk[..read]);

        for &byte in &chunk[..read] {
            match byte {
                b'\n' => {
                    flush(&mut line, false);
                    last_progress = None;
                }
                b'\r' => {
                    if last_progress.is_none_or(|at| at.elapsed() >= PROGRESS_THROTTLE) {
                        flush(&mut line, true);
                        last_progress = Some(Instant::now());
                    } else {
                        line.clear();
                    }
                }
                _ => line.push(byte),
            }
        }
    }

    flush(&mut line, false);
    all
}

/// Stops a running git command and everything it started (git-lfs, ssh, credential helpers).
pub async fn cancel(command_id: u64) -> Result<(), String> {
    let pid = {
        let mut registry = running();
        let entry = registry
            .get_mut(&command_id)
            .ok_or_else(|| "That command has already finished.".to_string())?;
        entry.cancelled = true;
        entry.pid
    };
    let pid = pid.ok_or_else(|| "The process id of that command is unknown.".to_string())?;

    #[cfg(windows)]
    let mut killer = {
        let mut killer = Command::new("taskkill");
        killer.args(["/PID", &pid.to_string(), "/T", "/F"]);
        killer.creation_flags(0x0800_0000);
        killer
    };
    #[cfg(not(windows))]
    let mut killer = {
        let mut killer = Command::new("kill");
        killer.args(["-TERM", &pid.to_string()]);
        killer
    };

    let output = killer.output().await.map_err(|error| error.to_string())?;
    if output.status.success() || !running().contains_key(&command_id) {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Keeps the log file from growing without bound: past the limit it is moved to `.old`.
pub fn rotate_if_large(path: &PathBuf, limit: u64) {
    if std::fs::metadata(path).is_ok_and(|metadata| metadata.len() > limit) {
        let _ = std::fs::rename(path, path.with_extension("log.old"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_never_splits_a_character() {
        // "ğ" is two bytes; a limit of 2 lands in its middle.
        let clipped = clip("aǧb and more text", 2);
        assert!(clipped.starts_with('a'));
        assert!(clipped.contains("truncated"));
        assert_eq!(clip("short", 10), "short");
    }

    #[tokio::test]
    async fn execute_returns_output_and_cancel_stops_the_process() {
        let mut command = Command::new("git");
        command.arg("--version");
        let output = execute(command, "git --version".into(), None).await.unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).starts_with("git version"));

        // `git hash-object --stdin` waits for input that never comes: a stand-in for a stuck command.
        let mut child = Command::new("git")
            .args(["hash-object", "--stdin"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let id = NEXT_COMMAND_ID.fetch_add(1, Ordering::Relaxed);
        running().insert(id, RunningCommand { pid: child.id(), cancelled: false });

        cancel(id).await.unwrap();
        let status = tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .expect("cancel must stop the process")
            .unwrap();
        assert!(!status.success());
        assert!(running().remove(&id).is_some_and(|entry| entry.cancelled));
    }
}
