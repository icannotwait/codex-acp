import {afterEach, beforeEach, describe, expect, it, vi} from "vitest"
import {CodexAcpClient} from "../../CodexAcpClient"
import {CodexAppServerClient} from "../../CodexAppServerClient"
import {createTestModel} from "../acp-test-utils"
import {createMockConnections, type MockConnections} from "./test-utils"

describe("CLI model control plane", () => {
    let mocks: MockConnections
    let appServer: CodexAppServerClient
    let client: CodexAcpClient

    beforeEach(() => {
        vi.stubEnv("CODEX_ACP_USE_CLI", "1")
        mocks = createMockConnections()
        appServer = new CodexAppServerClient(mocks.mockCodexConnection)
        client = new CodexAcpClient(appServer)
    })

    afterEach(() => {
        vi.clearAllMocks()
        vi.unstubAllEnvs()
    })

    it("uses app-server models and config defaults for a new CLI session", async () => {
        const first = createTestModel({id: "gpt-5.2", isDefault: true})
        const configured = createTestModel({
            id: "gpt-5.4",
            isDefault: false,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
                {reasoningEffort: "medium", description: "Medium"},
                {reasoningEffort: "high", description: "High"},
            ],
        })
        vi.spyOn(appServer, "listModels").mockResolvedValue({
            data: [first, configured],
            nextCursor: null,
        })
        vi.spyOn(appServer, "configRead").mockResolvedValue({
            config: {
                model: "gpt-5.4",
                model_reasoning_effort: "high",
            },
            origins: {},
            layers: [],
        } as any)
        const threadStart = vi.spyOn(appServer, "threadStart")

        const session = await client.newSession({cwd: "/workspace", mcpServers: []})

        expect(session.models.map(model => model.id)).toEqual(["gpt-5.2", "gpt-5.4"])
        expect(session.currentModelId).toBe("gpt-5.4[high]")
        expect(threadStart).not.toHaveBeenCalled()
    })

    it("exposes paginated app-server models in CLI mode", async () => {
        const pageOne = createTestModel({id: "gpt-5.2", isDefault: true})
        const pageTwo = createTestModel({id: "gpt-5.4", isDefault: false})
        vi.spyOn(appServer, "listModels")
            .mockResolvedValueOnce({
                data: [pageOne],
                nextCursor: "cursor-2",
            })
            .mockResolvedValueOnce({
                data: [pageTwo],
                nextCursor: null,
            })
        vi.spyOn(appServer, "configRead").mockResolvedValue({
            config: {
                model: "gpt-5.2",
                model_reasoning_effort: "medium",
            },
            origins: {},
            layers: [],
        } as any)

        const session = await client.newSession({cwd: "/workspace", mcpServers: []})

        expect(session.models.map(model => model.id)).toEqual(["gpt-5.2", "gpt-5.4"])
        expect(appServer.listModels).toHaveBeenCalledTimes(2)
        expect(appServer.listModels).toHaveBeenNthCalledWith(1, {cursor: null, limit: null})
        expect(appServer.listModels).toHaveBeenNthCalledWith(2, {cursor: "cursor-2", limit: null})
    })

    it("preserves custom provider model ids absent from the catalog", async () => {
        const catalog = createTestModel({id: "gpt-5.2", isDefault: true})
        vi.spyOn(appServer, "listModels").mockResolvedValue({
            data: [catalog],
            nextCursor: null,
        })
        vi.spyOn(appServer, "configRead").mockResolvedValue({
            config: {
                model: "MiniMax-M3",
                model_reasoning_effort: "high",
            },
            origins: {},
            layers: [],
        } as any)

        const session = await client.newSession({cwd: "/workspace", mcpServers: []})

        expect(session.models.map(model => model.id)).toEqual(["gpt-5.2"])
        expect(session.currentModelId).toBe("MiniMax-M3[high]")
    })

    it("rejects CLI sessions when app-server returns no models", async () => {
        vi.spyOn(appServer, "listModels").mockResolvedValue({
            data: [],
            nextCursor: null,
        })
        vi.spyOn(appServer, "configRead").mockResolvedValue({
            config: {},
            origins: {},
            layers: [],
        } as any)

        await expect(
            client.newSession({cwd: "/workspace", mcpServers: []})
        ).rejects.toThrow("Codex did not return any models")
    })
})
