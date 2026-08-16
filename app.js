// ============================================================
//  NVIDIA AI Chatbot — app.js
//  Uses NVIDIA NIM API: meta/llama-3.1-70b-instruct
// ============================================================

const API_KEY   = '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';
const API_URL   = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL     = 'meta/llama-3.1-70b-instruct';

// ── State ──────────────────────────────────────────────────
let conversations = [];   // [{id, title, messages: [{role, content}]}]
let activeId      = null;

// ── DOM refs ───────────────────────────────────────────────
const chatInput        = document.getElementById('chatInput');
const sendBtn          = document.getElementById('sendBtn');
const messagesList     = document.getElementById('messagesList');
const messagesContainer= document.getElementById('messagesContainer');
const welcomeScreen    = document.getElementById('welcomeScreen');
const chatTitle        = document.getElementById('chatTitle');
const chatHistoryEl    = document.getElementById('chatHistory');
const newChatBtn       = document.getElementById('newChatBtn');
const clearBtn         = document.getElementById('clearBtn');
const mobileMenuBtn    = document.getElementById('mobileMenuBtn');
const sidebar          = document.getElementById('sidebar');

// ── Helpers ────────────────────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Very lightweight markdown renderer:
 * - ```code blocks```
 * - `inline code`
 * - **bold**, *italic*
 * - bullet / numbered lists
 * - line breaks
 */
