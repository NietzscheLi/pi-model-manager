const codingAgentStubUrl = new URL("./pi-coding-agent-stub.ts", import.meta.url).href;
const tuiStubUrl = new URL("./pi-tui-stub.ts", import.meta.url).href;

export function resolve(specifier, context, nextResolve) {
	if (specifier === "@earendil-works/pi-coding-agent") {
		return { url: codingAgentStubUrl, shortCircuit: true };
	}
	if (specifier === "@earendil-works/pi-ai") {
		return { url: new URL("./pi-ai-stub.ts", import.meta.url).href, shortCircuit: true };
	}
	if (specifier === "@earendil-works/pi-tui") {
		return { url: tuiStubUrl, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
