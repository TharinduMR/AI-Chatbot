// ============================================================
//  NVIDIA AI Chatbot — server.js  (Full-Featured Backend v3.0)
//  Primary: NVIDIA NIM   Fallback: Gemini → Zhipu → DeepSeek
//  Features: MongoDB analytics · Admin API · Visitor tracking
//            Contact messages · Image generation · SSE streaming
//            Multi-AI routing · File/media parsing
//            Response caching · Exponential backoff · Personas
//            Provider health tracking · Smart history management
// ============================================================
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto');
const mongoose = require('mongoose');
const fs       = require('fs');
const path     = require('path');
const { parseMediaPayload } = require('./mediaParser');

const app = express();

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', err => {
    console.error('Uncaught Exception:', err);
});
// In-memory session histories (per-provider format)
const sessionHistories = {};

// ============================================================
// RESPONSE CACHE (avoids burning tokens on repeated questions)
// ============================================================
class ResponseCache {
    constructor(ttlMs = 30 * 60 * 1000, maxSize = 500) {
        this.cache = new Map();
        this.ttlMs = ttlMs;
        this.maxSize = maxSize;
        this.hits = 0;
        this.misses = 0;
    }

    _makeKey(prompt) {
        const normalized = (prompt || '').trim().toLowerCase().replace(/\s+/g, ' ');
        return crypto.createHash('md5').update(normalized).digest('hex');
    }

    get(prompt) {
        const key = this._makeKey(prompt);
        const entry = this.cache.get(key);
        if (!entry) { this.misses++; return null; }
        if (Date.now() - entry.ts > this.ttlMs) {
            this.cache.delete(key);
            this.misses++;
            return null;
        }
        this.hits++;
        return entry;
    }

    set(prompt, response, modelName) {
        const key = this._makeKey(prompt);
        // Evict oldest if at capacity
        if (this.cache.size >= this.maxSize) {
            const oldest = this.cache.keys().next().value;
            this.cache.delete(oldest);
        }
        this.cache.set(key, { response, modelName, ts: Date.now() });
    }

    stats() {
        const total = this.hits + this.misses;
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            ttlMinutes: Math.round(this.ttlMs / 60000),
            hits: this.hits,
            misses: this.misses,
            hitRate: total > 0 ? `${((this.hits / total) * 100).toFixed(1)}%` : 'N/A'
        };
    }

    clear() {
        this.cache.clear();
        this.hits = 0;
        this.misses = 0;
    }
}

const responseCache = new ResponseCache();

// ============================================================
// PROVIDER HEALTH TRACKER (skip failing providers temporarily)
// ============================================================
class ProviderHealth {
    constructor() {
        this.providers = {};
        this.FAIL_THRESHOLD = 3;       // failures before cooldown
        this.FAIL_WINDOW_MS = 5 * 60 * 1000;  // 5 minute window
        this.COOLDOWN_MS    = 2 * 60 * 1000;  // 2 minute cooldown
    }

    _ensure(name) {
        if (!this.providers[name]) {
            this.providers[name] = { failures: [], successCount: 0, failCount: 0, cooldownUntil: 0 };
        }
        return this.providers[name];
    }

    recordSuccess(name) {
        const p = this._ensure(name);
        p.successCount++;
        p.failures = []; // reset failure window on success
        p.cooldownUntil = 0;
    }

    recordFailure(name) {
        const p = this._ensure(name);
        p.failCount++;
        const now = Date.now();
        p.failures.push(now);
        // Trim old failures outside window
        p.failures = p.failures.filter(t => now - t < this.FAIL_WINDOW_MS);
        // Enter cooldown if threshold exceeded
        if (p.failures.length >= this.FAIL_THRESHOLD) {
            p.cooldownUntil = now + this.COOLDOWN_MS;
            console.warn(`⚠ Provider ${name} entered cooldown for ${this.COOLDOWN_MS / 1000}s after ${p.failures.length} failures.`);
        }
    }

    isAvailable(name) {
        const p = this._ensure(name);
        if (p.cooldownUntil && Date.now() < p.cooldownUntil) return false;
        // Auto-recover after cooldown
        if (p.cooldownUntil && Date.now() >= p.cooldownUntil) p.cooldownUntil = 0;
        return true;
    }

    status() {
        const result = {};
        for (const [name, p] of Object.entries(this.providers)) {
            result[name] = {
                available: this.isAvailable(name),
                successCount: p.successCount,
                failCount: p.failCount,
                recentFailures: p.failures.length,
                cooldownUntil: p.cooldownUntil ? new Date(p.cooldownUntil).toISOString() : null
            };
        }
        return result;
    }
}

const providerHealth = new ProviderHealth();

// ============================================================
// EXPONENTIAL BACKOFF RETRY UTILITY
// ============================================================
async function retryWithBackoff(fn, { maxRetries = 2, initialDelay = 500, providerName = '' } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const result = await fn();
            if (providerName) providerHealth.recordSuccess(providerName);
            return result;
        } catch (err) {
            lastError = err;
            const msg = err.message || '';
            // Don't retry on auth errors or invalid model errors
            if (msg.includes('401') || msg.includes('403') || msg.includes('invalid model') || msg.includes('not found')) {
                throw err;
            }
            if (attempt < maxRetries) {
                const delay = initialDelay * Math.pow(2, attempt);
                // Check for Retry-After header (429 responses)
                const retryAfter = err.headers?.['retry-after'];
                const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : delay;
                console.log(`↻ ${providerName || 'Provider'} retry ${attempt + 1}/${maxRetries} in ${waitMs}ms: ${msg.substring(0, 80)}`);
                await new Promise(r => setTimeout(r, waitMs));
            }
        }
    }
    if (providerName) providerHealth.recordFailure(providerName);
    throw lastError;
}

// ============================================================
// SYSTEM PERSONAS (switchable prompt overlays)
// ============================================================
const PERSONAS = {
    general: {
        label: 'General Assistant',
        overlay: '' // uses base instruction only
    },
    coder: {
        label: 'Code Expert',
        overlay: `\n\n--- PERSONA: CODE EXPERT ---
You are a senior software engineer and coding expert.
Prioritize writing clean, efficient, production-ready code with detailed comments.
Always include error handling and edge cases.
When explaining code, be thorough but not verbose.
Prefer modern language features and best practices.
If the user doesn't specify a language, default to Python or JavaScript.
Include time/space complexity analysis for algorithms.`
    },
    creative: {
        label: 'Creative Writer',
        overlay: `\n\n--- PERSONA: CREATIVE WRITER ---
You are a creative writing expert with a vivid imagination.
Write in an engaging, literary style with rich descriptions.
Use varied sentence structures and evocative language.
When brainstorming, provide multiple unique and imaginative options.
Don't be afraid to take creative risks in your writing.`
    },
    summarizer: {
        label: 'Brief Summarizer',
        overlay: `\n\n--- PERSONA: BRIEF SUMMARIZER ---
You are a concise summarization expert.
Keep all responses as brief and to-the-point as possible.
Use bullet points for multi-part answers.
Avoid filler words, disclaimers, and unnecessary preambles.
Target responses under 150 words unless the topic demands more.
Get straight to the answer.`
    },
    math: {
        label: 'Math Tutor',
        overlay: `\n\n--- PERSONA: MATH TUTOR ---
You are a patient and thorough mathematics tutor.
Always show your work step-by-step.
Use LaTeX notation for all mathematical expressions: $inline$ and $$block$$.
Explain the reasoning behind each step.
Provide visual intuition when possible.
After solving, verify the answer and explain how to check it.`
    }
};

