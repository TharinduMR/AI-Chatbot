// ══════════════════════════════════════════════════════════
//  NVIDIA AI Chatbot — app.js
//  Talks to /api/chat (Node.js + SSE) using NVIDIA NIM API
// ══════════════════════════════════════════════════════════

// ── State ──────────────────────────────────────────────────
let conversations = [];   // [{id, title, messages:[]}]
let activeId      = null;
let selectedModel = 'llama-3.1-8b';
let selectedPersona = 'general';
let currentController = null;


// Session ID (per browser tab)
if (!sessionStorage.getItem('nvChatSessionId')) {
  sessionStorage.setItem('nvChatSessionId', 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2));
}
const SESSION_ID = sessionStorage.getItem('nvChatSessionId');

// ── DOM ─────────────────────────────────────────────────────
const sidebar         = document.getElementById('sidebar');
const sidebarToggle   = document.getElementById('sidebar-toggle');
const sidebarClose    = document.getElementById('sidebar-close');
const appLayout       = document.getElementById('appLayout');
const chatTitle       = document.getElementById('chatTitle');
const chatHistory     = document.getElementById('chatHistory');
const newChatBtn      = document.getElementById('newChatBtn');
const clearBtn        = document.getElementById('clear-btn');

const messagesArea    = document.getElementById('messagesArea');
const welcomeScreen   = document.getElementById('welcomeScreen');
const messagesList    = document.getElementById('messagesList');
const chatInput       = document.getElementById('chatInput');
const sendBtn         = document.getElementById('sendBtn');
const modelSelectorBtn= document.getElementById('modelSelectorBtn');
const modelSelectorLabel = document.getElementById('modelSelectorLabel');
const modelDropdown   = document.getElementById('modelDropdown');
const currentModelLabel = document.getElementById('current-model-label');

const personaSelectorBtn = document.getElementById('personaSelectorBtn');
const personaSelectorLabel = document.getElementById('personaSelectorLabel');
const personaDropdown = document.getElementById('personaDropdown');

const stopGeneratingBar = document.getElementById('stopGeneratingBar');
const stopBtn = document.getElementById('stopBtn');

const chatbotFab      = document.getElementById('chatbotFab');
const inputArea       = document.getElementById('inputArea');
const inputWrapper    = document.getElementById('inputWrapper');
const fileInput       = document.getElementById('fileInput');
const filePreviewBar  = document.getElementById('filePreviewBar');
const fpIcon          = document.getElementById('fpIcon');
const fpName          = document.getElementById('fpName');
const fpRemoveBtn     = document.getElementById('fpRemoveBtn');

// Model label map (all providers)
const MODEL_LABELS = {
  // NVIDIA NIM — OpenAI models
  'gpt-oss-120b':       'GPT-OSS 120B',
  'gpt-oss-20b':        'GPT-OSS 20B',
  // NVIDIA NIM — Meta Llama
  'llama-3.1-70b':      'Llama 3.1 70B',
  'llama-3.1-8b':       'Llama 3.1 8B',
  'llama-3.3-70b':      'Llama 3.3 70B',
  // NVIDIA NIM — DeepSeek
  'deepseek-v4-pro':    'DeepSeek V4 Pro',
  'deepseek-v4-flash':  'DeepSeek V4 Flash',
  'deepseek-r1-llama':  'DeepSeek-R1 Llama 70B',
  // NVIDIA NIM — Zhipu GLM
  'glm-5.2':            'GLM-5.2',

  // Groq LPU
  'llama-3.3-70b-versatile': 'Llama 3.3 70B (Groq)',
  'mixtral-8x7b-32768':      'Mixtral 8x7B (Groq)',
  // NVIDIA NIM — Mistral
  'mistral-7b':         'Mistral 7B',
  'mixtral-8x7b':       'Mixtral 8×7B',
  // NVIDIA NIM — Other
  'gemma-3-27b':        'Gemma 3 27B',
  'gemma-4-31b-it':     'Gemma 4 31B',
  'phi-4':              'Microsoft Phi-4',
  'qwen-72b':           'Qwen 2.5 72B',
  // Google Gemini (direct API)
  'gemini-3.1-pro':     'Gemini 3.1 Pro',
  'gemini-3.5-flash':   'Gemini 3.5 Flash',
  'gemini-3.6-flash':   'Gemini 3.6 Flash',
  'gemini-2.5-pro':     'Gemini 2.5 Pro',
  'gemini-2.5-flash':   'Gemini 2.5 Flash',
  'gemini-2.0-flash':   'Gemini 2.0 Flash',
  'gemini-flash-latest':'Gemini Flash (Free)',
  // DeepSeek Direct API
  'deepseek-reasoner':  'DeepSeek-R1 (Reasoner)',
  'deepseek-chat':      'DeepSeek-V3 Chat',
  'deepseek-coder':     'DeepSeek Coder',
  // Zhipu GLM Direct API
  'glm-4-plus':         'GLM-4 Plus',
  'glm-4':              'GLM-4 Pro',
  'glm-4-air':          'GLM-4 Air',
  'glm-4-long':         'GLM-4 Long',
  'glm-4-flash':        'GLM-4 Flash',
};

