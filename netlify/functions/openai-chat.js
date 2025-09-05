// Netlify Node Function (CommonJS): /.netlify/functions/openai-chat
// Reads secrets from env vars: OPENAI_API_KEY (required)
// Optional: ASSISTANT_ID (to use your Playground Assistant), OPENAI_MODEL (for Responses API)

const HEADERS_JSON = {
  'Content-Type': 'application/json',
  // Loosen CORS in case you embed from Framer on a different origin:
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async function (event) {
  // Preflight for CORS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: HEADERS_JSON, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS_JSON, body: JSON.stringify({ error: 'POST only' }) };
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, headers: HEADERS_JSON, body: JSON.stringify({ error: 'OPENAI_API_KEY not set' }) };
    }

    const assistantId = process.env.ASSISTANT_ID || '';
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    const parsed = JSON.parse(event.body || '{}');
    const messages = parsed.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return { statusCode: 400, headers: HEADERS_JSON, body: JSON.stringify({ error: 'messages[] required' }) };
    }

    // ----- PATH A: Assistants API (if ASSISTANT_ID is set) -----
    if (assistantId) {
      const base = 'https://api.openai.com/v1';
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        // IMPORTANT for v2:
        'OpenAI-Beta': 'assistants=v2'
      };

      // 1) Create thread
      let r = await fetch(`${base}/threads`, { method: 'POST', headers, body: JSON.stringify({}) });
      if (!r.ok) return failure(r);

      const thread = await r.json();

      // 2) Add user message
      const userText = String(messages.map(m => m.content).join('\n\n')).slice(0, 6000);
      r = await fetch(`${base}/threads/${thread.id}/messages`, {
        method: 'POST', headers, body: JSON.stringify({ role: 'user', content: userText })
      });
      if (!r.ok) return failure(r);

      // 3) Create run
      r = await fetch(`${base}/threads/${thread.id}/runs`, {
        method: 'POST', headers, body: JSON.stringify({ assistant_id: assistantId })
      });
      if (!r.ok) return failure(r);
      let run = await r.json();

      // 4) Poll until complete
      const started = Date.now();
      while (run.status === 'queued' || run.status === 'in_progress') {
        if (Date.now() - started > 60000) break; // 60s timeout
        await new Promise(res => setTimeout(res, 900));
        r = await fetch(`${base}/threads/${thread.id}/runs/${run.id}`, { headers });
        if (!r.ok) return failure(r);
        run = await r.json();
      }

      // 5) Read last assistant message
      r = await fetch(`${base}/threads/${thread.id}/messages?limit=10`, { headers });
      if (!r.ok) return failure(r);
      const list = await r.json();

      const last = (list.data || []).find(m => m.role === 'assistant');
      let reply = '';
      if (last && Array.isArray(last.content)) {
        reply = last.content.map(part => (part.type === 'text' && part.text?.value) ? part.text.value : '').join('\n').trim();
      }
      if (!reply) reply = '…';

      return ok({ reply });
    }

    // ----- PATH B: Responses API (default; simpler) -----
    {
      const r = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          input: messages.map(m => ({
            role: m.role || 'user',
            content: [{ type: 'text', text: String(m.content || '') }]
          }))
        })
      });
      if (!r.ok) return failure(r);

      const data = await r.json();
      let reply = data.output_text;
      if (!reply && Array.isArray(data.output)) {
        reply = data.output.map(item => {
          if (item?.content && Array.isArray(item.content)) {
            return item.content.map(c =>
              (c.type === 'output_text' && c.text) ? c.text : (c.type === 'text' ? c.text : '')
            ).join('');
          }
          return '';
        }).join('').trim();
      }
      if (!reply) reply = '…';
      return ok({ reply });
    }

  } catch (err) {
    return { statusCode: 500, headers: HEADERS_JSON, body: JSON.stringify({ error: String(err && err.message || err) }) };
  }

  function ok(obj) {
    return { statusCode: 200, headers: HEADERS_JSON, body: JSON.stringify(obj) };
  }
  async function failure(res) {
    const text = await res.text().catch(() => '');
    return { statusCode: res.status || 500, headers: HEADERS_JSON, body: text || JSON.stringify({ error: 'Upstream error' }) };
  }
};
