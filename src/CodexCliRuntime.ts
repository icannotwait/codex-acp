import * as acp from "@agentclientprotocol/sdk";
import {spawn, type ChildProcess} from "node:child_process";
import crypto from "node:crypto";
import fs, {type Dirent} from "node:fs";
import os from "node:os";
import path from "node:path";
import {logger} from "./Logger";
import type {ServerNotification, ServiceTier} from "./app-server";
import type {JsonValue} from "./app-server/serde_json/JsonValue";
import type {
    Model,
    Thread,
    ThreadItem,
    Turn,
    TurnCompletedNotification,
} from "./app-server/v2";
import {AgentMode} from "./AgentMode";
import {ModelId} from "./ModelId";

type NotificationHandler = (event: ServerNotification) => void | Promise<void>;

interface CliSession {
    sessionId: string;
    cliThreadId: string | null;
    cliRolloutPath: string | null;
    cwd: string;
    additionalDirectories: string[];
    mcpServers: acp.McpServer[];
    activeChild: ChildProcess | null;
    lastPrompt: string | null;
    updatedAt: number;
}

interface PersistedCliSession {
    sessionId: string;
    cliThreadId: string;
    cliRolloutPath: string | null;
    cwd: string;
    lastPrompt: string | null;
    updatedAt: number;
}

interface CliRunState {
    session: CliSession;
    turnId: string;
    startedAt: number;
    items: ThreadItem[];
    completed: TurnCompletedNotification | null;
}

type CliJsonEvent = {
    type: string;
    thread_id?: string;
    item?: Record<string, unknown>;
    usage?: Record<string, unknown>;
};

const CLI_RUNTIME_ENV_VAR = "CODEX_ACP_USE_CLI";
const DEFAULT_CLI_MODEL = "gpt-5";
const CLI_SESSION_MAP_FILENAME = "codeg-codex-acp-cli-sessions.json";

export function shouldUseCodexCliRuntime(): boolean {
    return process.env[CLI_RUNTIME_ENV_VAR] === "1";
}

export class CodexCliRuntime {
    private readonly sessions = new Map<string, CliSession>();
    private readonly handlers = new Map<string, NotificationHandler>();

    createSession(request: acp.NewSessionRequest, additionalDirectories: string[]): CliSession {
        const sessionId = crypto.randomUUID();
        const session: CliSession = {
            sessionId,
            cliThreadId: null,
            cliRolloutPath: null,
            cwd: request.cwd,
            additionalDirectories,
            mcpServers: request.mcpServers ?? [],
            activeChild: null,
            lastPrompt: null,
            updatedAt: Date.now(),
        };
        this.sessions.set(sessionId, session);
        return session;
    }

    resumeSession(request: acp.ResumeSessionRequest, additionalDirectories: string[]): CliSession {
        const persisted = readPersistedCliSession(request.sessionId);
        const cliThreadId = persisted?.cliThreadId ?? request.sessionId;
        const session: CliSession = {
            sessionId: request.sessionId,
            cliThreadId,
            cliRolloutPath: persisted?.cliRolloutPath ?? findCodexRolloutPath(cliThreadId),
            cwd: request.cwd || persisted?.cwd || process.cwd(),
            additionalDirectories,
            mcpServers: request.mcpServers ?? [],
            activeChild: null,
            lastPrompt: persisted?.lastPrompt ?? null,
            updatedAt: persisted?.updatedAt ?? Date.now(),
        };
        this.sessions.set(request.sessionId, session);
        return session;
    }

    getSession(sessionId: string): CliSession | undefined {
        return this.sessions.get(sessionId);
    }

    closeSession(sessionId: string): void {
        this.abortSession(sessionId);
        this.handlers.delete(sessionId);
        this.sessions.delete(sessionId);
    }

    abortSession(sessionId: string): void {
        const child = this.sessions.get(sessionId)?.activeChild;
        if (child && !child.killed) {
            child.kill("SIGINT");
            setTimeout(() => {
                if (!child.killed) {
                    child.kill("SIGTERM");
                }
            }, 1_000).unref();
        }
    }

    onServerNotification(sessionId: string, handler: NotificationHandler): void {
        this.handlers.set(sessionId, handler);
    }