// ── Helpers ─────────────────────────────────────────────────
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);

function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesArea.scrollTop = messagesArea.scrollHeight;
  });
}

function saveState() {
  try {
    localStorage.setItem('nv_convs', JSON.stringify(conversations));
    localStorage.setItem('nv_active', activeId || '');
    localStorage.setItem('nv_model', selectedModel);
  } catch (_) {}
}

function loadState() {
  try {
    const c = localStorage.getItem('nv_convs');
    if (c) conversations = JSON.parse(c);
    activeId      = localStorage.getItem('nv_active') || null;
    selectedModel = localStorage.getItem('nv_model') || 'gpt-oss-120b';
  } catch (_) {
    conversations = []; activeId = null;
  }
}

function getActive() {
  return conversations.find(c => c.id === activeId) || null;
}

// ── Markdown Renderer ────────────────────────────────────────
function renderMarkdown(text) {
  if (typeof marked !== 'undefined') {
    marked.setOptions({ breaks: true, gfm: true });
    return marked.parse(text);
  }
  // Fallback
  return text.replace(/\n/g, '<br>');
}

// ── Enhance Code Blocks ──────────────────────────────────────
function enhanceCodeBlocks(el) {
  el.querySelectorAll('pre').forEach(pre => {
    if (pre.parentElement.classList.contains('code-block-wrapper')) return;

    const code = pre.querySelector('code');
    const lang = (code?.className.replace('language-','').split(' ')[0]) || 'code';

    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';

    const header = document.createElement('div');
    header.className = 'code-block-header';

    const langLabel = document.createElement('span');
    langLabel.textContent = lang;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-code-btn';
    copyBtn.innerHTML = '<i class="fa-solid fa-copy"></i> Copy';
    copyBtn.addEventListener('click', () => {
      const txt = code ? code.innerText : pre.innerText;
      navigator.clipboard.writeText(txt).then(() => {
        copyBtn.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.innerHTML = '<i class="fa-solid fa-copy"></i> Copy';
          copyBtn.classList.remove('copied');
        }, 2000);
      });
    });

    header.appendChild(langLabel);
    header.appendChild(copyBtn);

    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(header);
    wrapper.appendChild(pre);

    // Highlight.js
    if (code && typeof hljs !== 'undefined') hljs.highlightElement(code);
  });
}

// ── Render KaTeX ─────────────────────────────────────────────
function renderMath(el) {
  if (typeof renderMathInElement === 'function') {
    try {
      renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true  },
          { left: '$',  right: '$',  display: false },
          { left: '\\(', right: '\\)', display: false },
          { left: '\\[', right: '\\]', display: true  }
        ],
        throwOnError: false
      });
    } catch (_) {}
  }
}

// ── Conversation Management ───────────────────────────────────
function createConversation() {
  const conv = { id: uid(), title: 'New Chat', messages: [] };
  conversations.unshift(conv);
  activeId = conv.id;
  saveState();
  return conv;
}

function setConvTitle(conv, text) {
  conv.title = text.length > 50 ? text.slice(0, 48) + '…' : text;
  chatTitle.textContent = conv.title;
  renderSidebarHistory();
  saveState();
}

// ── Sidebar History ───────────────────────────────────────────
function renderSidebarHistory() {
  chatHistory.innerHTML = '';
  conversations.forEach(conv => {
    const item = document.createElement('div');
    item.className = 'history-item' + (conv.id === activeId ? ' active' : '');
    item.innerHTML = `<i class="fa-regular fa-message"></i><span>${conv.title}</span>`;
    item.dataset.id = conv.id;
    item.addEventListener('click', () => switchConversation(conv.id));
    chatHistory.appendChild(item);
  });
}

function switchConversation(id) {
  activeId = id;
  saveState();
  renderSidebarHistory();
  rebuildMessages();
}

