# pi-model-manager

English · [简体中文](./README.md)

[![Pi](https://img.shields.io/badge/Pi-%3E%3D0.82.0-6f42c1)](https://github.com/badlogic/pi-mono)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Status](https://img.shields.io/badge/status-0.1.0--dev-orange.svg)](https://github.com/Qihuanxishini/pi-model-manager)

A TUI model and provider manager for [Pi](https://github.com/badlogic/pi-mono). It keeps Pi's native `models.json` as the single source of truth for model configuration while adding provider/model editing, client-header identities, proxy routing, and protocol compatibility controls.

> **Development status:** the current version is `0.1.0-dev` and requires Pi `>=0.82.0`. Configuration and UI details may still change.

## Features

- Create, edit, and delete providers and models from the `/model-manager` TUI.
- Supports `openai-completions`, `openai-responses`, `anthropic-messages`, and `google-generative-ai`.
- Fetch model IDs from compatible upstream APIs or enter them manually.
- Configure context window, maximum output, vision input, and reasoning support.
- Choose Anthropic Adaptive Thinking or Legacy Thinking.
- Enable `service_tier=priority` (Fast mode) per OpenAI Responses model.
- Route each provider directly or through its own HTTP(S) proxy.
- Use recommended, disabled, Claude Code, Codex, or custom client-header profiles.
- Reference API keys as literals, `$ENV_VAR` / `${ENV_VAR}`, or Pi `!command` values.
- Persist configuration atomically and re-register managed providers after saving.

## Installation

### Install from GitHub (recommended for now)

```bash
pi install git:github.com/Qihuanxishini/pi-model-manager
```

Try it for the current run without adding it to Pi's package settings:

```bash
pi -e git:github.com/Qihuanxishini/pi-model-manager
```

Update Git-installed extensions with:

```bash
pi update --extensions
```

### Install from npm

The intended npm package name is `pi-model-manager`, but this development version has not been published to the registry yet. After publication, install it with:

```bash
pi install npm:pi-model-manager
```

## Quick start

1. Start the Pi TUI.
2. Run:

   ```text
   /model-manager
   ```

3. Manage providers from the dashboard:

   | Key | Action |
   | --- | --- |
   | `Enter` | Open the selected provider and manage its models |
   | `n` | Create a provider and its first model |
   | `d` | Delete the selected provider |
   | `h` | Manage reusable header profiles |
   | `Esc` | Go back or exit |

4. In an editor, use the arrow keys to select a field and press `Enter` to edit it. Toggle supported fields with `←` / `→`, then press `Ctrl+S` to save.

Saving updates and enables the model, but it does not force the current session to switch models.

## Provider and model configuration

Each provider can define:

- API protocol and base URL
- API key and authorization-header behavior
- Client-header identity
- Provider-specific HTTP(S) proxy
- One or more models

When adding a model, the extension attempts to fetch the upstream model list with a 10-second timeout. You can still enter a model ID manually if discovery fails.

Model capabilities include:

- Display name
- Text or text-and-image input
- Reasoning support
- Anthropic Adaptive/Legacy Thinking
- OpenAI Responses Fast mode
- Context window and maximum output tokens

## Client-header profiles

| Profile | Behavior |
| --- | --- |
| Recommended | Claude Code for Anthropic Messages, Codex for OpenAI Completions/Responses, and no identity headers for other protocols |
| Disabled | Adds no extension-managed client identity headers |
| Claude Code | Uses the built-in Claude Code compatibility headers and adds required Anthropic request metadata |
| Codex | Uses the built-in Codex TUI compatibility headers |
| Custom | Uses a reusable JSON header set created in the header-profile panel |

The current built-in values were derived from real client requests with authentication fields removed:

- Claude Code `2.1.219`
- Codex TUI `0.145.0`

These headers only help API gateways that require a recognized client identity; they do not replace an API key. The public repository and npm package contain **no request-capture tooling, user captures, authentication headers, or machine-local state**. Disable identity headers or create a custom profile if a built-in profile does not fit your endpoint.

Custom profiles reject authentication-related sensitive headers. Put authentication material in the provider's API-key setting instead.

## Configuration files

| Path | Purpose |
| --- | --- |
| `~/.pi/agent/models.json` | Native Pi provider and model definitions; the single source of truth for model configuration |
| `~/.pi/agent/extensions/pi-model-manager/state.json` | Extension metadata such as header choices, custom profiles, proxy switches, and Fast mode |

The extension preserves native `models.json` fields that are outside the TUI's editing scope whenever possible. Avoid modifying the same configuration file from multiple processes at once.

## Secrets and security

Pi extensions run with the current user's permissions and have full system access. Review the source before installing any third-party extension.

Prefer environment-variable or command references over plaintext secrets in `models.json`:

```text
$OPENAI_API_KEY
${ANTHROPIC_API_KEY}
!your-secret-command
```

Additional considerations:

- Custom client headers are not a credential store.
- Enabling a provider proxy routes that provider's requests through the configured proxy URL.
- Model discovery sends a network request to the configured upstream endpoint.
- The repository ignores `state.json`, runtime logs, request captures, and other machine-specific files.

## Compatibility

| Component | Requirement |
| --- | --- |
| `@earendil-works/pi-coding-agent` | `>=0.82.0` |
| `@earendil-works/pi-tui` | `>=0.75.0` |
| Runtime mode | `/model-manager` requires the Pi TUI |

The current TUI copy is Simplified Chinese.

## Local development

```bash
git clone https://github.com/Qihuanxishini/pi-model-manager.git
cd pi-model-manager
npm install
pi -e .
```

Pi loads the TypeScript entry point directly; no separate build step is required. Do not commit `state.json`, `bootstrap-meta.json`, `node_modules`, or request-capture data.

Inspect the public package contents with:

```bash
npm pack --dry-run
```

## Reporting issues

Open a reproducible report in [GitHub Issues](https://github.com/Qihuanxishini/pi-model-manager/issues). Remove API keys, authentication headers, proxy credentials, and private endpoints before sharing configuration or logs.

## License

[MIT](./LICENSE)