    listSessions(cwd?: string | null): acp.ListSessionsResponse {
        const sessions = Array.from(this.sessions.values())
            .filter(session => !cwd || session.cwd === cwd || path.basename(session.cwd) === path.basename(cwd))
            .map(session => ({
                sessionId: session.sessionId,
                cwd: session.cwd,
                title: session.lastPrompt ?? "Codex CLI session",
                updatedAt: new Date(session.updatedAt).toISOString(),
            }));
        return {sessions, nextCursor: null};
    }

    async runPrompt(params: {
        request: acp.PromptRequest;
        agentMode: AgentMode;
        modelId: ModelId;
        serviceTier: ServiceTier | null;
        disableSummary: boolean;
        cwd: string;
        additionalDirectories: string[];
        shouldCancel?: () => boolean;
        onTurnStarted?: (turnId: string) => void;
    }): Promise<TurnCompletedNotification | null> {
        const session = this.sessions.get(params.request.sessionId);
        if (!session) {
            throw new Error(`Unknown Codex CLI session ${params.request.sessionId}`);
        }
        session.cwd = params.cwd;
        session.additionalDirectories = params.additionalDirectories;
        const prompt = promptText(params.request.prompt);
        session.lastPrompt = prompt.slice(0, 160);
        session.updatedAt = Date.now();

        const turnId = crypto.randomUUID();
        const state: CliRunState = {
            session,
            turnId,
            startedAt: Date.now(),
            items: [],
            completed: null,
        };
        this.emit(session.sessionId, {
            method: "turn/started",
            params: {
                threadId: session.sessionId,
                turn: createTurn(turnId, "inProgress", [], state.startedAt),
            },
        } as ServerNotification);
        params.onTurnStarted?.(turnId);

        const args = buildCodexExecArgs({
            session,
            prompt,
            modelId: params.modelId,
            agentMode: params.agentMode,
            serviceTier: params.serviceTier,
            disableSummary: params.disableSummary,
        });
        logger.log("Starting Codex CLI runtime turn", {
            sessionId: session.sessionId,
            cliThreadId: session.cliThreadId,
            argv: ["codex", ...redactArgs(args)],
        });

        const child = spawn(resolveCodexPath(), args, {
            cwd: session.cwd,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        session.activeChild = child;

        const cancelTimer = setInterval(() => {
            if (params.shouldCancel?.()) {
                this.abortSession(session.sessionId);
            }
        }, 200);
        cancelTimer.unref();

        try {
        if (!child.stdout || !child.stderr) {
            throw new Error("codex exec did not expose stdout/stderr pipes");
        }

        await Promise.all([
            this.consumeJsonl(child.stdout, line => this.handleCliEvent(line, state)),
            this.consumeJsonl(child.stderr, line => this.handleCliDiagnostic(line, state)),
            waitForExit(child),
            ]);
        } finally {
            clearInterval(cancelTimer);
            if (session.activeChild === child) {
                session.activeChild = null;
            }
            session.updatedAt = Date.now();
            this.refreshAndPersistSession(session);
        }

        if (params.shouldCancel?.()) {
            return {
                threadId: session.sessionId,
                turn: createTurn(turnId, "interrupted", state.items, state.startedAt),
            };
        }

        const completed = state.completed ?? {
            threadId: session.sessionId,
            turn: createTurn(turnId, "completed", state.items, state.startedAt),
        };
        this.emit(session.sessionId, {
            method: "turn/completed",
            params: completed,
        } as ServerNotification);
        return completed;
    }

    availableModels(): Model[] {
        const model = process.env["CODEX_ACP_CLI_MODEL"]?.trim() || DEFAULT_CLI_MODEL;
        return [createVirtualModel(model)];
    }

    threadForSession(sessionId: string): Thread {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Unknown Codex CLI session ${sessionId}`);
        }
        this.refreshAndPersistSession(session);
        const nowSeconds = Math.floor(session.updatedAt / 1000);
        return {
            id: session.sessionId,
            sessionId: session.sessionId,
            forkedFromId: null,
            parentThreadId: null,
            preview: session.lastPrompt ?? "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: nowSeconds,
            updatedAt: nowSeconds,
            recencyAt: nowSeconds,
            status: {type: "idle"},
            path: session.cliRolloutPath,
            cwd: session.cwd,
            cliVersion: "codex-cli",
            source: "exec",
            threadSource: "exec",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: session.lastPrompt,
            turns: [],
        };
    }

    private async consumeJsonl(
        stream: NodeJS.ReadableStream,
        onJsonLine: (line: string) => void | Promise<void>,
    ): Promise<void> {
        let buffer = "";
        for await (const chunk of stream) {
            buffer += chunk.toString("utf8");
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("{")) {
                    continue;
                }
                await onJsonLine(trimmed);
            }
        }
        const trimmed = buffer.trim();
        if (trimmed.startsWith("{")) {
            await onJsonLine(trimmed);
        }
    }

    private handleCliDiagnostic(line: string, state: CliRunState): void {
        try {
            this.handleCliEvent(line, state);
        } catch {
            logger.log("Codex CLI diagnostic", {sessionId: state.session.sessionId, line});
        }
    }

    private handleCliEvent(line: string, state: CliRunState): void {
        let event: CliJsonEvent;
        try {
            event = JSON.parse(line) as CliJsonEvent;
        } catch {
            logger.log("Ignoring non-JSON Codex CLI output", {line});
            return;
        }
        switch (event.type) {
            case "thread.started":
                if (typeof event.thread_id === "string" && event.thread_id.length > 0) {
                    state.session.cliThreadId = event.thread_id;
                    this.refreshAndPersistSession(state.session);
                }
                return;
            case "turn.started":
                return;
            case "item.started":
                this.handleCliItem(event.item, state, false);
                return;
            case "item.completed":
                this.handleCliItem(event.item, state, true);
                return;
            case "turn.completed":
                this.handleCliTurnCompleted(event, state);
                return;
            default:
                logger.log("Ignoring unsupported Codex CLI event", {
                    sessionId: state.session.sessionId,
                    type: event.type,
                });
        }
    }

    private handleCliItem(rawItem: Record<string, unknown> | undefined, state: CliRunState, completed: boolean): void {
        const item = this.convertCliItem(rawItem, state, completed);
        if (!item) {
            return;
        }
        const existingIndex = state.items.findIndex(existing => existing.id === item.id);
        if (existingIndex >= 0) {
            state.items[existingIndex] = item;
        } else {
            state.items.push(item);
        }

        if (item.type === "agentMessage") {
            if (item.text.length > 0) {
                this.emit(state.session.sessionId, {
                    method: "item/agentMessage/delta",
                    params: {
                        threadId: state.session.sessionId,
                        turnId: state.turnId,
                        itemId: item.id,
                        delta: item.text,
                    },
                } as ServerNotification);
            }
            return;
        }

        this.emit(state.session.sessionId, {
            method: completed ? "item/completed" : "item/started",
            params: {
                threadId: state.session.sessionId,
                turnId: state.turnId,
                item,
                [completed ? "completedAtMs" : "startedAtMs"]: Date.now(),
            },
        } as ServerNotification);
    }

    private convertCliItem(
        rawItem: Record<string, unknown> | undefined,
        state: CliRunState,
        completed: boolean,
    ): ThreadItem | null {
        if (!rawItem) {
            return null;
        }
        const id = stringValue(rawItem["id"]) ?? crypto.randomUUID();
        const status = completed ? "completed" : "inProgress";
        switch (rawItem["type"]) {
            case "agent_message":
                return {
                    type: "agentMessage",
                    id,
                    text: stringValue(rawItem["text"]) ?? "",
                    phase: null,
                    memoryCitation: null,
                };
            case "command_execution":
                return {
                    type: "commandExecution",
                    id,
                    command: stringValue(rawItem["command"]) ?? "",
                    cwd: state.session.cwd,
                    processId: null,
                    source: "agent",
                    status: cliStatus(rawItem["status"], status),
                    commandActions: [],
                    aggregatedOutput: stringValue(rawItem["aggregated_output"]) ?? null,
                    exitCode: numberValue(rawItem["exit_code"]),
                    durationMs: numberValue(rawItem["duration_ms"]),
                };
            case "mcp_tool_call":
                return {
                    type: "mcpToolCall",
                    id,
                    server: stringValue(rawItem["server"]) ?? stringValue(rawItem["server_name"]) ?? "mcp",
                    tool: stringValue(rawItem["tool"]) ?? stringValue(rawItem["tool_name"]) ?? "tool",
                    status: cliStatus(rawItem["status"], status),
                    arguments: jsonValue(rawItem["arguments"] ?? rawItem["input"]),
                    appContext: null,
                    pluginId: null,
                    result: mcpResultValue(rawItem["result"]),
                    error: mcpErrorValue(rawItem["error"]),
                    durationMs: numberValue(rawItem["duration_ms"]),
                };
            case "function_call":
            case "custom_tool_call":
                return {
                    type: "dynamicToolCall",
                    id,
                    namespace: null,
                    tool: stringValue(rawItem["name"]) ?? "tool",
                    arguments: jsonValue(rawItem["arguments"] ?? rawItem["input"]),
                    status: cliStatus(rawItem["status"], status),
                    contentItems: null,
                    success: completed ? true : null,
                    durationMs: numberValue(rawItem["duration_ms"]),
                };
            default:
                return null;
        }
    }

    private handleCliTurnCompleted(event: CliJsonEvent, state: CliRunState): void {
        const usage = usageBreakdown(event.usage);
        if (usage) {
            this.emit(state.session.sessionId, {
                method: "thread/tokenUsage/updated",
                params: {
                    threadId: state.session.sessionId,
                    turnId: state.turnId,
                    tokenUsage: {
                        last: usage,
                        total: usage,
                        modelContextWindow: null,
                    },
                },
            } as ServerNotification);
        }
        state.completed = {
            threadId: state.session.sessionId,
            turn: createTurn(state.turnId, "completed", state.items, state.startedAt),
        };
    }

    private emit(sessionId: string, event: ServerNotification): void {
        const handler = this.handlers.get(sessionId);
        if (handler) {
            void handler(event);
        }
    }

    private refreshAndPersistSession(session: CliSession): void {
        if (!session.cliThreadId) {
            return;
        }
        session.cliRolloutPath = session.cliRolloutPath ?? findCodexRolloutPath(session.cliThreadId);
        ensureCodegSessionAlias(session);
        persistCliSession(session);
    }
}

function buildCodexExecArgs(params: {
    session: CliSession;
    prompt: string;
    modelId: ModelId;
    agentMode: AgentMode;
    serviceTier: ServiceTier | null;
    disableSummary: boolean;
}): string[] {
    const args: string[] = [];
    const isResume = params.session.cliThreadId !== null;
    args.push("exec");
    args.push("--json", "--skip-git-repo-check", "-C", params.session.cwd);
    args.push("-m", params.modelId.model);
    args.push("-s", codexSandboxArg(params.agentMode));
    if (params.disableSummary) {
        args.push("-c", "model_reasoning_summary=\"none\"");
    }
    if (params.serviceTier) {
        args.push("-c", `service_tier=${tomlString(params.serviceTier)}`);
    }
    for (const root of params.session.additionalDirectories) {
        args.push("--add-dir", root);
    }
    args.push(...mcpServerConfigArgs(params.session.mcpServers));
    if (isResume) {
        args.push("resume", params.session.cliThreadId!);
    }
    args.push(params.prompt.length > 0 ? params.prompt : " ");
    return args;
}

export function mcpServerConfigArgs(mcpServers: acp.McpServer[]): string[] {
    const args: string[] = [];
    for (const server of mcpServers) {
        const name = sanitizeMcpName(server.name);
        if ("type" in server) {
            if (server.type === "http") {
                args.push("-c", `mcp_servers.${name}.url=${tomlString(server.url)}`);
                if (server.headers.length > 0) {
                    args.push("-c", `mcp_servers.${name}.http_headers=${tomlInlineTable(Object.fromEntries(server.headers.map(header => [header.name, header.value])))}`);
                }
            }
            continue;
        }
        args.push("-c", `mcp_servers.${name}.command=${tomlString(server.command)}`);
        if (server.args.length > 0) {
            args.push("-c", `mcp_servers.${name}.args=${tomlArray(server.args)}`);
        }
        if (server.env.length > 0) {
            args.push("-c", `mcp_servers.${name}.env=${tomlInlineTable(Object.fromEntries(server.env.map(env => [env.name, env.value])))}`);
        }
    }
    return args;
}

function promptText(prompt: acp.ContentBlock[]): string {
    return prompt.map(block => {
        switch (block.type) {
            case "text":
                return block.text;
            case "resource_link":
                return block.name ? `[@${block.name}](${block.uri})` : block.uri;
            case "resource":
                if ("text" in block.resource) {
                    return `<context ref="${block.resource.uri}">\n${block.resource.text}\n</context>`;
                }
                return `<context ref="${block.resource.uri}" mimeType="${block.resource.mimeType ?? "application/octet-stream"}" encoding="base64">\n${block.resource.blob}\n</context>`;
            case "image":
                return `[image: ${block.uri ?? `${block.mimeType};base64,${block.data.slice(0, 32)}...`}]`;
            case "audio":
                return "";
        }
    }).filter(part => part.length > 0).join("\n\n");
}

function createTurn(id: string, status: Turn["status"], items: ThreadItem[], startedAtMs: number): Turn {
    const completedAt = status === "inProgress" ? null : Math.floor(Date.now() / 1000);
    return {
        id,
        items,
        itemsView: "full",
        status,
        error: null,
        startedAt: Math.floor(startedAtMs / 1000),
        completedAt,
        durationMs: completedAt === null ? null : Date.now() - startedAtMs,
    };
}

function createVirtualModel(id: string): Model {
    return {
        id,
        model: id,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: id,
        description: "Codex CLI model",
        hidden: false,
        supportedReasoningEfforts: [
            {reasoningEffort: "low", description: "Low"},
            {reasoningEffort: "medium", description: "Medium"},
            {reasoningEffort: "high", description: "High"},
            {reasoningEffort: "xhigh", description: "Extra high"},
        ],
        defaultReasoningEffort: "medium",
        inputModalities: ["text"],
        supportsPersonality: false,
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: true,
    };
}

function codexSandboxArg(agentMode: AgentMode): string {
    switch (agentMode.sandboxPolicy.type) {
        case "readOnly":
            return "read-only";
        case "dangerFullAccess":
            return "danger-full-access";
        case "workspaceWrite":
            return "workspace-write";
        case "externalSandbox":
            return "workspace-write";
    }
}

function resolveCodexPath(): string {
    return process.env["CODEX_PATH"]?.trim() || "codex";
}

function codexHome(): string {
    return process.env["CODEX_HOME"]?.trim() || path.join(os.homedir(), ".codex");
}

function cliSessionMapPath(): string {
    return path.join(codexHome(), CLI_SESSION_MAP_FILENAME);
}

function readPersistedCliSessions(): Record<string, PersistedCliSession> {
    try {
        const parsed = JSON.parse(fs.readFileSync(cliSessionMapPath(), "utf8")) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {};
        }
        const sessions: Record<string, PersistedCliSession> = {};
        for (const [key, value] of Object.entries(parsed)) {
            const record = value && typeof value === "object" && !Array.isArray(value)
                ? value as Record<string, unknown>
                : null;
            const sessionId = record ? stringValue(record["sessionId"]) : null;
            const cliThreadId = record ? stringValue(record["cliThreadId"]) : null;
            if (!sessionId || !cliThreadId) {
                continue;
            }
            sessions[key] = {
                sessionId,
                cliThreadId,
                cliRolloutPath: record ? stringValue(record["cliRolloutPath"]) : null,
                cwd: record ? stringValue(record["cwd"]) ?? process.cwd() : process.cwd(),
                lastPrompt: record ? stringValue(record["lastPrompt"]) : null,
                updatedAt: record ? numberValue(record["updatedAt"]) ?? Date.now() : Date.now(),
            };
        }
        return sessions;
    } catch {
        return {};
    }
}

function readPersistedCliSession(sessionId: string): PersistedCliSession | null {
    return readPersistedCliSessions()[sessionId] ?? null;
}

function persistCliSession(session: CliSession): void {
    if (!session.cliThreadId) {
        return;
    }

    const sessions = readPersistedCliSessions();
    sessions[session.sessionId] = {
        sessionId: session.sessionId,
        cliThreadId: session.cliThreadId,
        cliRolloutPath: session.cliRolloutPath,
        cwd: session.cwd,
        lastPrompt: session.lastPrompt,
        updatedAt: session.updatedAt,
    };
    try {
        fs.mkdirSync(codexHome(), {recursive: true});
        fs.writeFileSync(cliSessionMapPath(), `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
    } catch (error) {
        logger.log("Failed to persist Codex CLI session mapping", {
            sessionId: session.sessionId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

function ensureCodegSessionAlias(session: CliSession): void {
    if (!session.cliRolloutPath || session.sessionId === session.cliThreadId) {
        return;
    }

    const aliasPath = codegSessionAliasPath(session.cliRolloutPath, session.sessionId);
    try {
        if (!fs.existsSync(session.cliRolloutPath)) {
            return;
        }
        if (fs.existsSync(aliasPath)) {
            const target = fs.statSync(session.cliRolloutPath);
            const alias = fs.statSync(aliasPath);
            if (target.dev === alias.dev && target.ino === alias.ino) {
                return;
            }
            fs.unlinkSync(aliasPath);
        }
        fs.linkSync(session.cliRolloutPath, aliasPath);
    } catch (error) {
        logger.log("Failed to create Codeg Codex CLI session alias", {
            sessionId: session.sessionId,
            cliThreadId: session.cliThreadId,
            rolloutPath: session.cliRolloutPath,
            aliasPath,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

function codegSessionAliasPath(rolloutPath: string, sessionId: string): string {
    const safeSessionId = sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
    return path.join(path.dirname(rolloutPath), `codeg-acp-session-${safeSessionId}.jsonl`);
}

function findCodexRolloutPath(sessionId: string): string | null {
    const sessionsDir = path.join(codexHome(), "sessions");
    const suffix = `${sessionId}.jsonl`;
    const stack: string[] = [sessionsDir];

    while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: Dirent[];
        try {
            entries = fs.readdirSync(dir, {withFileTypes: true})
                .sort((a, b) => b.name.localeCompare(a.name));
        } catch {
            continue;
        }

        for (const entry of entries) {
            const entryPath = path.join(dir, entry.name);
            if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(suffix)) {
                return entryPath;
            }
            if (entry.isDirectory()) {
                stack.push(entryPath);
            }
        }
    }

    return null;
}

function sanitizeMcpName(name: string): string {
    return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

function tomlString(value: string): string {
    return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
    return `[${values.map(tomlString).join(", ")}]`;
}

function tomlInlineTable(values: Record<string, string>): string {
    return `{${Object.entries(values).map(([key, value]) => `${key}=${tomlString(value)}`).join(", ")}}`;
}

function redactArgs(args: string[]): string[] {
    return args.map(arg => arg.includes("api_key") || arg.includes("TOKEN") ? "<redacted>" : arg);
}

function stringValue(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
    return typeof value === "number" ? value : null;
}

function jsonValue(value: unknown): JsonValue {
    if (typeof value === "string") {
        try {
            return JSON.parse(value) as JsonValue;
        } catch {
            return value;
        }
    }
    if (value === undefined) {
        return {};
    }
    return value as JsonValue;
}

function mcpResultValue(value: unknown): {content: JsonValue[]; structuredContent: JsonValue | null; _meta: JsonValue | null} | null {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === "object" && !Array.isArray(value) && "content" in value) {
        const record = value as Record<string, unknown>;
        return {
            content: Array.isArray(record["content"]) ? record["content"] as JsonValue[] : [jsonValue(record["content"])],
            structuredContent: jsonValue(record["structuredContent"] ?? record["structured_content"] ?? null),
            _meta: jsonValue(record["_meta"] ?? null),
        };
    }
    return {
        content: [jsonValue(value)],
        structuredContent: null,
        _meta: null,
    };
}

function mcpErrorValue(value: unknown): {message: string} | null {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === "object" && !Array.isArray(value) && "message" in value) {
        const message = stringValue((value as Record<string, unknown>)["message"]);
        return {message: message ?? JSON.stringify(value)};
    }
    return {
        message: typeof value === "string" ? value : JSON.stringify(value),
    };
}

function cliStatus(value: unknown, fallback: "inProgress" | "completed"): "inProgress" | "completed" | "failed" {
    if (value === "in_progress") {
        return "inProgress";
    }
    if (value === "completed") {
        return "completed";
    }
    if (value === "failed") {
        return "failed";
    }
    return fallback;
}

function usageBreakdown(value: unknown): {
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
} | null {
    if (!value || typeof value !== "object") {
        return null;
    }
    const record = value as Record<string, unknown>;
    const inputTokens = numberValue(record["input_tokens"]) ?? 0;
    const cachedInputTokens = numberValue(record["cached_input_tokens"]) ?? 0;
    const outputTokens = numberValue(record["output_tokens"]) ?? 0;
    const reasoningOutputTokens = numberValue(record["reasoning_output_tokens"]) ?? 0;
    const totalTokens = numberValue(record["total_tokens"]) ?? inputTokens + outputTokens;
    return {
        totalTokens,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningOutputTokens,
    };
}

function waitForExit(child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0 || signal === "SIGINT" || signal === "SIGTERM") {
                resolve();
            } else {
                reject(new Error(`codex exec exited with code ${code ?? "null"} signal ${signal ?? "null"}`));
            }
        });
    });
}

export const CODEX_CLI_RUNTIME_ENV_VAR = CLI_RUNTIME_ENV_VAR;