// ── Build Messages From Active Conv ───────────────────────────
function rebuildMessages() {
  const conv = getActive();
  messagesList.innerHTML = '';

  if (!conv || conv.messages.length === 0) {
    welcomeScreen.style.display = '';
    chatTitle.textContent = conv?.title || 'New Conversation';
    return;
  }

  welcomeScreen.style.display = 'none';
  chatTitle.textContent = conv.title;
  conv.messages.forEach(m => appendBubble(m.role, m.content, false));
  scrollToBottom();
}

// ── Append Message Bubble ─────────────────────────────────────
function appendBubble(role, content, animate = true) {
  const wrap = document.createElement('div');
  wrap.className = `message ${role}`;
  if (!animate) wrap.style.animation = 'none';

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = role === 'user' ? 'U' : 'AI';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (role === 'bot') {
    bubble.innerHTML = renderMarkdown(content);
    enhanceCodeBlocks(bubble);
    renderMath(bubble);
  } else {
    bubble.textContent = content;
  }

  wrap.appendChild(avatar);
  wrap.appendChild(bubble);
  messagesList.appendChild(wrap);
  scrollToBottom();
  return bubble;
}

// ── MediaHandler ──────────────────────────────────────────────
const MediaHandler = {
  currentFile: null, fileData: null, fileType: null,
  fileName: null, isTextFile: false,

  MIME_MAP: {
    jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif',
    webp:'image/webp', pdf:'application/pdf', txt:'text/plain',
    md:'text/markdown', csv:'text/csv', json:'application/json',
    js:'text/javascript', html:'text/html', css:'text/css',
    doc:'application/msword',
    docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  },

  getMime(name) {
    const ext = (name || '').split('.').pop().toLowerCase();
    return this.MIME_MAP[ext] || 'application/octet-stream';
  },

  processFile(file) {
    if (!file) return;
    this.currentFile = file;
    this.fileName = file.name || `file_${Date.now()}`;
    this.fileType = file.type || this.getMime(this.fileName);
    const TEXT_EXTS = ['.txt','.md','.csv','.json','.js','.html','.css'];
    this.isTextFile = this.fileType.startsWith('text/') ||
                      this.fileType === 'application/json' ||
                      TEXT_EXTS.some(e => this.fileName.toLowerCase().endsWith(e));

    // Update preview bar
    fpName.textContent = this.fileName;
    // Icon
    if (this.fileType.startsWith('image/'))      fpIcon.className = 'fa-solid fa-image';
    else if (this.fileType === 'application/pdf') fpIcon.className = 'fa-solid fa-file-pdf';
    else if (this.isTextFile)                     fpIcon.className = 'fa-solid fa-file-lines';
    else                                          fpIcon.className = 'fa-solid fa-file';

    // Remove any old thumbnail
    const oldThumb = filePreviewBar.querySelector('.fp-thumb');
    if (oldThumb) oldThumb.remove();

    // Read file
    const reader = new FileReader();
    reader.onload = (e) => {
      this.fileData = e.target.result;
      if (!this.isTextFile && typeof this.fileData === 'string' && this.fileData.includes('base64,')) {
        // Show thumbnail for images
        if (this.fileType.startsWith('image/')) {
          const thumb = document.createElement('img');
          thumb.className = 'fp-thumb';
          thumb.src = this.fileData; // still has data: prefix for display
          filePreviewBar.querySelector('.fp-info').prepend(thumb);
        }
        this.fileData = this.fileData.split('base64,')[1];
      }
    };
    if (this.isTextFile) reader.readAsText(file);
    else reader.readAsDataURL(file);

    filePreviewBar.classList.add('active');
    inputWrapper.classList.add('has-preview');
    const label = document.getElementById('attachBtn');
    if (label) label.classList.add('has-file');
  },

  clearFile() {
    this.currentFile = null; this.fileData = null;
    this.fileType = null; this.fileName = null; this.isTextFile = false;
    if (fileInput) fileInput.value = '';
    filePreviewBar.classList.remove('active');
    inputWrapper.classList.remove('has-preview');
    const oldThumb = filePreviewBar.querySelector('.fp-thumb');
    if (oldThumb) oldThumb.remove();
    const label = document.getElementById('attachBtn');
    if (label) label.classList.remove('has-file');
  },

  getPayload() {
    if (!this.currentFile || !this.fileData) return null;
    return { fileData: this.fileData, fileName: this.fileName,
             fileType: this.fileType, isTextFile: this.isTextFile };
  },

  init() {
    // File input change
    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        const f = e.target.files[0];
        if (f) this.processFile(f);
      });
    }

    // Remove button
    if (fpRemoveBtn) fpRemoveBtn.addEventListener('click', () => this.clearFile());

    // Clipboard paste (Ctrl+V / Win+Shift+S screenshot)
    const pasteHandler = (e) => {
      const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            let name = file.name;
            if (!name || name === 'image.png' || name === 'blob') {
              const ext = item.type?.split('/')[1] || 'png';
              name = `pasted_${Date.now()}.${ext}`;
            }
            this.processFile(new File([file], name, { type: file.type || 'image/png' }));
            e.preventDefault();
            break;
          }
        }
      }
    };
    document.addEventListener('paste', pasteHandler);

    // Drag & drop onto input wrapper
    if (inputWrapper) {
      inputWrapper.addEventListener('dragover', (e) => {
        e.preventDefault();
        inputWrapper.classList.add('drag-over');
      });
      inputWrapper.addEventListener('dragleave', () => {
        inputWrapper.classList.remove('drag-over');
      });
      inputWrapper.addEventListener('drop', (e) => {
        e.preventDefault();
        inputWrapper.classList.remove('drag-over');
        const file = e.dataTransfer?.files?.[0];
        if (file) this.processFile(file);
      });
    }
  }
};

