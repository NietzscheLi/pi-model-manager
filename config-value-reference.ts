// Pi 配置值允许字面量、!command，以及 $NAME/${NAME} 环境变量模板。
// 这里只解析展示认证状态所需的引用信息，不执行命令或展开敏感值。

const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*/;

export function isCommandConfigValue(config: string): boolean {
	return config.startsWith("!");
}

/** [喵喵喵]: 与 Pi 0.80.10 模板语义保持一致，包括嵌入引用和 $$/$! 转义 (2026-07-17) */
export function getConfigValueEnvVarNames(config: string): string[] {
	if (isCommandConfigValue(config)) return [];
	const names: string[] = [];
	let index = 0;
	while (index < config.length) {
		const dollarIndex = config.indexOf("$", index);
		if (dollarIndex < 0) break;
		const nextCharacter = config[dollarIndex + 1];
		if (nextCharacter === "$" || nextCharacter === "!") {
			index = dollarIndex + 2;
			continue;
		}
		if (nextCharacter === "{") {
			const endIndex = config.indexOf("}", dollarIndex + 2);
			if (endIndex < 0) {
				index = dollarIndex + 1;
				continue;
			}
			const name = config.slice(dollarIndex + 2, endIndex);
			if (ENV_VAR_NAME_PATTERN.test(name) && !names.includes(name)) names.push(name);
			index = endIndex + 1;
			continue;
		}
		const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_PATTERN);
		if (match) {
			if (!names.includes(match[0])) names.push(match[0]);
			index = dollarIndex + 1 + match[0].length;
			continue;
		}
		index = dollarIndex + 1;
	}
	return names;
}

export function getSingleConfigValueEnvVarName(config: string): string | undefined {
	const bracedMatch = config.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
	if (bracedMatch) return bracedMatch[1];
	const unbracedMatch = config.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
	return unbracedMatch?.[1];
}
