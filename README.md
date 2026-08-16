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
- API_KEY — API key for hosted providers
- LOG_LEVEL — logging verbosity (debug, info, warn, error)

Run (development)

```bash
npm run dev
# or
node server.js
```

Open http://localhost:3000 to use the chat UI.

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