// Lightbox helper
function openLightbox(src) {
  const lb = document.createElement('div');
  lb.className = 'img-lightbox';
  lb.innerHTML = `<img src="${src}" alt="Full size">`;
  lb.addEventListener('click', () => lb.remove());
  document.body.appendChild(lb);
}

// ── Typing Indicator ──────────────────────────────────────────
function showTyping() {
  const wrap = document.createElement('div');
  wrap.className = 'message bot';
  wrap.id = 'typingWrap';

  const av = document.createElement('div');
  av.className = 'msg-avatar'; av.textContent = 'AI';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  const typing = document.createElement('div');
  typing.className = 'typing-indicator';
  for (let i = 0; i < 3; i++) {
    const d = document.createElement('div');
    d.className = 'typing-dot';
    typing.appendChild(d);
  }

  bubble.appendChild(typing);
  wrap.appendChild(av);
  wrap.appendChild(bubble);
  messagesList.appendChild(wrap);
  scrollToBottom();
}

function hideTyping() {
  const el = document.getElementById('typingWrap');
  if (el) el.remove();
}

// ── Send Message ──────────────────────────────────────────────
async function sendMessage(text) {
  text = (text || '').trim();
  const mediaPayload = MediaHandler.getPayload();
  if (!text && !mediaPayload) return;

  // Ensure active conversation
  if (!activeId || !getActive()) {
    createConversation();
    renderSidebarHistory();
  }

  const conv = getActive();
  welcomeScreen.style.display = 'none';

  // Build user bubble with optional attachment
  const wrap = document.createElement('div');
  wrap.className = 'message user';
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = 'U';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  // Attachment preview inside bubble
  if (mediaPayload) {
    const attDiv = document.createElement('div');
    attDiv.className = 'msg-attachment';
    if (mediaPayload.fileType && mediaPayload.fileType.startsWith('image/')) {
      const img = document.createElement('img');
      img.className = 'msg-attachment-img';
      img.src = `data:${mediaPayload.fileType};base64,${mediaPayload.fileData}`;
      img.alt = mediaPayload.fileName || 'image';
      img.addEventListener('click', () => openLightbox(img.src));
      attDiv.appendChild(img);
    } else {
      let iconClass = 'fa-file';
      if (mediaPayload.fileType === 'application/pdf') iconClass = 'fa-file-pdf';
      else if (mediaPayload.isTextFile) iconClass = 'fa-file-lines';
      attDiv.innerHTML = `<span class="msg-attachment-file"><i class="fa-solid ${iconClass}"></i>${mediaPayload.fileName}</span>`;
    }
    bubble.appendChild(attDiv);
  }

  if (text) bubble.appendChild(document.createTextNode(text));
  wrap.appendChild(avatar);
  wrap.appendChild(bubble);
  messagesList.appendChild(wrap);
  scrollToBottom();

  conv.messages.push({ role: 'user', content: text || `[Attached: ${mediaPayload?.fileName}]` });
  if (conv.messages.filter(m => m.role === 'user').length === 1) {
    setConvTitle(conv, text || mediaPayload?.fileName || 'File');
  }
  saveState();

  chatInput.value = '';
  chatInput.style.height = 'auto';
  sendBtn.disabled = true;
  MediaHandler.clearFile();

  showTyping();

  try {
    currentController = new AbortController();
    stopGeneratingBar.style.display = 'flex';

    const body = {
      message: text,
      sessionId: SESSION_ID,
      selectedModel,
      persona: selectedPersona
    };
    // Attach media payload if present
    if (mediaPayload) Object.assign(body, mediaPayload);

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: currentController.signal
    });

    hideTyping();

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }

    // Create bot bubble
    const botBubble = appendBubble('bot', '', true);

    // Stream SSE
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let genImageUrl = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const parsed = JSON.parse(line.slice(6));

          if (parsed.chunk) {
            fullText += parsed.chunk;
            botBubble.innerText = fullText;
            scrollToBottom();
          }

          // Generated image from image-gen endpoint
          if (parsed.image) {
            genImageUrl = parsed.image;
            const imgWrap = document.createElement('div');
            imgWrap.className = 'generated-img-wrap';
            const img = document.createElement('img');
            img.className = 'generated-img';
            img.src = genImageUrl;
            img.alt = 'Generated image';
            img.addEventListener('click', () => openLightbox(img.src));
            imgWrap.appendChild(img);
            botBubble.appendChild(imgWrap);
            scrollToBottom();
          }

          if (parsed.done) {
            botBubble.innerHTML = renderMarkdown(fullText);
            enhanceCodeBlocks(botBubble);
            renderMath(botBubble);
            // Re-append generated image after markdown re-render
            if (genImageUrl) {
              const imgWrap = document.createElement('div');
              imgWrap.className = 'generated-img-wrap';
              const img = document.createElement('img');
              img.className = 'generated-img';
              img.src = genImageUrl;
              img.alt = 'Generated image';
              img.addEventListener('click', () => openLightbox(img.src));
              imgWrap.appendChild(img);
              botBubble.appendChild(imgWrap);
            }
            scrollToBottom();
            conv.messages.push({ role: 'bot', content: fullText });
            saveState();
          }

          if (parsed.error) {
            botBubble.textContent = '⚠ Error: ' + parsed.error;
            botBubble.style.color = '#ff6b6b';
          }
        } catch (_) {}
      }
    }

  } catch (err) {
    hideTyping();
    if (err.name === 'AbortError') {
        console.log('Request aborted by user');
        return; // Bubble is preserved as-is if aborted mid-generation
    }

    const errEl = document.createElement('div');
    errEl.className = 'message bot';
    errEl.innerHTML = `
      <div class="msg-avatar" style="background:linear-gradient(135deg,#ff4444,#ff8800);color:#fff">!</div>
      <div class="msg-bubble" style="border-color:rgba(255,107,107,0.3); background:rgba(255,107,107,0.07)">
        <strong>⚠ Connection Error</strong><br>
        <span style="color:var(--text-muted);font-size:0.75rem">${err.message}</span><br>
        <small style="color:var(--text-dim);font-size:0.7rem">Make sure the backend server is running (npm start)</small>
      </div>
    `;
    messagesList.appendChild(errEl);
    scrollToBottom();
  } finally {
    sendBtn.disabled = false;
    currentController = null;
    stopGeneratingBar.style.display = 'none';
  }
}

