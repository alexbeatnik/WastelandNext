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

  /** Handle one complete SSE line. */
  const consume = (line) => {
    const event = parseEvent(line);
    if (!event) return;
    if (event.usage) usage = event.usage;
    const delta = event.choices?.[0]?.delta?.content;
    if (delta) {
      text += delta;
      onToken?.(delta);
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

  return { text, usage, aborted: aborted || Boolean(signal?.aborted) };
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
 * Rough token count for the context meter.
 *
 * Used only until the server reports real usage. ~3.6 chars/token is a decent
 * middle ground across Latin and Cyrillic text; the meter is an indicator, not
 * an accounting record.
 */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 3.6);
}
