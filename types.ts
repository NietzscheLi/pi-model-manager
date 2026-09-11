// pi-model-manager 类型定义。
// 命名约定：
//   Stored*  → models.json 与 state.json metadata 合成后的运行时视图
//   *Draft   → TUI 编辑器中可变中间态
//   *Outcome → 异步流程结果联合类型

// ========== 基础枚举 ==========

export type ApiKind = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
export type ModelInputKind = "text" | "image";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;
type ModelMetadataSource = "models.dev" | "openrouter" | "manual";
export type ReasoningMode = "enabled" | "disabled";
export type AnthropicThinkingProtocol = "adaptive" | "legacy";
export type OpenAIChatCompatibilityMode = "standard" | "compatible";
export type OpenAIResponsesStreamCompletionMode = "standard" | "terminal-event";
export type BuiltInClientHeaderProfileId = "claude-code" | "codex-cli";
export type ClientHeaderProfileId = "recommended" | "disabled" | BuiltInClientHeaderProfileId | "custom";
export type CompatSettings = Record<string, unknown>;
export type OpenAIServiceTier = "priority";

export const DEFAULT_PROVIDER_HTTP_PROXY_URL = "http://127.0.0.1:7890";

/** 旧版 models.json/state.json 单一 apiKey 导入或预设初始 key 时使用的保留 ID。 */
export const DEFAULT_API_KEY_ID = "default";

// ========== 持久配置合成 schema ==========

export interface TokenCostTier {
	inputTokensAbove: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface TokenCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: TokenCostTier[];
}

export interface StoredRequestHeaderProfile {
	name: string;
	headers: Record<string, string>;
}

export interface StoredClientHeaderCapture {
	capturedAt: string;
	headers: Record<string, string>;
}

export interface StoredModel {
	id: string;
	/** 仅保存相对 provider 默认值的显式模型级覆盖。 */
	api?: string;
	baseUrl?: string;
	/** 不含插件请求头 profile 所管理字段的原生模型请求头。 */
	headers?: Record<string, string>;
	name?: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ModelInputKind[];
	contextWindow: number;
	maxTokens: number;
	cost: TokenCost;
	/** 旧版模型级请求头字段，仅用于读取旧 state 后折叠到接入级。 */
	clientHeaderProfile?: ClientHeaderProfileId;
	requestHeaderProfileId?: string;
	customClientHeaders?: Record<string, string>;
	/** 指向供应商 apiKeys 中的命名 key；未设置时使用默认 key。 */
	apiKeyId?: string;
	openAIServiceTier?: OpenAIServiceTier;
	compat?: CompatSettings;
}

/** 供应商下的命名 API key；模型通过 id 引用，默认 key 仍存于 models.json 的 apiKey。 */
export interface StoredApiKey {
	id: string;
	label?: string;
	value: string;
}

/** 供应商默认 key：显式标记优先，否则回退列表首个；两者都无则 undefined。 */
export function resolveDefaultApiKeyId(provider: { apiKeys?: StoredApiKey[]; defaultApiKeyId?: string }): string | undefined {
	const keys = provider.apiKeys ?? [];
	if (provider.defaultApiKeyId && keys.some((key) => key.id === provider.defaultApiKeyId)) return provider.defaultApiKeyId;
	return keys[0]?.id;
}

export function resolveDefaultApiKeyValue(provider: { apiKeys?: StoredApiKey[]; defaultApiKeyId?: string }): string | undefined {
	const keyId = resolveDefaultApiKeyId(provider);
	if (!keyId) return undefined;
	return provider.apiKeys?.find((key) => key.id === keyId)?.value;
}

export interface StoredProvider {
	name: string;
	api: ApiKind;
	baseUrl: string;
	/** 运行时所有权，未接管的原生 Provider 不由插件生成请求头或动态注册。 */
	managed: boolean;
	/** models.json 中不由 TUI 编辑、但必须跨保存和重命名保真的原生字段。 */
	headers?: Record<string, string>;
	compat?: CompatSettings;
	modelOverrides?: Record<string, unknown>;
	authHeader?: boolean;
	clientHeaderProfile: ClientHeaderProfileId;
	requestHeaderProfileId?: string;
	customClientHeaders?: Record<string, string>;
	/** 插件私有命名 key；models.json 只保存默认 key。 */
	apiKeys?: StoredApiKey[];
	/** 写入 models.json apiKey 并作为模型默认回退的 key ID。 */
	defaultApiKeyId?: string;
	httpProxyEnabled?: boolean;
	httpProxyUrl?: string;
	/** Responses 终态事件已完整转交后，是否主动结束本地 SSE 流。 */
	openAIResponsesStreamCompletionMode?: OpenAIResponsesStreamCompletionMode;
	models: StoredModel[];
}

export interface StateDocument {
	version: 2;
	providers: Record<string, StoredProvider>;
	/** state.json 中明确由插件创建或接管的 Provider ID。 */
	managedProviderIds: string[];
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>;
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>>;
}

// ========== TUI draft（可变中间态） ==========

export interface ProviderDraft {
	providerId: string;
	providerName: string;
	api: ApiKind;
	/** Chat Completions 系统提示词兼容模式；standard 保持 Pi 默认判断。 */
	openAIChatCompatibilityMode?: OpenAIChatCompatibilityMode;
	/** Responses 流结束模式；terminal-event 不等待上游关闭连接。 */
	openAIResponsesStreamCompletionMode?: OpenAIResponsesStreamCompletionMode;
	baseUrl: string;
	authHeader: boolean;
	clientHeaderProfile: ClientHeaderProfileId;
	requestHeaderProfileId?: string;
	customClientHeaders: Record<string, string>;
	apiKeys: StoredApiKey[];
	/** 默认 key ID；新建接入时由预设播下，写入 models.json 并作为模型回退。 */
	defaultApiKeyId?: string;
	httpProxyEnabled: boolean;
	httpProxyUrl: string;
	selectedIndex: number;
}

export interface ModelDraft {
	providerId: string;
	providerName: string;
	api: ApiKind;
	baseUrl: string;
	authHeader: boolean;
	clientHeaderProfile: ClientHeaderProfileId;
	requestHeaderProfileId?: string;
	customClientHeaders: Record<string, string>;
	apiKeys: StoredApiKey[];
	/** 模型级 key 选择；未设置时回退供应商默认 key。 */
	apiKeyId?: string;
	/** 供应商默认 key ID；用于展示回退目标。 */
	defaultApiKeyId?: string;
	httpProxyEnabled: boolean;
	httpProxyUrl: string;
	modelId: string;
	modelName: string;
	inputKinds: ModelInputKind[];
	/** 供应商级协议；模型未覆盖时以此为准。 */
	providerApi: ApiKind;
	/** 模型级协议覆盖；undefined 表示继承供应商。 */
	apiOverride?: ApiKind;
	metadataSource: ModelMetadataSource;
	reasoningMode: ReasoningMode;
	thinkingLevelMap?: ThinkingLevelMap;
	cost: TokenCost;
	anthropicThinkingProtocol?: AnthropicThinkingProtocol;
	contextWindow: number;
	maxTokens: number;
	openAIServiceTier?: OpenAIServiceTier;
	selectedIndex: number;
}

export interface RequestHeaderProfileDraft {
	profileId: string;
	profileName: string;
	headers: Record<string, string>;
	selectedIndex: number;
}

// ========== 异步流程结果 ==========

export type ModelListFetchOutcome =
	| { status: "loaded"; modelIds: string[] }
	| { status: "failed"; message: string }
	| { status: "cancelled" };

// ========== 常量 ==========

export const ZERO_COST: TokenCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