// ── Stop Generation ───────────────────────────────────────────
if (stopBtn) {
    stopBtn.addEventListener('click', () => {
        if (currentController) {
            currentController.abort();
            currentController = null;
            stopGeneratingBar.style.display = 'none';
            sendBtn.disabled = false;
        }
    });
}

// ── Model Selector ────────────────────────────────────────────
modelSelectorBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = modelDropdown.classList.toggle('open');
  modelSelectorBtn.classList.toggle('open', isOpen);
});

document.querySelectorAll('.model-opt').forEach(opt => {
  opt.addEventListener('click', () => {
    selectedModel = opt.dataset.model;
    const label = MODEL_LABELS[selectedModel] || selectedModel;
    modelSelectorLabel.textContent = label;
    if (currentModelLabel) currentModelLabel.textContent = label;
    modelDropdown.classList.remove('open');
    modelSelectorBtn.classList.remove('open');

    // Mark active
    document.querySelectorAll('.model-opt').forEach(o => o.classList.remove('active'));
    opt.classList.add('active');
    saveState();
  });
});

// ── Persona Selector ──────────────────────────────────────────
if (personaSelectorBtn && personaDropdown) {
  personaSelectorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = personaDropdown.classList.toggle('open');
    personaSelectorBtn.classList.toggle('open', isOpen);
    modelDropdown.classList.remove('open');
    modelSelectorBtn.classList.remove('open');
  });

  document.querySelectorAll('.persona-opt').forEach(opt => {
    opt.addEventListener('click', () => {
      selectedPersona = opt.dataset.persona;
      // Get title text ignoring the icon
      const titleEl = opt.querySelector('.mo-title');
      const label = titleEl ? titleEl.textContent.trim() : selectedPersona;
      personaSelectorLabel.textContent = label;

      personaDropdown.classList.remove('open');
      personaSelectorBtn.classList.remove('open');

      // Mark active
      document.querySelectorAll('.persona-opt').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
    });
  });

  personaDropdown.addEventListener('click', e => e.stopPropagation());
}