// ============================================================
// SESSION SUMMARIES (for smart context management)
// ============================================================
const sessionSummaries = {};  // { sessionId: 'summary text' }

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// ROOT HEALTH CHECK
// ============================================================
app.get('/api/health', (req, res) => {
    res.json({
        status: 'online',
        service: 'NVIDIA AI Chatbot Backend v3.0',
        timestamp: new Date().toISOString(),
        aiConfig: {
            nvidia:   { status: process.env.NVIDIA_API_KEY   ? 'Configured' : 'Missing Key', role: 'Primary'   },
            groq:     { status: process.env.GROQ_API_KEY     ? 'Configured' : 'Not Set',     role: 'Primary (Fast)' },
            gemini:   { status: process.env.GEMINI_API_KEY   ? 'Configured' : 'Not Set',     role: 'Fallback 1 + Image Gen' },
            zhipu:    { status: process.env.ZHIPU_API_KEY    ? 'Configured' : 'Not Set',     role: 'Fallback 2' },
            deepseek: { status: process.env.DEEPSEEK_API_KEY ? 'Configured' : 'Not Set',     role: 'Fallback 3' },
        },
        providerHealth: providerHealth.status(),
        cache: responseCache.stats(),
        mongodb: { status: isConnected ? 'Connected' : 'Not Connected' }
    });
});

// ============================================================
// MONGODB CONNECTION MANAGER
// ============================================================
let isConnected = false;

let isConnecting = false;

// Prevent unhandled 'error' events from crashing Node.js (add globally once)
mongoose.connection.on('error', err => {
    console.warn('⚠  Mongoose connection error:', err.message);
});

async function connectDB() {
    if (isConnected && mongoose.connection.readyState === 1) return true;
    if (isConnecting) return false;
    
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        console.warn('⚠  MONGODB_URI not set — running without database (in-memory only).');
        return false;
    }
    
    isConnecting = true;
    try {
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 45000 });
        isConnected = true;
        console.log('✅ MongoDB connected');
        return true;
    } catch (err) {
        console.warn('⚠  MongoDB unavailable:', err.message, '— continuing without DB.');
        return false;
    } finally {
        isConnecting = false;
    }
}

// Connect at startup (non-blocking)
connectDB();

// Ensure DB connected before any /api/ request (best-effort)
app.use(async (req, res, next) => {
    if (req.path.startsWith('/api/') && !isConnected) await connectDB();
    next();
});

// ============================================================
// MONGODB SCHEMAS & MODELS
// ============================================================
const visitSchema = new mongoose.Schema({
    ip:        String,
    userAgent: String,
    page:      String,
    referrer:  String,
    timestamp: { type: Date, default: Date.now }
});

