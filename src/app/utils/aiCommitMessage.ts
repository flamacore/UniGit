import type { CommitMessageContext } from "../../features/repositories/api";
import type { AiSettings } from "./aiSettings";

const OPENAI_MODEL = "gpt-4.1-mini";
const CLAUDE_MODEL = "claude-3-5-haiku-latest";

const buildPrompt = (context: CommitMessageContext) => {
  return [
    "You write concise, high-signal git commit messages.",
    "Return only the commit message text, no code fences, no explanation.",
    "Prefer a short imperative subject line. Add a blank line and 1-3 bullet points only if the change is meaningfully multi-part.",
    `Current branch: ${context.currentBranch}`,
    `Staged files:\n${context.stagedFiles.length ? context.stagedFiles.map((file) => `- ${file}`).join("\n") : "- none"}`,
    context.unpushedCommits.length
      ? `Unpushed local commits already on this branch:\n${context.unpushedCommits.map((commit) => `- ${commit}`).join("\n")}`
      : "Unpushed local commits already on this branch:\n- none",
    `Staged diff:\n${context.stagedDiff || "(empty)"}`,
  ].join("\n\n");
};

const extractText = (value: unknown): string => {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join("\n").trim();
  }

  if (value && typeof value === "object") {
    if ("text" in value && typeof (value as { text?: unknown }).text === "string") {
      return ((value as { text: string }).text).trim();
    }

    if ("content" in value) {
      return extractText((value as { content?: unknown }).content);
    }
  }

  return "";
};

const ensureMessage = (value: string, providerLabel: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${providerLabel} returned an empty commit message.`);
  }
  return trimmed;
};

const createTimeoutController = (timeoutSeconds: number) => {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutSeconds * 1000);

  return {
    signal: controller.signal,
    clear: () => window.clearTimeout(timeoutId),
  };
};

const toProviderError = (reason: unknown, providerLabel: string, timeoutSeconds: number) => {
  if (reason instanceof DOMException && reason.name === "AbortError") {
    return new Error(`${providerLabel} request timed out after ${timeoutSeconds} seconds.`);
  }

  if (reason instanceof Error) {
    return reason;
  }

  return new Error(`${providerLabel} request failed.`);
};

const generateWithOllama = async (settings: AiSettings, prompt: string) => {
  const timeout = createTimeoutController(settings.requestTimeoutSeconds);

  try {
    const response = await fetch(`${settings.ollamaEndpoint.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: timeout.signal,
      body: JSON.stringify({
        model: settings.ollamaModel,
        stream: false,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed with ${response.status}.`);
    }

    const payload = await response.json() as { message?: { content?: string } };
    return ensureMessage(payload.message?.content ?? "", "Ollama");
  } catch (reason) {
    throw toProviderError(reason, "Ollama", settings.requestTimeoutSeconds);
  } finally {
    timeout.clear();
  }
};

const generateWithOpenAi = async (settings: AiSettings, prompt: string) => {
  const timeout = createTimeoutController(settings.requestTimeoutSeconds);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.openAiApiKey}`,
      },
      signal: timeout.signal,
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`OpenAI request failed with ${response.status}: ${detail}`);
    }

    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return ensureMessage(payload.choices?.[0]?.message?.content ?? "", "OpenAI");
  } catch (reason) {
    throw toProviderError(reason, "OpenAI", settings.requestTimeoutSeconds);
  } finally {
    timeout.clear();
  }
};

const generateWithClaude = async (settings: AiSettings, prompt: string) => {
  const timeout = createTimeoutController(settings.requestTimeoutSeconds);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": settings.claudeApiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: timeout.signal,
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Claude request failed with ${response.status}: ${detail}`);
    }

    const payload = await response.json() as { content?: unknown };
    return ensureMessage(extractText(payload.content), "Claude");
  } catch (reason) {
    throw toProviderError(reason, "Claude", settings.requestTimeoutSeconds);
  } finally {
    timeout.clear();
  }
};

export const generateAiCommitMessage = async (settings: AiSettings, context: CommitMessageContext) => {
  const prompt = buildPrompt(context);

  switch (settings.provider) {
    case "ollama":
      return generateWithOllama(settings, prompt);
    case "openai":
      return generateWithOpenAi(settings, prompt);
    case "claude":
      return generateWithClaude(settings, prompt);
    default:
      throw new Error("AI commit message settings are not configured.");
  }
};