document.addEventListener('click', () => {
  modelDropdown.classList.remove('open');
  modelSelectorBtn.classList.remove('open');
  if (personaDropdown) personaDropdown.classList.remove('open');
  if (personaSelectorBtn) personaSelectorBtn.classList.remove('open');
});
modelDropdown.addEventListener('click', e => e.stopPropagation());

// ── Input ─────────────────────────────────────────────────────
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + 'px';
  sendBtn.disabled = !chatInput.value.trim();
});

chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) sendMessage(chatInput.value);
  }
});

sendBtn.addEventListener('click', () => {
  if (!sendBtn.disabled) sendMessage(chatInput.value);
});

// ── Suggestion Cards ──────────────────────────────────────────
document.querySelectorAll('.suggestion-card').forEach(card => {
  card.addEventListener('click', () => {
    const prompt = card.dataset.prompt;
    chatInput.value = prompt;
    chatInput.dispatchEvent(new Event('input'));
    sendMessage(prompt);
  });
});

// ── Sidebar Toggle ────────────────────────────────────────────
function setSidebarOpen(open) {
  if (open) {
    sidebar.classList.remove('collapsed');
    sidebar.classList.add('open');
    appLayout.classList.remove('sidebar-hidden');
  } else {
    sidebar.classList.add('collapsed');
    sidebar.classList.remove('open');
    appLayout.classList.add('sidebar-hidden');
  }
}

sidebarToggle.addEventListener('click', () => {
  const isCollapsed = sidebar.classList.contains('collapsed');
  setSidebarOpen(isCollapsed);
});

sidebarClose.addEventListener('click', () => setSidebarOpen(false));

// ── New Chat ──────────────────────────────────────────────────
newChatBtn.addEventListener('click', () => {
  createConversation();
  renderSidebarHistory();
  rebuildMessages();
  chatInput.focus();
  setSidebarOpen(false);

  // Clear server-side session memory
  fetch(`/api/session/${SESSION_ID}`, { method: 'DELETE' }).catch(() => {});
});

// ── Clear Chat ────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  const conv = getActive();
  if (!conv) return;
  conv.messages = [];
  conv.title = 'New Chat';
  saveState();
  rebuildMessages();
  chatTitle.textContent = 'New Conversation';

  fetch(`/api/session/${SESSION_ID}`, { method: 'DELETE' }).catch(() => {});
});



// ── FAB (mobile) ──────────────────────────────────────────────
if (chatbotFab) {
  chatbotFab.addEventListener('click', () => {
    setSidebarOpen(false);
    inputArea.scrollIntoView({ behavior: 'smooth' });
    chatInput.focus();
  });
}

// ── Init ──────────────────────────────────────────────────────
(function init() {
  loadState();

  if (conversations.length === 0) {
    createConversation();
  }

  // Set selected model label
  const label = MODEL_LABELS[selectedModel] || selectedModel;
  if (modelSelectorLabel) modelSelectorLabel.textContent = label;
  if (currentModelLabel) currentModelLabel.textContent = label;

  // Mark active model in dropdown
  document.querySelectorAll('.model-opt').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.model === selectedModel);
  });

  renderSidebarHistory();
  rebuildMessages();
  MediaHandler.init();
  chatInput.focus();

  // Check server health
  fetch('/api/health')
    .then(r => r.json())
    .then(data => {
      console.log('🟢 Backend:', data.service, '| Models:', data.models?.length);
    })
    .catch(() => {
      console.warn('⚠ Backend not reachable. Start the server: npm start');
    });
})();
