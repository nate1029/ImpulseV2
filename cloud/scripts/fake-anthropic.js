// A stand-in for api.anthropic.com for local development without spending
// real credits: node scripts/fake-anthropic.js [port] (default 8799), then set
// ANTHROPIC_BASE_URL=http://127.0.0.1:8799 and any ANTHROPIC_API_KEY.
// It answers every message with a short streamed reply and plausible usage.
// Asked to build something with the editor tools available, it first writes
// a Blink sketch with set_editor_code, so the app's build flow (code, then the
// simulator check) runs end to end.
import http from 'node:http';

const port = Number(process.argv[2]) || 8799;

const BLINK = `// Blink the onboard LED every 500 ms and log each toggle.
const unsigned long INTERVAL_MS = 500;

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  static bool on = false;
  on = !on;
  digitalWrite(LED_BUILTIN, on ? HIGH : LOW);
  Serial.println(on ? "LED on" : "LED off");
  delay(INTERVAL_MS);
}
`;

const textOf = (content) => (typeof content === 'string' ? content : (content || []).map((b) => b.text || '').join(' '));

function plan(body) {
  const last = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
  const afterTool = Array.isArray(last?.content) && last.content.some((b) => b.type === 'tool_result');
  const asked = textOf(last?.content).replace(/\[IDE:[^\]]*\]\s*/g, '').trim().slice(0, 120);
  const canEdit = (body.tools || []).some((t) => t.name === 'set_editor_code');
  if (canEdit && !afterTool && /\b(build|make|blink|write|create)\b/i.test(asked)) {
    return { tool: { name: 'set_editor_code', input: { code: BLINK } } };
  }
  if (afterTool) {
    return { text: 'Done. The sketch blinks the onboard LED every **500 ms** and prints each toggle:\n\n- `LED_BUILTIN` is pin 13 on an Uno\n- Serial runs at 9600 baud\n\nThis is the local test model, not Claude.' };
  }
  return { text: `This is the local test model, not Claude. You asked: "${asked}". Point ANTHROPIC_BASE_URL at the real API to get real answers.` };
}

http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
    res.writeHead(404).end();
    return;
  }
  const body = JSON.parse(raw || '{}');
  const turn = plan(body);
  const text = turn.text || '';
  const toolJson = turn.tool ? JSON.stringify(turn.tool.input) : '';
  const usage = { input_tokens: 1800 + Math.floor(raw.length / 4) % 4000, cache_read_input_tokens: 6000, cache_creation_input_tokens: 0, output_tokens: Math.ceil((text.length + toolJson.length) / 4) };
  const message = { id: `msg_fake_${Date.now()}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } };
  const toolBlock = turn.tool ? { type: 'tool_use', id: `toolu_fake_${Date.now()}`, name: turn.tool.name, input: turn.tool.input } : null;
  const stopReason = toolBlock ? 'tool_use' : 'end_turn';
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_fake' });
    res.end(JSON.stringify({ ...message, content: [toolBlock || { type: 'text', text }], stop_reason: stopReason, usage }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_fake' });
  const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  send({ type: 'message_start', message });
  if (toolBlock) {
    send({ type: 'content_block_start', index: 0, content_block: { ...toolBlock, input: {} } });
    for (let i = 0; i < toolJson.length; i += 80) {
      send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: toolJson.slice(i, i + 80) } });
      await pause(15);
    }
  } else {
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    for (const word of text.split(/(?<= )/)) {
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } });
      await pause(25);
    }
  }
  send({ type: 'content_block_stop', index: 0 });
  send({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  send({ type: 'message_stop' });
  res.end();
}).listen(port, '127.0.0.1', () => console.log(`Fake Anthropic API on http://127.0.0.1:${port}`));
