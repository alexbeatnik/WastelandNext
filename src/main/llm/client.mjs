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
 * How far back a loop is looked for, and what counts as one.
 *
 * Reasoning is the one part of a reply nothing bounds. There is no `max_tokens`
 * on a turn — an answer is as long as it needs to be — so a model that starts
 * repeating itself while it thinks goes on until the window is full, and with
 * thinking hidden, which is the default, the only thing on screen for all of it
 * is "Thinking…". Reported from a real session: asked for a playlist, a model
 * settled on the right action in its first ten lines and then wrote "I will
 * output the response. I will use the action block." until it was stopped,
 * several hundred times, and never output anything.
 *
 * A loop is the same text coming round again with nothing new between: the
 * tail of the reasoning repeating with one fixed period. Five turns of it, and
 * at least four hundred characters, so a short refrain has to go round many
 * times and a long one still has to go round five — nobody reasons their way
 * through the identical paragraph five times running and then says something
 * new. Whitespace is collapsed first, because a loop that alternates one blank
 * line with two is still a loop.
 */
const RUNAWAY_REPEATS = 5;
const RUNAWAY_MIN_SPAN = 400;
const RUNAWAY_MAX_PERIOD = 800;
/** How often the tail is examined, in characters of new reasoning. */
const RUNAWAY_EVERY = 160;
/** What is kept of reasoning that looped: the part that was still thought. */
const RUNAWAY_KEEP = 1500;

/**
 * Is the end of this text one passage repeating?
 *
 * Exported for the tests, and deliberately only ever asked about reasoning. An
 * answer is allowed to repeat itself — "print hello fifty times" is a request —
 * and cutting one short would be the app deciding what a reply may contain.
 * Reasoning is not for the user, and reasoning that has stopped changing has
 * stopped being reasoning.
 */
export function isRunaway(text) {
  const tail = String(text ?? '')
    .slice(-RUNAWAY_MAX_PERIOD * RUNAWAY_REPEATS * 2)
    .replace(/\s+/g, ' ')
    .slice(-RUNAWAY_MAX_PERIOD * RUNAWAY_REPEATS);

  for (let period = 1; period <= RUNAWAY_MAX_PERIOD; period += 1) {
    const span = Math.max(period * RUNAWAY_REPEATS, RUNAWAY_MIN_SPAN);
    // Spans only grow with the period, so the first that does not fit is the
    // last worth trying.
    if (span > tail.length) break;
    let periodic = true;
    for (let at = tail.length - span; at < tail.length - period; at += 1) {
      if (tail[at] !== tail[at + period]) {
        periodic = false;
        break;
      }
    }
    if (periodic) return true;
  }
  return false;
}

/** Reasoning that looped, cut back to where it was still going somewhere. */
function clipRunaway(reasoning) {
  const kept = reasoning.slice(0, RUNAWAY_KEEP);
  const line = kept.lastIndexOf('\n');
  return `${(line > RUNAWAY_KEEP / 2 ? kept.slice(0, line) : kept).trimEnd()}\n…`;
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
 *
 * `runaway` is the third way a stream ends: the model's reasoning began
 * repeating itself and this stopped listening. It is not an abort — nobody
 * pressed anything — and not an error either; the caller is told, and decides
 * what to say about a reply that never arrived.
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

  // A signal of our own beside the caller's, so a runaway can hang up on the
  // endpoint — which is what makes llama.cpp stop generating — without
  // pretending the user pressed Stop.
  const hangUp = new AbortController();
  const onStop = () => hangUp.abort();
  if (signal?.aborted) hangUp.abort();
  else signal?.addEventListener('abort', onStop, { once: true });

  let res;
  try {
    res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      signal: hangUp.signal,
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens > 0 ? maxTokens : undefined,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
  } catch (err) {
    // A stop can land here as easily as mid-stream, and for llama.cpp it
    // usually does: no headers are sent until the prompt has been processed
    // and the first token exists, so the whole of "Thinking…" is spent inside
    // this call. It is the same normal outcome either way — nothing streamed
    // yet, so nothing to keep — and only a request that failed for a reason of
    // its own is an error.
    signal?.removeEventListener('abort', onStop);
    if (signal?.aborted) return { text: '', usage: null, aborted: true };
    throw err;
  }

  if (!res.ok || !res.body) {
    signal?.removeEventListener('abort', onStop);
    const detail = await res.text().catch(() => '');
    throw new Error(`inference request failed (${res.status}) ${detail.slice(0, 300)}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage = null;
  let aborted = false;

  let reasoning = '';
  let runaway = false;
  /** How much reasoning there was the last time its tail was examined. */
  let examined = 0;

  /**
   * The reasoning so far, wherever this endpoint puts it.
   *
   * Its own field where the server parses it out, which is what llama.cpp
   * does. An endpoint that does not leaves it inline, and then it is whatever
   * follows a `<think>` that has not been closed yet.
   */
  const thinking = () => {
    if (reasoning) return reasoning;
    const open = text.lastIndexOf('<think>');
    return open !== -1 && open > text.lastIndexOf('</think>') ? text.slice(open) : '';
  };

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

    // Looked at every so often rather than on every token: the test walks a
    // few thousand characters, and a token is three of them.
    const thought = thinking();
    if (thought.length - examined >= RUNAWAY_EVERY) {
      examined = thought.length;
      if (isRunaway(thought)) runaway = true;
    } else if (thought.length < examined) examined = thought.length;
  };

  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        consume(line);
        if (runaway) break;
      }
      if (runaway) {
        // Nothing after this is worth reading, and the half-event still in the
        // buffer least of all.
        buffer = '';
        hangUp.abort();
        break;
      }
    }
    // Nothing guarantees the stream ends on a newline. A server that closes the
    // socket right after its last event leaves that event sitting in `buffer` —
    // dropping it costs the final token, and the usage report rides on that
    // same last chunk.
    if (buffer.trim()) consume(buffer);
  } catch (err) {
    if (runaway) {
      /* our own hang-up arriving as the stream's last word */
    } else if (err?.name === 'AbortError' || signal?.aborted) aborted = true;
    else throw err;
  } finally {
    signal?.removeEventListener('abort', onStop);
  }

  // What looped is not kept. It is the same lines several hundred times over,
  // it would be stored with the conversation, and the part worth reading — how
  // the model got there — is the part before it started going round.
  if (runaway) {
    if (reasoning) reasoning = clipRunaway(reasoning);
    else {
      const open = text.lastIndexOf('<think>');
      text = `${text.slice(0, open)}<think>${clipRunaway(text.slice(open + '<think>'.length))}\n</think>\n`;
    }
  }

  // Separately-reported thinking is folded back in as a <think> block, which is
  // the form the rest of the app already understands and renders dimmed.
  const full = reasoning.trim() ? `<think>\n${reasoning.trim()}\n</think>\n${text}` : text;

  return { text: full, usage, aborted: aborted || Boolean(signal?.aborted), runaway };
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