function renderMarkdown(text) {
  let html = escapeHtml(text);

  // Fenced code blocks
  html = html.replace(/```([^`]*?)```/gs, (_, code) => {
    return `<pre><code>${code.trim()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Numbered list
  html = html.replace(/(^\d+\. .+(\n|$))+/gm, match => {
    const items = match.trim().split('\n').map(l => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });

  // Unordered list
  html = html.replace(/(^[-*] .+(\n|$))+/gm, match => {
    const items = match.trim().split('\n').map(l => `<li>${l.replace(/^[-*] /, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });

  // Paragraphs (double newline → paragraph break, single newline → <br>)
  html = html
    .split(/\n{2,}/)
    .map(para => para.trim() ? `<p>${para.replace(/\n/g, '<br>')}</p>` : '')
    .join('');

  return html;
}

// ── Conversation management ─────────────────────────────────
function createConversation() {
  const conv = { id: uid(), title: 'New Chat', messages: [] };
  conversations.unshift(conv);
  activeId = conv.id;
  saveToStorage();
  return conv;
}

function getActive() {
  return conversations.find(c => c.id === activeId) || null;
}

function setTitle(conv, text) {
  conv.title = text.slice(0, 48) + (text.length > 48 ? '…' : '');
  chatTitle.textContent = conv.title;
  renderHistory();
  saveToStorage();
}

function saveToStorage() {
  try {
    localStorage.setItem('nvidia_chatbot_convs', JSON.stringify(conversations));
    localStorage.setItem('nvidia_chatbot_active', activeId || '');
  } catch (_) {}
}

function loadFromStorage() {
  try {
    const saved = localStorage.getItem('nvidia_chatbot_convs');
    const savedActive = localStorage.getItem('nvidia_chatbot_active');
    if (saved) {
      conversations = JSON.parse(saved);
      activeId = savedActive || (conversations[0]?.id ?? null);
    }
  } catch (_) {
    conversations = [];
    activeId = null;
  }
}

// ── Render sidebar history ──────────────────────────────────
function renderHistory() {
  // Keep the label, rebuild items
  const label = chatHistoryEl.querySelector('.history-label');
  chatHistoryEl.innerHTML = '';
  if (label) chatHistoryEl.appendChild(label);
  else {
    const lbl = document.createElement('p');
    lbl.className = 'history-label';
    lbl.textContent = 'Recent Chats';
    chatHistoryEl.appendChild(lbl);
  }

  conversations.forEach(conv => {
    const item = document.createElement('div');
    item.className = 'history-item' + (conv.id === activeId ? ' active' : '');
    item.textContent = conv.title || 'New Chat';
    item.dataset.id = conv.id;
    item.addEventListener('click', () => switchConversation(conv.id));
    chatHistoryEl.appendChild(item);
  });
}

function switchConversation(id) {
  activeId = id;
  saveToStorage();
  renderHistory();
  rebuildMessages();
  sidebar.classList.remove('open');
}

// ── Render messages from active conversation ─────────────────
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

  conv.messages.forEach(msg => appendBubble(msg.role, msg.content, false));
  scrollBottom();
}

// ── Append a message bubble ──────────────────────────────────
function appendBubble(role, content, animate = true) {
  const wrap = document.createElement('div');
  wrap.className = `message ${role}`;
  if (!animate) wrap.style.animation = 'none';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? 'U' : 'AI';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (role === 'assistant') {
    bubble.innerHTML = renderMarkdown(content);
  } else {
    bubble.textContent = content;
  }

  wrap.appendChild(avatar);
  wrap.appendChild(bubble);
  messagesList.appendChild(wrap);
  scrollBottom();
  return bubble;
}

// ── Typing indicator ─────────────────────────────────────────
function showTyping() {
  const wrap = document.createElement('div');
  wrap.className = 'message assistant';
  wrap.id = 'typingIndicator';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = 'AI';

  const typing = document.createElement('div');
  typing.className = 'typing-bubble';
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement('div');
    dot.className = 'typing-dot';
    typing.appendChild(dot);
  }

  wrap.appendChild(avatar);
  wrap.appendChild(typing);
  messagesList.appendChild(wrap);
  scrollBottom();
}

function hideTyping() {
  const el = document.getElementById('typingIndicator');
  if (el) el.remove();
}

function scrollBottom() {
  requestAnimationFrame(() => {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  });
}

// ── Send message ─────────────────────────────────────────────
async function sendMessage(text) {
  text = text.trim();
  if (!text) return;

  // Ensure active conversation
  if (!activeId || !getActive()) {
    createConversation();
    renderHistory();
  }

  const conv = getActive();

  // Hide welcome, show first user message
  welcomeScreen.style.display = 'none';

  // Add user message
  conv.messages.push({ role: 'user', content: text });
  appendBubble('user', text);

  // Set title from first message
  if (conv.messages.length === 1) {
    setTitle(conv, text);
  }

  saveToStorage();

  // Disable input
  chatInput.value = '';
  chatInput.style.height = 'auto';
  sendBtn.disabled = true;

  // Show typing
  showTyping();

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: conv.messages,
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 1024,
      }),
    });

    hideTyping();

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const errMsg = errData?.detail || errData?.message || `HTTP ${response.status}`;
      throw new Error(errMsg);
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content ?? '(No response)';

    conv.messages.push({ role: 'assistant', content: reply });
    appendBubble('assistant', reply);
    saveToStorage();

  } catch (err) {
    hideTyping();
    const errWrap = document.createElement('div');
    errWrap.className = 'error-msg';
    errWrap.textContent = `⚠ Error: ${err.message}`;
    messagesList.appendChild(errWrap);
    scrollBottom();
  }
}

// ── Auto-resize textarea ──────────────────────────────────────
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
  sendBtn.disabled = chatInput.value.trim().length === 0;
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

// ── Suggestion cards ──────────────────────────────────────────
document.querySelectorAll('.suggestion-card').forEach(card => {
  card.addEventListener('click', () => {
    const prompt = card.dataset.prompt;
    chatInput.value = prompt;
    chatInput.dispatchEvent(new Event('input'));
    sendMessage(prompt);
  });
});

// ── New chat ───────────────────────────────────────────────────
newChatBtn.addEventListener('click', () => {
  createConversation();
  renderHistory();
  rebuildMessages();
  sidebar.classList.remove('open');
  chatInput.focus();
});

// ── Clear chat ─────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  const conv = getActive();
  if (!conv) return;
  conv.messages = [];
  conv.title = 'New Chat';
  saveToStorage();
  rebuildMessages();
});

// ── Mobile sidebar ─────────────────────────────────────────────
mobileMenuBtn.addEventListener('click', () => {
  sidebar.classList.toggle('open');
});

// Close sidebar when clicking outside (mobile)
document.addEventListener('click', e => {
  if (
    sidebar.classList.contains('open') &&
    !sidebar.contains(e.target) &&
    e.target !== mobileMenuBtn
  ) {
    sidebar.classList.remove('open');
  }
});

// ── Init ───────────────────────────────────────────────────────
(function init() {
  loadFromStorage();

  if (conversations.length === 0) {
    createConversation();
  }

  renderHistory();
  rebuildMessages();
  chatInput.focus();
})();
