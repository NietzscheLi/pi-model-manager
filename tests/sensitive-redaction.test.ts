import assert from "node:assert/strict";
import test from "node:test";
import { isSensitiveHeaderName, redactSensitiveText, redactUrlForDisplay } from "../sensitive-redaction.ts";

test("URL 展示隐藏用户名、密码与敏感 query", () => {
	const redacted = redactUrlForDisplay(
		"http://alice:p%40ss@proxy.example.com:8080/path?tenant=a&token=secret-value&key=google-key&password=query-password",
	);
	assert.doesNotMatch(redacted, /alice|p%40ss|secret-value|google-key|query-password/);
	assert.match(redacted, /REDACTED/);
	assert.match(redacted, /tenant=a/);
});

test("错误文本隐藏 URL userinfo、认证头与显式 secret", () => {
	const redacted = redactSensitiveText(
		"connect http://alice:password@proxy.example Authorization: Bearer abc123 custom-secret",
		["custom-secret"],
	);
	assert.doesNotMatch(redacted, /alice|password|abc123|custom-secret/);
	assert.match(redacted, /proxy\.example/);
});

test("缺少 URL scheme 时仍隐藏疑似 userinfo", () => {
	const redacted = redactUrlForDisplay("alice:password@proxy.example:8080");
	assert.doesNotMatch(redacted, /alice|password/);
	assert.match(redacted, /^REDACTED@proxy\.example:8080$/);
});

test("敏感 Header 名称覆盖常见变体", () => {
	for (const name of [
		"Authorization",
		"X-API_Key",
		"access-token",
		"client-secret",
		"Cookie",
		"Proxy_Authorization",
		"key",
		"db-password",
	]) {
		assert.equal(isSensitiveHeaderName(name), true, name);
	}
	assert.equal(isSensitiveHeaderName("monkey"), false);
	assert.equal(isSensitiveHeaderName("User-Agent"), false);
});
