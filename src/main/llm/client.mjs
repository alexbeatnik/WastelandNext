/**
 * OpenAI-compatible streaming client.
 *
 * Deliberately dependency-free and endpoint-agnostic: the same function talks
 * to the llama-server we spawned, to Ollama, to LM Studio, or to a cloud
 * endpoint, because all four speak `/v1/chat/completions`. Anything specific to
 * a local model belongs in `server.mjs`, not here.
 */

/** Parse one SSE `data:` payload. `[DONE]` and junk both yield null. */
function parseEvent(raw) {
  const line = raw.trim();
  if (!line.startsWith('data:')) return null;
  const body = line.slice(5).trim();
  if (!body || body === '[DONE]') return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * Stream one completion.
 *
 * `onToken` is called with each delta as it lands. The resolved value carries
 * the assembled text plus whatever usage the server reported — llama.cpp only
 * sends usage on the final chunk, and some endpoints never do, so `usage` may
 * be null and callers must cope.
 *
 * An aborted request is a normal outcome, not an error: the user pressed stop,
 * and whatever streamed so far is worth keeping.
 */
export async function streamChat({
  baseUrl,
  messages,
  temperature = 0.7,
  maxTokens = -1,
  apiKey = '',
  model = 'local',
  signal,
  onToken,
  streamReasoning = true,
}) {
  if (!baseUrl) throw new Error('no inference endpoint — load a model or set one in SETTINGS');

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens > 0 ? maxTokens : undefined,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`inference request failed (${res.status}) ${detail.slice(0, 300)}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage = null;
  let aborted = false;

  let reasoning = '';

  /** Handle one complete SSE line. */
  const consume = (line) => {
    const event = parseEvent(line);
    if (!event) return;
    if (event.usage) usage = event.usage;

    const delta = event.choices?.[0]?.delta ?? {};
    if (delta.content) {
      text += delta.content;
      onToken?.(delta.content);
    }
    // Some endpoints split thinking into its own field, which an OpenAI client
    // reading only `content` would drop — the reply then arrives empty even
    // though tokens were generated. Kept, and folded back in below.
    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      // Still collected when not streamed: it is the fallback for a model that
      // thinks and never gets round to an answer, where showing nothing would
      // be worse. It simply does not scroll past the user first.
      if (streamReasoning) onToken?.(delta.reasoning_content);
    }
  };

  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) consume(line);
    }
    // Nothing guarantees the stream ends on a newline. A server that closes the
    // socket right after its last event leaves that event sitting in `buffer` —
    // dropping it costs the final token, and the usage report rides on that
    // same last chunk.
    if (buffer.trim()) consume(buffer);
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) aborted = true;
    else throw err;
  }

  // Separately-reported thinking is folded back in as a <think> block, which is
  // the form the rest of the app already understands and renders dimmed.
  const full = reasoning.trim() ? `<think>\n${reasoning.trim()}\n</think>\n${text}` : text;

  return { text: full, usage, aborted: aborted || Boolean(signal?.aborted) };
}

/**
 * Ask the endpoint how big its context is.
 *
 * llama-server answers on `/props`; anything else gets a null and the caller
 * falls back to the configured n_ctx.
 */
export async function contextSize(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/props`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const props = await res.json();
    return props.default_generation_settings?.n_ctx ?? props.n_ctx ?? null;
  } catch {
    return null;
  }
}

/**
 * Rough token count for the context meter and the compaction decision.
 *
 * One ratio cannot serve both scripts. Latin prose runs about 3.6 characters to
 * the token; Cyrillic runs nowhere near that — few tokenizers hold whole
 * Ukrainian words, so most of the text falls back to byte pairs and lands nearer
 * 1.6. A single 3.6 undercounted a Ukrainian conversation by roughly half: the
 * meter read 4594 of 4608 while the prompt was already over the window, and
 * llama.cpp was quietly discarding the oldest part of it to make room. The model
 * then answered as if the start of the conversation had never happened.
 *
 * Still an estimate — deliberately the pessimistic one, because the cost of
 * guessing low is a truncated prompt and the cost of guessing high is one
 * compaction sooner than strictly needed.
 */
export function estimateTokens(text) {
  const source = String(text ?? '');
  let ascii = 0;
  for (let i = 0; i < source.length; i += 1) if (source.charCodeAt(i) < 128) ascii += 1;
  return Math.ceil(ascii / 3.6 + (source.length - ascii) / 1.6);
}
