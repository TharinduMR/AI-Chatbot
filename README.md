# AI-Chatbot

[![Repository](https://img.shields.io/badge/repo-TharinduMR/AI--Chatbot-blue?logo=github)](https://github.com/TharinduMR/AI-Chatbot)
[![Top Language](https://img.shields.io/github/languages/top/TharinduMR/AI-Chatbot)](https://github.com/TharinduMR/AI-Chatbot)
[![License](https://img.shields.io/github/license/TharinduMR/AI-Chatbot)](https://github.com/TharinduMR/AI-Chatbot)

An intelligent, multi-model conversational interface built with Node.js, Express, and NVIDIA AI models — a developer-focused reference for building fast, extensible chat applications.

---

Table of Contents

- About
- Key Features
- Screenshots / Demo
- Architecture
- Quick Start
  - Prerequisites
  - Install
  - Configuration
  - Run
- Obtaining an NVIDIA API key (free provider)
- API Reference
- Docker / Deployment
- Development & Tests
- Contributing
- Roadmap
- Troubleshooting
- License & Acknowledgements

---

About

AI-Chatbot combines a concise Node.js + Express backend with a lightweight web frontend and pluggable model adapters so you can route conversations to NVIDIA-accelerated models, hosted APIs, or custom local servers. It is intended as both a working demo and a foundation you can extend for production use.

Key Features

- Multi-model routing: switch between NVIDIA models, local model servers, or hosted providers via adapters
- Clean separation between frontend, API, and model integrations
- REST API for programmatic chat access
- Extensible middleware for logging, moderation, and custom transforms
- Simple deployability with a Dockerfile and GPU-friendly options

Screenshots / Demo

(Replace these placeholders with real media in the repo: /assets/screenshots/)

- Chat UI showing conversation bubbles and model responses
- Example conversation demonstrating multi-model switching

Architecture

- Frontend: static HTML/CSS/JS served by Express (public/ or client/)
- Backend: Node.js + Express server (server.js or index.js)
- Model adapters: modular code under lib/models or services/models that encapsulate how to call each provider
- Optional worker queue for long-running or batched requests

Quick Start

Prerequisites

- Node.js 16+ (LTS recommended)
- npm or yarn
- For NVIDIA/local inference: a CUDA-compatible GPU, matching drivers, and the vendor runtime (e.g., Triton or your model runtime)

Install

```bash
git clone https://github.com/TharinduMR/AI-Chatbot.git
cd AI-Chatbot
npm install
```

Configuration

Copy the example environment file and edit values to match your environment:

```bash
cp .env.example .env
```

Recommended environment variables (adjust to your repository's implementation):

- PORT — port Express listens on (default: 3000)
- MODEL_PROVIDER — which model provider to use (e.g. nvidia, openai, local)
- NVIDIA_ENDPOINT — URL for NVIDIA inference server (if applicable)
- NVIDIA_API_KEY — API key or bearer token for NVIDIA Build / inference gateway
- LOG_LEVEL — logging verbosity (debug, info, warn, error)

Run (development)

```bash
npm run dev
# or
node server.js
```

Open http://localhost:3000 to use the chat UI.

Obtaining an NVIDIA API key (free provider)

If you want to use NVIDIA Build-hosted models or an NVIDIA inference gateway as your provider, follow these general steps to obtain an API key / access token. The exact UI labels may change; the steps below are intentionally generic and should work for the NVIDIA Build experience.

1. Create an NVIDIA Build account
   - Visit the NVIDIA Models catalog: https://build.nvidia.com/models?filters=publisher%3Ameta%2Cpublisher%3Agoogle%2Cpublisher%3Aopenai%2Cpublisher%3Adeepseek_ai%2Cpublisher%3Adeepmind%2Cpublisher%3Amicrosoft%2Cpublisher%3Az_ai
   - Sign up or sign in with your NVIDIA account (you may be asked to verify your email).

2. Locate the API / Developer section
   - After signing in, open the dashboard or account area. Look for menu items such as "API Keys", "Access Tokens", "Developer", or "Account Settings".
   - If you cannot find it, check the NVIDIA Build documentation or the model page for a "Get API key" or "Get started" link.

3. Generate a key or token
   - Use the dashboard's "Create API Key" (or similar) button. Give the key a descriptive name (e.g., "AI-Chatbot-local-dev").
   - Some providers offer a free tier; check usage limits and quotas. Copy the generated key/token — you will not always be able to view it again.

4. Configure your environment
   - Paste the key into your .env file using the variable name your app expects. Example:

```dotenv
NVIDIA_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NVIDIA_ENDPOINT=https://api.build.nvidia.com/v1/infer
MODEL_PROVIDER=nvidia
```

- If the provider requires Authorization in requests, the typical header is:

Authorization: Bearer <NVIDIA_API_KEY>

Example curl (replace the endpoint and payload with the model's docs):

```bash
curl -X POST "$NVIDIA_ENDPOINT/models/<MODEL_ID>/invoke" \
  -H "Authorization: Bearer $NVIDIA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "input": "Hello world" }'
```

Notes & troubleshooting

- Free tiers and quotas: NVIDIA Build may offer free trials or free-tier usage for selected models; review the billing and usage page in your account to avoid unexpected charges.
- Model selection: the Models catalog link above lists many publishers (Meta, Google, OpenAI, DeepMind, Microsoft, etc.). Not all models are hosted or available under the same terms—check the model's page for usage limits and pricing.
- Local GPU inference: if you prefer to run models locally (instead of connecting to a hosted NVIDIA endpoint), you do not need an API key — instead, set MODEL_PROVIDER=local and configure the local runtime path in your app config.

API Reference

Common endpoints (confirm exact routes in `routes/` or `api/` in the repository):

- POST /api/chat
  - Request: { "message": string, "model": string (optional), "conversationId": string (optional) }
  - Response: { "reply": string, "model": string, "meta": { ... } }
- GET /api/health
  - Response: { "status": "ok", "models": [...] }

Check the server route files for precise payloads and validation.

Docker / Deployment

A simple production Dockerfile example (add GPU support with the NVIDIA Container Toolkit if needed):

```Dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
```

For GPU workloads, use a CUDA-enabled base image or add nvidia runtime flags (see NVIDIA Container Toolkit docs).

Development & Tests

- Follow feature-branch workflow: fork → branch → PR
- Add unit/integration tests where applicable
- Use ESLint/Prettier for consistent style (consider adding a config if none exists)

Contributing

Contributions are welcome — please open issues for feature requests and bugs, and follow these steps:

1. Fork the repository
2. Create a branch: git checkout -b feat/your-feature
3. Make changes and add tests
4. Open a Pull Request describing your changes

Roadmap

- Add user auth and persistent per-user conversation history
- Websocket support for streaming/progressive responses
- Plugin system for knowledge connectors (search, vector DBs)
- Enhanced UI with accessibility improvements

Troubleshooting

- Model server unreachable: confirm NVIDIA_ENDPOINT and network rules
- GPU errors: verify drivers, CUDA version, and that Docker runtime exposes GPU
- CORS errors: update Express CORS middleware or the frontend dev proxy

License

MIT — see the LICENSE file in this repository.

Acknowledgements

Built with Node.js and Express. Inspired by NVIDIA model-serving patterns and modern conversational UI patterns.

Contact

Maintained by TharinduMR — https://github.com/TharinduMR

---

Notes / Next steps I can help with:
- Update the README to include detected endpoints and actual env variables from your code (I can scan the repo to extract these)
- Add screenshots or a demo GIF (upload images to /assets and I will insert them)
- Create CONTRIBUTING.md and CODE_OF_CONDUCT