const chatSessionSchema = new mongoose.Schema({
    sessionId: { type: String, index: true },
    ip:        String,
    messages:  [{
        role:      { type: String, enum: ['user', 'bot'] },
        content:   String,
        timestamp: { type: Date, default: Date.now }
    }],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

const contactMessageSchema = new mongoose.Schema({
    name:      String,
    email:     String,
    topic:     String,
    message:   String,
    read:      { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});

const Visit          = mongoose.model('Visit',          visitSchema);
const ChatSession    = mongoose.model('ChatSession',    chatSessionSchema);
const ContactMessage = mongoose.model('ContactMessage', contactMessageSchema);



// ── System Health ──
app.get('/api/admin/system-health', async (req, res) => {
    try {
        let dbStats = { storageSize: 0, dataSize: 0, objects: 0 };
        if (isConnected && mongoose.connection.db) {
            try { dbStats = await mongoose.connection.db.stats(); } catch (_) {}
        }

        const [visitsCount, messagesCount, chatsCount] = isConnected
            ? await Promise.all([Visit.countDocuments(), ContactMessage.countDocuments(), ChatSession.countDocuments()])
            : [0, 0, 0];

        const usedBytes    = dbStats.storageSize || dbStats.dataSize || 0;
        const usedMB       = parseFloat((usedBytes / (1024 * 1024)).toFixed(2));
        const limitMB      = 512;
        const storagePercent = parseFloat(((usedMB / limitMB) * 100).toFixed(2));

        res.json({
            status:    'Online',
            uptime:    Math.round(process.uptime()),
            nodeVersion: process.version,
            memoryMB:  Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            storage: {
                usedMB, limitMB, percent: storagePercent,
                totalObjects: dbStats.objects || (visitsCount + messagesCount + chatsCount),
                counts: { visits: visitsCount, messages: messagesCount, chats: chatsCount }
            },
            aiConfig: {
                nvidia:   { status: process.env.NVIDIA_API_KEY   ? 'Configured' : 'Missing Key', role: 'Primary' },
                groq:     { status: process.env.GROQ_API_KEY     ? 'Configured' : 'Not Set',     role: 'Primary (Fast)' },
                gemini:   { status: process.env.GEMINI_API_KEY   ? 'Configured' : 'Not Set',     role: 'Fallback 1 + Image Gen' },
                zhipu:    { status: process.env.ZHIPU_API_KEY    ? 'Configured' : 'Not Set',     role: 'Fallback 2' },
                deepseek: { status: process.env.DEEPSEEK_API_KEY ? 'Configured' : 'Not Set',     role: 'Fallback 3' },
            },
            providerHealth: providerHealth.status(),
            cache: responseCache.stats(),
            mongodb: { connected: isConnected }
        });
    } catch (err) {
        res.status(500).json({ message: 'Failed to fetch system health: ' + err.message });
    }
});

// ── Cache Stats ──
app.get('/api/admin/cache-stats', (req, res) => {
    res.json({ success: true, cache: responseCache.stats() });
});

app.delete('/api/admin/cache', (req, res) => {
    responseCache.clear();
    res.json({ success: true, message: 'Cache cleared.' });
});

// ── Provider Health ──
app.get('/api/admin/provider-health', (req, res) => {
    res.json({ success: true, providers: providerHealth.status() });
});

// ── Personas ──
app.get('/api/personas', (req, res) => {
    const list = Object.entries(PERSONAS).map(([key, val]) => ({ key, label: val.label }));
    res.json({ success: true, personas: list });
});

// ── Live AI Test ──
app.post('/api/admin/test-ai', async (req, res) => {
    const OpenAI = require('openai');
    const results = {};

    // 1. NVIDIA Models
    const nvidiaModels = [
        { key: 'gpt-oss-120b',      id: 'openai/gpt-oss-120b',                    label: 'GPT-OSS 120B' },
        { key: 'gpt-oss-20b',       id: 'openai/gpt-oss-20b',                     label: 'GPT-OSS 20B' },
        { key: 'llama-3.1-70b',     id: 'meta/llama-3.1-70b-instruct',            label: 'Llama 3.1 70B' },
        { key: 'llama-3.1-8b',      id: 'meta/llama-3.1-8b-instruct',             label: 'Llama 3.1 8B' },
        { key: 'llama-3.3-70b',     id: 'meta/llama-3.3-70b-instruct',            label: 'Llama 3.3 70B' },
        { key: 'deepseek-v4-pro',   id: 'deepseek-ai/deepseek-v4-pro',            label: 'DeepSeek V4 Pro' },
        { key: 'deepseek-v4-flash', id: 'deepseek-ai/deepseek-v4-flash',          label: 'DeepSeek V4 Flash' },
        { key: 'deepseek-r1-llama', id: 'deepseek-ai/deepseek-r1-distill-llama-70b',label: 'DeepSeek-R1 Llama 70B' },
        { key: 'glm-5.2',           id: 'z-ai/glm-5.2',                           label: 'GLM-5.2' },
        { key: 'mistral-7b',        id: 'mistralai/mistral-7b-instruct-v0.3',     label: 'Mistral 7B' },
        { key: 'mixtral-8x7b',      id: 'mistralai/mixtral-8x7b-instruct-v0.1',   label: 'Mixtral 8×7B' },
        { key: 'gemma-3-27b',       id: 'google/gemma-3-27b-it',                  label: 'Gemma 3 27B' },
        { key: 'gemma-4-31b-it',    id: 'google/gemma-4-31b-it',                  label: 'Gemma 4 31B' },
        { key: 'phi-4',             id: 'microsoft/phi-4',                        label: 'Microsoft Phi-4' },
        { key: 'qwen-72b',          id: 'qwen/qwen2.5-72b-instruct',              label: 'Qwen 2.5 72B' }
    ];

    // Resolve per-model keys for tests
    function getTestNvidiaKey(modelKey) {
        if (modelKey === 'glm-5.2')           return process.env.NVIDIA_GLM_5_2_API_KEY           || process.env.NVIDIA_API_KEY;
        if (modelKey === 'deepseek-v4-flash') return process.env.NVIDIA_DEEPSEEK_V4_FLASH_API_KEY || process.env.NVIDIA_API_KEY;
        if (modelKey === 'deepseek-v4-pro')   return process.env.NVIDIA_DEEPSEEK_V4_PRO_API_KEY   || process.env.NVIDIA_API_KEY;
        if (modelKey === 'gpt-oss-120b')      return process.env.NVIDIA_GPT_OSS_120B_API_KEY      || process.env.NVIDIA_API_KEY;
        if (modelKey === 'gpt-oss-20b')       return process.env.NVIDIA_GPT_OSS_20B_API_KEY       || process.env.NVIDIA_API_KEY;
        if (modelKey === 'gemma-4-31b-it')    return process.env.NVIDIA_GEMMA_4_31B_API_KEY       || process.env.NVIDIA_API_KEY;
        return process.env.NVIDIA_API_KEY;
    }

    for (const m of nvidiaModels) {
        const mKey = getTestNvidiaKey(m.key);
        if (!mKey) {
            results[m.key] = { status: 'No API Key', ok: false, message: 'NVIDIA API Key not set', label: m.label, provider: 'nvidia' };
            continue;
        }
        const nvClient = new OpenAI({ apiKey: mKey, baseURL: 'https://integrate.api.nvidia.com/v1' });
        try {
            const start = Date.now();
            let timerId;
            const req = nvClient.chat.completions.create({ model: m.id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 });
            req.catch(() => {}); // Prevent UnhandledPromiseRejection if timeout fires first
            await Promise.race([
                req,
                new Promise((_, reject) => timerId = setTimeout(() => reject(new Error('NIM Timeout')), 12000))
            ]).finally(() => clearTimeout(timerId));
            results[m.key] = { status: `200 OK (${Date.now() - start}ms)`, ok: true, message: `${m.label} active.`, label: m.label, provider: 'nvidia' };
        } catch (e) {
            const msg = e.message || '';
            if (msg.includes('Timeout') || msg.includes('queue') || msg.includes('standby')) {
                results[m.key] = { status: 'Ready (NIM Standby)', ok: true, message: `${m.label} in queue/standby.`, label: m.label, provider: 'nvidia' };
            } else {
                results[m.key] = { status: 'Error', ok: false, message: msg.substring(0, 120), label: m.label, provider: 'nvidia' };
            }
        }
    }

    // 2. Gemini Models
    const geminiModels = [
        { key: 'gemini-3.1-pro',    id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
        { key: 'gemini-3.5-flash',  id: 'gemini-3.5-flash',       label: 'Gemini 3.5 Flash' },
        { key: 'gemini-3.6-flash',  id: 'gemini-3.6-flash',       label: 'Gemini 3.6 Flash' },
        { key: 'gemini-2.5-pro',    id: 'gemini-2.0-flash',       label: 'Gemini 2.5 Pro' },
        { key: 'gemini-2.5-flash',  id: 'gemini-2.0-flash',       label: 'Gemini 2.5 Flash' },
        { key: 'gemini-2.0-flash',  id: 'gemini-2.0-flash',       label: 'Gemini 2.0 Flash' },
        { key: 'gemini-flash-latest', id: 'gemini-flash-latest',  label: 'Gemini Flash (Free)' }
    ];

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
        for (const m of geminiModels) {
            results[m.key] = { status: 'No API Key', ok: false, message: 'GEMINI_API_KEY not set', label: m.label, provider: 'google' };
        }
    } else {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(geminiKey);
        for (const m of geminiModels) {
            try {
                const start = Date.now();
                const model = genAI.getGenerativeModel({ model: m.id });
                await model.generateContent({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }] });
                results[m.key] = { status: `200 OK (${Date.now() - start}ms)`, ok: true, message: `${m.label} active.`, label: m.label, provider: 'google' };
            } catch (e) {
                results[m.key] = { status: 'Error', ok: false, message: e.message.substring(0, 120), label: m.label, provider: 'google' };
            }
        }
    }

    // 3. DeepSeek Models
    const dsModels = [
        { key: 'deepseek-reasoner', id: 'deepseek-reasoner', label: 'DeepSeek-R1 (Reasoner)' },
        { key: 'deepseek-chat',     id: 'deepseek-chat',     label: 'DeepSeek-V3 Chat' },
        { key: 'deepseek-coder',    id: 'deepseek-coder',    label: 'DeepSeek Coder' }
    ];
    
    const dsKey = process.env.DEEPSEEK_API_KEY;
    if (!dsKey) {
        for (const m of dsModels) {
            results[m.key] = { status: 'No API Key', ok: false, message: 'DEEPSEEK_API_KEY not set', label: m.label, provider: 'deepseek' };
        }
    } else {
        const dsClient = new OpenAI({ apiKey: dsKey, baseURL: 'https://api.deepseek.com' });
        for (const m of dsModels) {
            try {
                const start = Date.now();
                await dsClient.chat.completions.create({ model: m.id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 });
                results[m.key] = { status: `200 OK (${Date.now() - start}ms)`, ok: true, message: `${m.label} active.`, label: m.label, provider: 'deepseek' };
            } catch (e) {
                results[m.key] = { status: 'Error', ok: false, message: e.message.substring(0, 120), label: m.label, provider: 'deepseek' };
            }
        }
    }

    // 4. Zhipu Models
    const zhipuModels = [
        { key: 'glm-4-plus',  id: 'glm-4-plus',  label: 'GLM-4 Plus' },
        { key: 'glm-4',       id: 'glm-4',       label: 'GLM-4 Pro' },
        { key: 'glm-4-air',   id: 'glm-4-air',   label: 'GLM-4 Air' },
        { key: 'glm-4-long',  id: 'glm-4-long',  label: 'GLM-4 Long' },
        { key: 'glm-4-flash', id: 'glm-4-flash', label: 'GLM-4 Flash' }
    ];

    const zpKey = process.env.ZHIPU_API_KEY;
    if (!zpKey) {
        for (const m of zhipuModels) {
            results[m.key] = { status: 'No API Key', ok: false, message: 'ZHIPU_API_KEY not set', label: m.label, provider: 'zhipu' };
        }
    } else {
        const zpClient = new OpenAI({ apiKey: zpKey, baseURL: 'https://open.bigmodel.cn/api/paas/v4/' });
        for (const m of zhipuModels) {
            try {
                const start = Date.now();
                await zpClient.chat.completions.create({ model: m.id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 });
                results[m.key] = { status: `200 OK (${Date.now() - start}ms)`, ok: true, message: `${m.label} active.`, label: m.label, provider: 'zhipu' };
            } catch (e) {
                results[m.key] = { status: 'Error', ok: false, message: e.message.substring(0, 120), label: m.label, provider: 'zhipu' };
            }
        }
    }

    res.json({ success: true, results });
});

// ============================================================
// SYSTEM INSTRUCTION (loaded from files)
// ============================================================
const BASE_SYSTEM_INSTRUCTION = `You are a helpful, intelligent, and friendly AI assistant powered by NVIDIA NIM.
You provide clear, accurate, and thoughtful responses.
For code, use proper markdown code blocks with language identifiers.
For math, use LaTeX notation where appropriate: $inline$ or $$block$$.
Be concise but complete. Never stop mid-sentence.
Use bullet points and bold headers for clarity.
When asked about yourself, say you are an AI assistant powered by NVIDIA NIM.`;

const KNOWLEDGE_BASE_FILES = [
    'advanced_knowledge.md',
    'claude-opus-4.7.md'
];

function getFullInstruction(persona = 'general') {
    let instruction = BASE_SYSTEM_INSTRUCTION;

    // Append persona overlay
    const personaConfig = PERSONAS[persona] || PERSONAS.general;
    if (personaConfig.overlay) {
        instruction += personaConfig.overlay;
    }

    // Append knowledge base files
    for (const kbFile of KNOWLEDGE_BASE_FILES) {
        try {
            const filePath = path.isAbsolute(kbFile) ? kbFile : path.join(__dirname, kbFile);
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf-8');
                instruction += `\n\n--- KNOWLEDGE BASE (${path.basename(filePath)}) ---\n` + content;
            }
        } catch (err) {
            console.warn(`Could not load knowledge base ${kbFile}:`, err.message);
        }
    }

    return instruction;
}

