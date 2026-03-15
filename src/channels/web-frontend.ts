export const WEB_CHAT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NanoClaw Chat</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0a0a0a;
    color: #e0e0e0;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  #login {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    flex-direction: column;
    gap: 16px;
  }
  #login h1 { font-size: 24px; color: #fff; }
  #login input {
    padding: 12px 16px;
    width: 300px;
    border: 1px solid #333;
    border-radius: 8px;
    background: #1a1a1a;
    color: #fff;
    font-size: 16px;
    outline: none;
  }
  #login input:focus { border-color: #4a9eff; }
  #login button {
    padding: 12px 32px;
    background: #4a9eff;
    color: #fff;
    border: none;
    border-radius: 8px;
    font-size: 16px;
    cursor: pointer;
  }
  #login button:hover { background: #3a8eef; }
  #login .error { color: #ff4a4a; font-size: 14px; min-height: 20px; }
  #chat { display: none; flex-direction: column; height: 100vh; }
  #header {
    padding: 16px 20px;
    background: #111;
    border-bottom: 1px solid #222;
    font-size: 16px;
    font-weight: 600;
  }
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .msg {
    max-width: 75%;
    padding: 10px 14px;
    border-radius: 12px;
    line-height: 1.5;
    font-size: 15px;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .msg.user {
    align-self: flex-end;
    background: #1a3a5c;
    color: #e0e0e0;
    border-bottom-right-radius: 4px;
  }
  .msg.bot {
    align-self: flex-start;
    background: #1e1e1e;
    color: #e0e0e0;
    border-bottom-left-radius: 4px;
  }
  .msg.typing {
    align-self: flex-start;
    background: #1e1e1e;
    color: #888;
    font-style: italic;
  }
  #input-area {
    padding: 16px 20px;
    background: #111;
    border-top: 1px solid #222;
    display: flex;
    gap: 12px;
  }
  #input-area textarea {
    flex: 1;
    padding: 12px 16px;
    border: 1px solid #333;
    border-radius: 8px;
    background: #1a1a1a;
    color: #fff;
    font-size: 15px;
    font-family: inherit;
    outline: none;
    resize: none;
    max-height: 120px;
  }
  #input-area textarea:focus { border-color: #4a9eff; }
  #input-area button {
    padding: 12px 20px;
    background: #4a9eff;
    color: #fff;
    border: none;
    border-radius: 8px;
    font-size: 15px;
    cursor: pointer;
    align-self: flex-end;
  }
  #input-area button:hover { background: #3a8eef; }
  #input-area button:disabled { background: #333; cursor: not-allowed; }
</style>
</head>
<body>

<div id="login">
  <h1>NanoClaw</h1>
  <input type="password" id="pw" placeholder="Enter password" autofocus>
  <button onclick="doLogin()">Connect</button>
  <div class="error" id="login-error"></div>
</div>

<div id="chat">
  <div id="header">NanoClaw Chat</div>
  <div id="messages"></div>
  <div id="input-area">
    <textarea id="msg" rows="1" placeholder="Type a message..." onkeydown="handleKey(event)"></textarea>
    <button id="send-btn" onclick="doSend()">Send</button>
  </div>
</div>

<script>
let password = '';
let sessionId = localStorage.getItem('nc_session') || '';
let polling = false;

async function doLogin() {
  password = document.getElementById('pw').value;
  if (!password) return;

  // Test auth with a poll request
  try {
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      localStorage.setItem('nc_session', sessionId);
    }
    const r = await fetch('/api/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, sessionId }),
      signal: AbortSignal.timeout(5000),
    });
    if (r.status === 401) {
      document.getElementById('login-error').textContent = 'Wrong password';
      return;
    }
  } catch(e) {
    // Timeout is fine - means auth passed
  }

  document.getElementById('login').style.display = 'none';
  document.getElementById('chat').style.display = 'flex';
  document.getElementById('msg').focus();
  startPolling();
}

async function doSend() {
  const input = document.getElementById('msg');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = 'auto';
  addMessage(text, 'user');

  const btn = document.getElementById('send-btn');
  btn.disabled = true;

  try {
    const r = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, message: text, sessionId }),
    });
    const data = await r.json();
    if (!r.ok) {
      addMessage('Error: ' + (data.error || 'Unknown'), 'bot');
    } else if (data.sessionId && data.sessionId !== sessionId) {
      sessionId = data.sessionId;
      localStorage.setItem('nc_session', sessionId);
    }
  } catch(e) {
    addMessage('Error: Failed to send message', 'bot');
  }
  btn.disabled = false;
}

function addMessage(text, type) {
  const container = document.getElementById('messages');
  // Remove typing indicator if present
  const typing = container.querySelector('.typing');
  if (typing) typing.remove();

  const div = document.createElement('div');
  div.className = 'msg ' + type;
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function showTyping() {
  const container = document.getElementById('messages');
  if (container.querySelector('.typing')) return;
  const div = document.createElement('div');
  div.className = 'msg typing';
  div.textContent = 'Thinking...';
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

async function startPolling() {
  if (polling) return;
  polling = true;

  while (polling) {
    try {
      const r = await fetch('/api/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, sessionId }),
      });
      if (!r.ok) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      const data = await r.json();
      if (data.messages) {
        for (const msg of data.messages) {
          if (typeof msg === 'object' && msg.typing) {
            showTyping();
          } else {
            addMessage(msg, 'bot');
          }
        }
      }
    } catch(e) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    doSend();
  }
  // Auto-resize textarea
  const el = e.target;
  setTimeout(() => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, 0);
}

// Enter key on password field
document.getElementById('pw').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});
</script>
</body>
</html>`;
