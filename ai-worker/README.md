# Biblicall AI worker (biblicall-ai)

Answers questions for biblicall.com and runs the North Star step. Deployed by Cloudflare Workers Builds
in the Biblicall Cloudflare account (root directory `ai-worker`).

- Only requests from biblicall.com are accepted. Each visitor gets 20 calls a minute (a question uses two);
  each live call gets 40 a minute, within an overall cap of 600 a minute for all calls together.
- The Anthropic key is the Cloudflare secret `ANTHROPIC_API_KEY`. It is never stored in this repo.
- `mode: "northstar"` runs a lighter call (no web search) for the North Star panel.
- `memory` (list of strings) is what the visitor chose to have Biblicall remember; it goes in the system prompt.
- Also set a monthly spend limit in the Anthropic console as the final safety net.