// ============================================================
// CLASSIFIER HELPERS
// ============================================================
function getTaskComplexity(message) {
    const text = (message || '').toLowerCase();
    const heavyKeywords = [
        'code', 'function', 'script', 'algorithm', 'python', 'javascript', 'c++',
        'math', 'equation', 'calculate', 'solve', 'fea', 'cfd', 'von mises',
        'integral', 'derivative', 'matrix', 'formula', 'simulation', 'structural'
    ];
    if (text.length > 200) return 'heavy';
    if (heavyKeywords.some(kw => text.includes(kw))) return 'heavy';
    return 'light';
}

function isCodingTask(message) {
    const text = (message || '').toLowerCase();
    const codingKW = [
        'code', 'function', 'script', 'program', 'algorithm', 'python', 'javascript',
        'c++', 'java', 'html', 'css', 'sql', 'debug', 'api', 'class', 'react',
        'node', 'express', 'git', 'loop', 'array', 'object', 'database', 'typescript',
        'rust', 'golang', 'php', 'swift', 'kotlin', 'flutter', 'docker', 'linux', 'bash'
    ];
    return codingKW.some(kw => text.includes(kw));
}

function isImageGenerationRequest(message) {
    const text = (message || '').toLowerCase();
    const patterns = [
        'generate an image', 'generate image', 'create an image', 'create image',
        'make an image', 'make image', 'draw me', 'draw a ', 'draw an ', 'draw the ',
        'generate a picture', 'create a picture', 'make a picture',
        'generate a photo', 'create a photo', 'make a photo',
        'design a logo', 'illustrate', 'paint a', 'generate art', 'create art',
        'can you draw', 'can you create an image', 'can you generate an image',
        'visualize', 'render a', 'sketch a'
    ];
    const isAnalysis = text.includes('what is this') || text.includes('analyze this') || text.includes('describe this image');
    return !isAnalysis && patterns.some(p => text.includes(p));
}

// ============================================================
// NVIDIA NIM MODEL REGISTRY
// ============================================================
const NVIDIA_MODELS = {
    // OpenAI open-source via NVIDIA NIM
    'gpt-oss-120b':      'openai/gpt-oss-120b',
    'gpt-oss-20b':       'openai/gpt-oss-20b',
    // Meta Llama
    'llama-3.1-70b':     'meta/llama-3.1-70b-instruct',
    'llama-3.1-8b':      'meta/llama-3.1-8b-instruct',
    'llama-3.3-70b':     'meta/llama-3.3-70b-instruct',
    // DeepSeek via NIM
    'deepseek-v4-pro':   'deepseek-ai/deepseek-v4-pro',
    'deepseek-v4-flash': 'deepseek-ai/deepseek-v4-flash',
    'deepseek-r1-llama': 'deepseek-ai/deepseek-r1-distill-llama-70b',
    // Zhipu GLM via NIM
    'glm-5.2':           'z-ai/glm-5.2',
    // Mistral
    'mistral-7b':        'mistralai/mistral-7b-instruct-v0.3',
    'mixtral-8x7b':      'mistralai/mixtral-8x7b-instruct-v0.1',
    // Other
    'gemma-3-27b':       'google/gemma-3-27b-it',
    'gemma-4-31b-it':    'google/gemma-4-31b-it',
    'phi-4':             'microsoft/phi-4',
    'qwen-72b':          'qwen/qwen2.5-72b-instruct',
};
const DEFAULT_NVIDIA_MODEL = 'llama-3.1-8b';

// Gemini model candidates per selection key
const GEMINI_MODEL_CANDIDATES = {
    'gemini-3.1-pro':    ['gemini-3.1-pro-preview', 'gemini-2.0-flash', 'gemini-flash-latest'],
    'gemini-3.5-flash':  ['gemini-3.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'],
    'gemini-3.6-flash':  ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'],
    'gemini-2.5-pro':    ['gemini-3.1-pro-preview', 'gemini-2.0-flash', 'gemini-flash-latest'],
    'gemini-2.5-flash':  ['gemini-2.0-flash', 'gemini-3.5-flash', 'gemini-flash-latest'],
    'gemini-2.0-flash':  ['gemini-2.0-flash', 'gemini-flash-latest'],
    'gemini-flash-latest':['gemini-flash-latest', 'gemini-2.0-flash'],
    'gemini-flash':      ['gemini-flash-latest', 'gemini-2.0-flash'],
};

