// 由私有 request-capture-service 根据真实客户端请求生成；公开插件仅消费这些脱敏后的内置值。

export const CLAUDE_CODE_CLIENT_HEADERS: Record<string, string> = {
	"user-agent": "claude-cli/2.1.219 (external, sdk-cli)",
	"x-stainless-arch": "x64",
	"x-stainless-lang": "js",
	"x-stainless-os": "Windows",
	"x-stainless-package-version": "0.94.0",
	"x-stainless-retry-count": "0",
	"x-stainless-runtime": "node",
	"x-stainless-runtime-version": "v26.3.0",
	"x-stainless-timeout": "300",
	"anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,effort-2025-11-24",
	"anthropic-dangerous-direct-browser-access": "true",
	"anthropic-version": "2023-06-01",
	"x-app": "cli",
};

export const CODEX_CLI_CLIENT_HEADERS: Record<string, string> = {
	"user-agent": "codex-tui/0.145.0 (Windows 10.0.26200; x86_64) WindowsTerminal (codex-tui; 0.145.0)",
	"originator": "codex-tui",
	"x-codex-beta-features": "remote_compaction_v2",
};