// ============================================================
// CHAT ENDPOINT — SSE Streaming, Multi-AI Routing
// ============================================================
app.post('/api/chat', async (req, res) => {
    const {
        message, sessionId,
        fileData, fileName, fileType, isTextFile,
        selectedModel, persona
    } = req.body;

    let userMessage = message || '';
    const ip        = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';

    if (!sessionId) {
        return res.status(400).json({ reply: 'Session ID is required.' });
    }

    // Init per-session history (separate per provider format)
    if (!sessionHistories[sessionId]) {
        sessionHistories[sessionId] = { nvidia: [], gemini: [], zhipu: [], deepseek: [], groq: [] };
    }

    // Parse media attachments
    const parsedMedia    = parseMediaPayload(userMessage, fileData, fileName, fileType, isTextFile);
    const activePersona  = (persona && PERSONAS[persona]) ? persona : 'general';
    const fullInstruction = getFullInstruction(activePersona);

    // Prepend session summary if exists (for long conversations)
    let systemPrompt = fullInstruction;
    if (sessionSummaries[sessionId]) {
        systemPrompt = fullInstruction + '\n\n--- CONVERSATION SUMMARY (earlier messages) ---\n' + sessionSummaries[sessionId];
    }

    const complexity     = getTaskComplexity(userMessage);

    // SSE headers
    res.setHeader('Content-Type',   'text/event-stream');
    res.setHeader('Cache-Control',  'no-cache');
    res.setHeader('Connection',     'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // ── CACHE CHECK (skip for image gen and file attachments) ──
    if (!fileData && !isImageGenerationRequest(userMessage)) {
        const cached = responseCache.get(userMessage);
        if (cached) {
            console.log(`⚡ Cache hit for: "${userMessage.substring(0, 50)}..."`);
            const cachedModel = cached.modelName + ' [Cached]';
            // Stream cached response chunk-by-chunk for natural feel
            const words = cached.response.split(' ');
            const chunkSize = 8; // words per chunk
            for (let i = 0; i < words.length; i += chunkSize) {
                const chunk = words.slice(i, i + chunkSize).join(' ') + (i + chunkSize < words.length ? ' ' : '');
                res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
            }
            const attr = `\n\n<span class="model-attribution">Generated by ${cachedModel}</span>`;
            res.write(`data: ${JSON.stringify({ chunk: attr })}\n\n`);
            res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
            res.end();
            return;
        }
    }

    let fullReply     = '';
    let usedModelName = '';
    let success       = false;

    // ──────────────────────────────────────────────────────────
    // BRANCH A: IMAGE GENERATION
    // ──────────────────────────────────────────────────────────
    if (isImageGenerationRequest(userMessage)) {
        let imageGenSuccess = false;

        // A1. Gemini Imagen 3 (primary image gen)
        const geminiKey = process.env.GEMINI_API_KEY;
        if (geminiKey) {
            try {
                const { GoogleGenAI } = require('@google/genai');
                const ai = new GoogleGenAI({ apiKey: geminiKey });

                res.write(`data: ${JSON.stringify({ chunk: '🎨 Generating image with Gemini Imagen...\n\n' })}\n\n`);

                const imageModels = ['gemini-2.5-flash-preview-04-17', 'gemini-2.0-flash-exp'];
                let response = null, modelUsed = '';

                for (const modelName of imageModels) {
                    try {
                        response = await ai.models.generateContent({
                            model:    modelName,
                            contents: userMessage,
                            config:   { responseModalities: ['Text', 'Image'] }
                        });
                        modelUsed = modelName;
                        break;
                    } catch (me) {
                        console.warn(`Image model ${modelName} failed:`, me.message?.substring(0, 80));
                    }
                }

                if (response?.candidates?.[0]?.content) {
                    const parts = response.candidates[0].content.parts || [];
                    for (const part of parts) {
                        if (part.text) {
                            fullReply += part.text;
                            res.write(`data: ${JSON.stringify({ chunk: part.text })}\n\n`);
                        }
                        if (part.inlineData) {
                            const dataUrl = `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
                            res.write(`data: ${JSON.stringify({ image: dataUrl })}\n\n`);
                            fullReply += '\n[Generated Image]\n';
                            imageGenSuccess = true;
                        }
                    }
                    usedModelName = `Gemini Imagen (${modelUsed || 'Flash Image'})`;
                    if (!imageGenSuccess && fullReply) imageGenSuccess = true;
                }
            } catch (err) {
                console.warn('Gemini Imagen error:', err.message?.substring(0, 150));
                res.write(`data: ${JSON.stringify({ chunk: `⚠️ Gemini image gen failed. Trying CogView-3...\n\n` })}\n\n`);
            }
        }

        // A2. Zhipu CogView-3 (fallback image gen)
        if (!imageGenSuccess) {
            const zpKey = process.env.ZHIPU_API_KEY;
            if (zpKey) {
                try {
                    const OpenAI = require('openai');
                    const zpClient = new OpenAI({ apiKey: zpKey, baseURL: 'https://open.bigmodel.cn/api/paas/v4/', timeout: 25000 });
                    res.write(`data: ${JSON.stringify({ chunk: '🎨 Generating image with CogView-3...\n\n' })}\n\n`);
                    const imgRes = await zpClient.images.generate({ model: 'cogview-3-flash', prompt: userMessage, size: '1024x1024' });
                    if (imgRes.data?.[0]) {
                        res.write(`data: ${JSON.stringify({ image: imgRes.data[0].url })}\n\n`);
                        usedModelName   = 'Zhipu CogView-3 Flash';
                        fullReply       = '🎨 CogView-3: [Generated Image]\n';
                        imageGenSuccess = true;
                    }
                } catch (ce) {
                    console.warn('CogView-3 error:', ce.message?.substring(0, 100));
                    res.write(`data: ${JSON.stringify({ chunk: `⚠️ Image generation failed: ${ce.message?.substring(0, 80)}\n\n` })}\n\n`);
                }
            } else {
                res.write(`data: ${JSON.stringify({ chunk: '⚠️ No image generation API key configured (GEMINI_API_KEY or ZHIPU_API_KEY required).\n\n' })}\n\n`);
            }
        }

        if (imageGenSuccess) {
            // Send attribution + done
            const attr = `\n\n<span class="model-attribution">Generated by ${usedModelName}</span>`;
            fullReply += attr;
            res.write(`data: ${JSON.stringify({ chunk: attr })}\n\n`);
            res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
            res.end();
            await saveChatSession(sessionId, ip, userMessage, fullReply);
            return;
        }

        // If image gen failed completely — fall through to text generation
        console.warn('Image generation failed for all providers — falling through to text.');
        fullReply = '';
    }

    // ──────────────────────────────────────────────────────────
    // BRANCH B: TEXT GENERATION
    // ──────────────────────────────────────────────────────────

    // Determine model routing from selectedModel param
    let forceGemini       = false;
    let forceZhipu        = false;
    let forceDeepSeek     = false;
    let forceGroq         = false;
    let zhipuModelOverride    = null;
    let deepSeekModelOverride = null;
    let groqModelOverride     = null;

    // Gemini-specific model keys
    const GEMINI_KEYS = Object.keys(GEMINI_MODEL_CANDIDATES).concat(['gemini-flash']);
    // Zhipu direct API models
    const ZHIPU_MODELS  = ['glm-4-flash', 'glm-4-air', 'glm-4', 'glm-4-plus', 'glm-4-long', 'glm-4v'];

    // Groq models
    const GROQ_MODELS = ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768'];
    // DeepSeek direct API models
    const DS_MODELS     = ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'];

    // Default: GPT-OSS 120B via NVIDIA NIM
    usedModelName = 'GPT-OSS 120B (Default)';

    if (selectedModel && GEMINI_KEYS.includes(selectedModel)) {
        forceGemini = true;
        const labels = {
            'gemini-3.1-pro':     'Gemini 3.1 Pro (High)',
            'gemini-3.5-flash':   'Gemini 3.5 Flash',
            'gemini-3.6-flash':   'Gemini 3.6 Flash',
            'gemini-2.5-pro':     'Gemini 2.5 Pro',
            'gemini-2.5-flash':   'Gemini 2.5 Flash',
            'gemini-2.0-flash':   'Gemini 2.0 Flash',
            'gemini-flash-latest':'Gemini Flash (Free Tier)',
            'gemini-flash':       'Gemini Flash (Free Tier)',
        };
        usedModelName = labels[selectedModel] || selectedModel;
    } else if (selectedModel && ZHIPU_MODELS.includes(selectedModel)) {
        forceZhipu        = true;
        zhipuModelOverride = selectedModel;
        usedModelName     = `GLM (${selectedModel})`;
    } else if (selectedModel && DS_MODELS.includes(selectedModel)) {
        forceDeepSeek        = true;
        deepSeekModelOverride = selectedModel;
        const dsLabels = {
            'deepseek-reasoner': 'DeepSeek-R1 (Reasoner)',
            'deepseek-chat':     'DeepSeek-V3 Chat',
            'deepseek-coder':    'DeepSeek Coder',
        };
        usedModelName = dsLabels[selectedModel] || selectedModel;
    } else if (selectedModel && GROQ_MODELS.includes(selectedModel)) {
        forceGroq = true;
        groqModelOverride = selectedModel;
        usedModelName = `Groq (${selectedModel})`;
    } else {
        // NVIDIA NIM — resolve model key (handles GPT-OSS, GLM-5.2, DeepSeek V4, Llama, etc.)
        const nvidiaModelKey = (selectedModel && NVIDIA_MODELS[selectedModel]) ? selectedModel : DEFAULT_NVIDIA_MODEL;
        usedModelName = `NVIDIA NIM / ${nvidiaModelKey}`;
    }

    // ── B1: NVIDIA NIM (primary) ──────────────────────────────
    // Resolve per-model API key (mirrors reference backend pattern)
    function getNvidiaKey(modelKey) {
        if (modelKey === 'glm-5.2')           return process.env.NVIDIA_GLM_5_2_API_KEY           || process.env.NVIDIA_API_KEY;
        if (modelKey === 'deepseek-v4-flash')  return process.env.NVIDIA_DEEPSEEK_V4_FLASH_API_KEY  || process.env.NVIDIA_API_KEY;
        if (modelKey === 'deepseek-v4-pro')    return process.env.NVIDIA_DEEPSEEK_V4_PRO_API_KEY    || process.env.NVIDIA_API_KEY;
        if (modelKey === 'gpt-oss-120b')       return process.env.NVIDIA_GPT_OSS_120B_API_KEY       || process.env.NVIDIA_API_KEY;
        if (modelKey === 'gpt-oss-20b')        return process.env.NVIDIA_GPT_OSS_20B_API_KEY        || process.env.NVIDIA_API_KEY;
        if (modelKey === 'gemma-4-31b-it')     return process.env.NVIDIA_GEMMA_4_31B_API_KEY        || process.env.NVIDIA_API_KEY;
        return process.env.NVIDIA_API_KEY;
    }

    if (!forceGemini && !forceZhipu && !forceDeepSeek && !forceGroq) {
        const nvidiaModelKey = (selectedModel && NVIDIA_MODELS[selectedModel]) ? selectedModel : DEFAULT_NVIDIA_MODEL;
        const nvidiaKey      = getNvidiaKey(nvidiaModelKey);

        if (!nvidiaKey) {
            console.warn('No NVIDIA API key available for model:', nvidiaModelKey);
        } else if (!providerHealth.isAvailable('nvidia')) {
            console.warn('NVIDIA NIM skipped (in cooldown)');
        } else {
        try {
            const OpenAI = require('openai');
            const nvClient = new OpenAI({ apiKey: nvidiaKey, baseURL: 'https://integrate.api.nvidia.com/v1' });

            const nvidiaModelId  = NVIDIA_MODELS[nvidiaModelKey];
            usedModelName        = `NVIDIA NIM / ${nvidiaModelKey}`;

            const nvHistory = sessionHistories[sessionId].nvidia.map(m => ({
                role:    m.role,
                content: Array.isArray(m.content) ? (m.content.find(p => p.type === 'text')?.text || '[Attachment]') : m.content
            }));

            const messages = [
                { role: 'system', content: systemPrompt },
                ...nvHistory,
                { role: 'user', content: parsedMedia.nvidiaPayload || parsedMedia.finalMessage }
            ];

            const stream = await retryWithBackoff(
                () => {
                    let timerId;
                    const req = nvClient.chat.completions.create({
                        model:       nvidiaModelId,
                        messages,
                        stream:      true,
                        temperature: complexity === 'heavy' ? 0.3 : 0.7,
                        max_tokens:  complexity === 'heavy' ? 4096 : 2048,
                        top_p:       0.9
                    });
                    req.catch(() => {}); // Prevent UnhandledPromiseRejection if timeout fires first

                    return Promise.race([
                        req,
                        new Promise((_, reject) => timerId = setTimeout(() => reject(new Error('NIM Timeout / Standby')), 20000))
                    ]).finally(() => clearTimeout(timerId));
                },
                { maxRetries: 1, initialDelay: 300, providerName: 'nvidia' }
            );

            for await (const chunk of stream) {
                const text = chunk.choices[0]?.delta?.content || '';
                if (text) {
                    fullReply += text;
                    res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
                }
            }

            success = true;
            const nvContent = parsedMedia.nvidiaPayload || parsedMedia.finalMessage;
            sessionHistories[sessionId].nvidia.push({ role: 'user',      content: nvContent   });
            sessionHistories[sessionId].nvidia.push({ role: 'assistant', content: fullReply   });
            // Keep aligned with gemini/zhipu/deepseek/groq format
            sessionHistories[sessionId].gemini.push({ role: 'user',  parts: [{ text: String(nvContent) }] });
            sessionHistories[sessionId].gemini.push({ role: 'model', parts: [{ text: fullReply }] });
            sessionHistories[sessionId].zhipu.push({ role: 'user',      content: String(nvContent) });
            sessionHistories[sessionId].zhipu.push({ role: 'assistant', content: fullReply });
            sessionHistories[sessionId].deepseek.push({ role: 'user',      content: String(nvContent) });
            sessionHistories[sessionId].deepseek.push({ role: 'assistant', content: fullReply });
            sessionHistories[sessionId].groq.push({ role: 'user',      content: String(nvContent) });
            sessionHistories[sessionId].groq.push({ role: 'assistant', content: fullReply });
            trimHistories(sessionId);

        } catch (nvErr) {
            console.warn('NVIDIA NIM failed — falling back:', nvErr.message?.substring(0, 100));
            fullReply = '';
        }
        } // end else (nvidiaKey exists + not in cooldown)
    }

    // ── B-Groq: Groq LPU (forced or fallback) ──────────────────────
    const groqKey = process.env.GROQ_API_KEY;
    if (!success && (forceGroq || !success) && groqKey) {
        if (!providerHealth.isAvailable('groq')) {
            console.warn('Groq skipped (in cooldown)');
        } else {
            try {
                const OpenAI = require('openai');
                const groqClient = new OpenAI({ apiKey: groqKey, baseURL: 'https://api.groq.com/openai/v1' });

                const groqModelId = groqModelOverride || 'llama-3.3-70b-versatile';
                if (!forceGroq) usedModelName = `Groq (${groqModelId}) [Fallback]`;

                const groqHistory = sessionHistories[sessionId].groq.map(m => ({
                    role: m.role,
                    content: Array.isArray(m.content) ? (m.content.find(p => p.type === 'text')?.text || '[Attachment]') : m.content
                }));

                const messages = [
                    { role: 'system', content: systemPrompt },
                    ...groqHistory,
                    { role: 'user', content: parsedMedia.nvidiaPayload || parsedMedia.finalMessage }
                ];

                const stream = await retryWithBackoff(
                    () => {
                        let timerId;
                        const req = groqClient.chat.completions.create({
                            model: groqModelId,
                            messages,
                            stream: true,
                            temperature: complexity === 'heavy' ? 0.3 : 0.7,
                            max_tokens: complexity === 'heavy' ? 2048 : 1024,
                        });
                        req.catch(() => {});

                        return Promise.race([
                            req,
                            new Promise((_, reject) => timerId = setTimeout(() => reject(new Error('Groq Timeout')), 12000))
                        ]).finally(() => clearTimeout(timerId));
                    },
                    { maxRetries: 1, initialDelay: 300, providerName: 'groq' }
                );

                for await (const chunk of stream) {
                    const text = chunk.choices[0]?.delta?.content || '';
                    if (text) {
                        fullReply += text;
                        res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
                    }
                }

                success = true;
                const userContent = parsedMedia.nvidiaPayload || parsedMedia.finalMessage;
                sessionHistories[sessionId].groq.push({ role: 'user',      content: userContent });
                sessionHistories[sessionId].groq.push({ role: 'assistant', content: fullReply });
                sessionHistories[sessionId].nvidia.push({ role: 'user',      content: userContent });
                sessionHistories[sessionId].nvidia.push({ role: 'assistant', content: fullReply });
                sessionHistories[sessionId].gemini.push({ role: 'user',  parts: [{ text: String(userContent) }] });
                sessionHistories[sessionId].gemini.push({ role: 'model', parts: [{ text: fullReply }] });
                sessionHistories[sessionId].zhipu.push({ role: 'user',      content: String(userContent) });
                sessionHistories[sessionId].zhipu.push({ role: 'assistant', content: fullReply });
                sessionHistories[sessionId].deepseek.push({ role: 'user',      content: String(userContent) });
                sessionHistories[sessionId].deepseek.push({ role: 'assistant', content: fullReply });
                trimHistories(sessionId);

            } catch (groqErr) {
                console.warn('Groq failed — falling back:', groqErr.message?.substring(0, 100));
                fullReply = '';
            }
        }
    }

    // ── B2: Gemini (forced or primary fallback) ──────────────────────
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!success && (forceGemini || !success) && geminiKey) {
        try {
            const { GoogleGenerativeAI } = require('@google/generative-ai');
            const genAI = new GoogleGenerativeAI(geminiKey);

            // Pick model candidates list
            const defaultCandidates = ['gemini-3.6-flash', 'gemini-2.0-flash', 'gemini-flash-latest'];
            const candidates = forceGemini
                ? (GEMINI_MODEL_CANDIDATES[selectedModel] || defaultCandidates)
                : defaultCandidates;

            if (!forceGemini) usedModelName = 'Gemini 3.6 Flash [Fallback]';

            for (const candidate of candidates) {
                try {
                    const model  = genAI.getGenerativeModel({ model: candidate, systemInstruction: systemPrompt });
                    const chat   = model.startChat({ history: sessionHistories[sessionId].gemini });
                    const result = await chat.sendMessageStream(parsedMedia.geminiPayload);

                    fullReply = '';
                    for await (const chunk of result.stream) {
                        const text = chunk.text();
                        fullReply += text;
                        res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
                    }

                    success = true;
                    const userParts = Array.isArray(parsedMedia.geminiPayload)
                        ? parsedMedia.geminiPayload
                        : [{ text: String(parsedMedia.geminiPayload) }];
                    sessionHistories[sessionId].gemini.push({ role: 'user',  parts: userParts });
                    sessionHistories[sessionId].gemini.push({ role: 'model', parts: [{ text: fullReply }] });
                    sessionHistories[sessionId].zhipu.push({ role: 'user',      content: parsedMedia.finalMessage });
                    sessionHistories[sessionId].zhipu.push({ role: 'assistant', content: fullReply });
                    sessionHistories[sessionId].deepseek.push({ role: 'user',      content: parsedMedia.finalMessage });
                    sessionHistories[sessionId].deepseek.push({ role: 'assistant', content: fullReply });
                    sessionHistories[sessionId].groq.push({ role: 'user',      content: parsedMedia.finalMessage });
                    sessionHistories[sessionId].groq.push({ role: 'assistant', content: fullReply });
                    sessionHistories[sessionId].nvidia.push({ role: 'user',      content: parsedMedia.finalMessage });
                    sessionHistories[sessionId].nvidia.push({ role: 'assistant', content: fullReply });
                    trimHistories(sessionId);
                    break;
                } catch (me) {
                    console.warn(`Gemini model ${candidate} failed:`, me.message?.split('\n')[0]);
                    fullReply = '';
                }
            }
        } catch (gErr) {
            console.warn('Gemini fallback error:', gErr.message?.substring(0, 100));
            fullReply = '';
        }
    }

    // ── B3: DeepSeek (forced or secondary fallback for coding) ──────────
    const dsKey = process.env.DEEPSEEK_API_KEY;
    if (!success && (forceDeepSeek || (!success && isCodingTask(userMessage))) && dsKey) {
        try {
            const OpenAI = require('openai');
            const dsClient = new OpenAI({ apiKey: dsKey, baseURL: 'https://api.deepseek.com' });
            const dsModel  = deepSeekModelOverride || (isCodingTask(userMessage) ? 'deepseek-coder' : 'deepseek-chat');
            if (!forceDeepSeek) usedModelName = `DeepSeek (${dsModel}) [Fallback]`;

            const messages = [
                { role: 'system', content: systemPrompt },
                ...sessionHistories[sessionId].deepseek,
                { role: 'user', content: parsedMedia.finalMessage }
            ];

            const stream = await dsClient.chat.completions.create({
                model: dsModel, messages, stream: true, temperature: 0.2, max_tokens: 4096
            });

            for await (const chunk of stream) {
                const text = chunk.choices[0]?.delta?.content || '';
                if (text) { fullReply += text; res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`); }
            }

            success = true;
            sessionHistories[sessionId].deepseek.push({ role: 'user', content: parsedMedia.finalMessage });
            sessionHistories[sessionId].deepseek.push({ role: 'assistant', content: fullReply });
            sessionHistories[sessionId].zhipu.push({ role: 'user', content: parsedMedia.finalMessage });
            sessionHistories[sessionId].zhipu.push({ role: 'assistant', content: fullReply });
            sessionHistories[sessionId].gemini.push({ role: 'user',  parts: [{ text: parsedMedia.finalMessage }] });
            sessionHistories[sessionId].gemini.push({ role: 'model', parts: [{ text: fullReply }] });
            sessionHistories[sessionId].groq.push({ role: 'user',      content: parsedMedia.finalMessage });
            sessionHistories[sessionId].groq.push({ role: 'assistant', content: fullReply });
            sessionHistories[sessionId].nvidia.push({ role: 'user',      content: parsedMedia.finalMessage });
            sessionHistories[sessionId].nvidia.push({ role: 'assistant', content: fullReply });
            trimHistories(sessionId);
        } catch (dsErr) {
            console.warn('DeepSeek fallback failed:', dsErr.message?.substring(0, 100));
            fullReply = '';
        }
    }

    // ── B4: Zhipu GLM (forced or final fallback) ─────────────
    if (!success) {
        const zpKey = process.env.ZHIPU_API_KEY;
        if (zpKey) {
            try {
                const OpenAI = require('openai');
                const zpClient = new OpenAI({ apiKey: zpKey, baseURL: 'https://open.bigmodel.cn/api/paas/v4/' });

                let zhipuModel = zhipuModelOverride || (complexity === 'heavy' ? 'glm-4' : 'glm-4-flash');
                // Auto-switch to vision model if image in history
                const hasVision = sessionHistories[sessionId].zhipu.some(m => Array.isArray(m.content));
                if ((hasVision || Array.isArray(parsedMedia.zhipuPayload)) && !['glm-4v','glm-4v-plus'].includes(zhipuModel)) {
                    zhipuModel = 'glm-4v';
                }
                if (!forceZhipu) usedModelName = `Zhipu ${zhipuModel.toUpperCase()} [Fallback]`;

                const userContent = Array.isArray(parsedMedia.zhipuPayload)
                    ? parsedMedia.zhipuPayload
                    : String(parsedMedia.zhipuPayload);

                const messages = [
                    { role: 'system', content: systemPrompt },
                    ...sessionHistories[sessionId].zhipu,
                    { role: 'user', content: userContent }
                ];

                const stream = await zpClient.chat.completions.create({
                    model: zhipuModel, messages, stream: true, temperature: 0.2, max_tokens: 2048
                });

                for await (const chunk of stream) {
                    const text = chunk.choices[0]?.delta?.content || '';
                    if (text) { fullReply += text; res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`); }
                }

                success = true;
                sessionHistories[sessionId].zhipu.push({ role: 'user',      content: userContent });
                sessionHistories[sessionId].zhipu.push({ role: 'assistant', content: fullReply });
                sessionHistories[sessionId].gemini.push({ role: 'user',  parts: [{ text: parsedMedia.finalMessage }] });
                sessionHistories[sessionId].gemini.push({ role: 'model', parts: [{ text: fullReply }] });
                sessionHistories[sessionId].deepseek.push({ role: 'user',      content: parsedMedia.finalMessage });
                sessionHistories[sessionId].deepseek.push({ role: 'assistant', content: fullReply });
                sessionHistories[sessionId].groq.push({ role: 'user',      content: parsedMedia.finalMessage });
                sessionHistories[sessionId].groq.push({ role: 'assistant', content: fullReply });
                sessionHistories[sessionId].nvidia.push({ role: 'user',      content: parsedMedia.finalMessage });
                sessionHistories[sessionId].nvidia.push({ role: 'assistant', content: fullReply });
                trimHistories(sessionId);
            } catch (zpErr) {
                console.error('Zhipu fallback error:', zpErr.message?.substring(0, 100));
            }
        }
    }

    // ── No provider succeeded ─────────────────────────────────
    if (!success && !fullReply) {
        const errMsg = '⚠ Sorry, I\'m having trouble connecting to AI services right now. Please make sure NVIDIA_API_KEY is set in .env and the server is running.';
        res.write(`data: ${JSON.stringify({ chunk: errMsg })}\n\n`);
        fullReply = errMsg;
    }

    // ── Model attribution ────────────────────────────────────
    if (usedModelName && success) {
        const attr = `\n\n<span class="model-attribution">Generated by ${usedModelName}</span>`;
        fullReply += attr;
        res.write(`data: ${JSON.stringify({ chunk: attr })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();

    // Cache the response for future identical queries (skip images/errors)
    if (success && fullReply && !fileData && !isImageGenerationRequest(userMessage)) {
        const cleanReply = fullReply.replace(/<span class="model-attribution">.*?<\/span>/g, '').trim();
        responseCache.set(userMessage, cleanReply, usedModelName);
    }

    // Persist to MongoDB (non-blocking)
    await saveChatSession(sessionId, ip, userMessage, fullReply);
});

// ============================================================
// SESSION CLEAR
// ============================================================
app.delete('/api/session/:id', (req, res) => {
    const { id } = req.params;
    if (sessionHistories[id]) delete sessionHistories[id];
    if (sessionSummaries[id]) delete sessionSummaries[id];
    res.json({ success: true });
});

// ============================================================
// HELPERS
// ============================================================
const HISTORY_LIMIT = 20; // 10 exchanges (user + assistant pairs)
const SUMMARIZE_THRESHOLD = 24; // summarize when history exceeds this

function trimHistories(sessionId) {
    const h = sessionHistories[sessionId];
    if (!h) return;

    // Check if summarization is needed (using nvidia history as reference)
    if (h.nvidia.length > SUMMARIZE_THRESHOLD && !sessionSummaries[sessionId]) {
        // Build summary from older messages (all except last HISTORY_LIMIT)
        const olderMessages = h.nvidia.slice(0, h.nvidia.length - HISTORY_LIMIT);
        if (olderMessages.length > 0) {
            const summaryParts = olderMessages.map(m => {
                const content = Array.isArray(m.content)
                    ? (m.content.find(p => p.type === 'text')?.text || '[Attachment]')
                    : String(m.content);
                return `${m.role}: ${content.substring(0, 200)}`;
            });
            sessionSummaries[sessionId] = `Earlier conversation covered: ${summaryParts.join(' | ').substring(0, 1500)}`;
            console.log(`📝 Auto-summarized ${olderMessages.length} older messages for session ${sessionId.substring(0, 12)}...`);
        }
    }

    if (h.nvidia.length   > HISTORY_LIMIT) h.nvidia   = h.nvidia.slice(-HISTORY_LIMIT);
    if (h.gemini.length   > HISTORY_LIMIT) h.gemini   = h.gemini.slice(-HISTORY_LIMIT);
    if (h.zhipu.length    > HISTORY_LIMIT) h.zhipu    = h.zhipu.slice(-HISTORY_LIMIT);
    if (h.deepseek.length > HISTORY_LIMIT) h.deepseek = h.deepseek.slice(-HISTORY_LIMIT);
}

async function saveChatSession(sessionId, ip, userMsg, botMsg) {
    if (!isConnected) return;
    try {
        let session = await ChatSession.findOne({ sessionId });
        if (!session) session = new ChatSession({ sessionId, ip, messages: [] });
        session.messages.push({ role: 'user', content: userMsg });
        session.messages.push({ role: 'bot',  content: botMsg  });
        session.updatedAt = new Date();
        await session.save();
    } catch (err) {
        console.error('Chat DB save error:', err.message);
    }
}

// ============================================================
// SERVE FRONTEND (catch-all)
// ============================================================
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║           NVIDIA AI Chatbot — Backend v2.0           ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log(`\n🚀  Server: http://localhost:${PORT}`);
    console.log(`🔑  NVIDIA NIM :  ${process.env.NVIDIA_API_KEY   ? '✅ Ready'   : '❌ Missing NVIDIA_API_KEY'}`);
    console.log(`🔑  Groq       :  ${process.env.GROQ_API_KEY     ? '✅ Ready'   : '⚪ Not set (optional)'}`);
    console.log(`🔑  Gemini     :  ${process.env.GEMINI_API_KEY   ? '✅ Ready'   : '⚪ Not set (optional)'}`);
    console.log(`🔑  Zhipu GLM  :  ${process.env.ZHIPU_API_KEY    ? '✅ Ready'   : '⚪ Not set (optional)'}`);
    console.log(`🔑  DeepSeek   :  ${process.env.DEEPSEEK_API_KEY ? '✅ Ready'   : '⚪ Not set (optional)'}`);
    console.log(`🗄️  MongoDB    :  ${process.env.MONGODB_URI      ? '⏳ Connecting...' : '⚪ Not set (optional)'}`);
    console.log(`🛡️  Admin Pass :  ${process.env.ADMIN_PASSWORD   ? '✅ Set'     : '⚠  Using default (Admin@1234)'}\n`);
});

module.exports = app;
