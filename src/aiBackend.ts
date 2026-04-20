// src/aiBackend.ts
// AI backend abstraction: Copilot (streaming) → OpenAI (streaming) → Anthropic (streaming)
//
// Changes vs original:
//   P1 — max_tokens raised: OpenAI → 16 384, Anthropic → 8 192 (eliminates truncation retries)
//   P2 — All three backends now support streaming via an optional onChunk callback.
//        The Copilot backend already had a stream; OpenAI and Anthropic now use SSE.
//        Callers that pass onChunk receive partial text as it arrives; callers that
//        don't pass it get the same blocking behaviour as before.
//   P4 — Each backend call is wrapped with a timeout to prevent infinite hangs.

import * as vscode from 'vscode';

// Timeout per backend (ms) — tuned for typical response patterns
const TIMEOUT_MS: Record<string, number> = {
  copilot:   300_000,  // 5 min — Copilot can be slow with large diffs
  openai:    180_000,  // 3 min
  anthropic: 180_000,  // 3 min
};
const TIMEOUT_DEFAULT = 120_000;

/**
 * Wraps a promise with a timeout. Rejects if the promise doesn't settle
 * within `ms` milliseconds.
 *
 * The timeout timer is always cancelled as soon as the promise settles so the
 * Node.js event loop is not kept alive after the AI call completes.
 * Previously the timer ran for the full timeout duration (up to 5 min for
 * Copilot) even on a successful fast response, preventing the extension host
 * from going idle and causing visible CPU/resource usage in Task Manager.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timerId: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timerId = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s — the AI model took too long. Try with a smaller diff or switch backends.`)),
      ms
    );
  });
  // promise.finally() cancels the timer whether the promise resolves or rejects,
  // ensuring zero lingering timers after every AI call.
  return Promise.race([
    promise.finally(() => clearTimeout(timerId)),
    timeout,
  ]);
}

export interface AIResponse {
  text: string;
  model: string;
  backend: string;
}

export interface AIKeys {
  openai?: string;
  anthropic?: string;
}

/** Called with each incremental text chunk as the model streams its response. */
export type StreamChunkCallback = (chunk: string) => void;

// ─────────────────────────────────────────────────────────────────────────────
// GitHub Copilot  (VS Code Language Model API — already streamed)
// ─────────────────────────────────────────────────────────────────────────────
async function callCopilot(
  prompt: string,
  systemPrompt: string,
  onChunk?: StreamChunkCallback
): Promise<AIResponse> {
  try {
    const selectedModelId = vscode.workspace.getConfiguration('revvy').get<string>('selectedModelId', '');
    const allModels = await (vscode.lm as any).selectChatModels({ vendor: 'copilot' });

    if (!allModels || allModels.length === 0) {
      throw new Error('No Copilot models available. Ensure GitHub Copilot is enabled in VS Code.');
    }

    const model = selectedModelId
      ? (allModels.find((m: any) => m.id === selectedModelId) ?? allModels[0])
      : allModels[0];

    const messages = [
      (vscode.LanguageModelChatMessage as any).User(systemPrompt + '\n\n' + prompt),
    ];

    const cts = new vscode.CancellationTokenSource();
    const response = await model.sendRequest(messages, {}, cts.token);

    // Safety net: if no chunk arrives within 120s, abort (the model is likely stuck)
    let chunkTimer: NodeJS.Timeout | undefined;
    const resetTimer = () => {
      if (chunkTimer) { clearTimeout(chunkTimer); }
      chunkTimer = setTimeout(() => {
        cts.cancel();
        console.warn('[Revvy] Copilot stream stalled — cancelled after 120s of silence');
      }, 120_000);
    };
    resetTimer();

    let fullText = '';
    for await (const chunk of response.text) {
      fullText += chunk;
      resetTimer();
      onChunk?.(chunk);
    }

    if (chunkTimer) { clearTimeout(chunkTimer); }

    if (!fullText.trim()) {
      throw new Error('Copilot returned an empty response. The prompt may be too large or the model is unavailable.');
    }

    return { text: fullText, model: model.name || 'copilot', backend: 'GitHub Copilot' };
  } catch (error: any) {
    if (error.message?.includes('cancelled') || error.name === 'Canceled') {
      throw new Error('Copilot stream timed out after 120s of inactivity. The model may be overloaded — try again or switch backends.');
    }
    throw new Error(`Copilot failed: ${error.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI  (SSE streaming — P1: max_tokens raised to 16 384)
// ─────────────────────────────────────────────────────────────────────────────
async function callOpenAI(
  prompt: string,
  systemPrompt: string,
  apiKey: string,
  onChunk?: StreamChunkCallback,
  baseUrl = 'https://api.openai.com/v1',
  model = 'gpt-4o'
): Promise<AIResponse> {
  const useStreaming = typeof onChunk === 'function';

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: prompt },
    ],
    max_tokens: 32768,   // P1: raised to 32K — large diffs with many rules need more output room
    temperature: 0.1,
    stream: useStreaming,
  };

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${err}`);
  }

  if (useStreaming && response.body) {
    // P2: consume SSE stream and forward chunks
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let resolvedModel = model;

    while (true) {
      const { done, value } = await reader.read();
      if (done) { break; }
      const raw = decoder.decode(value, { stream: true });
      // Each SSE frame starts with "data: " and ends with "\n\n"
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) { continue; }
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') { continue; }
        try {
          const parsed = JSON.parse(payload);
          if (parsed.model) { resolvedModel = parsed.model; }
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            onChunk(delta);
          }
        } catch { /* malformed SSE frame — skip */ }
      }
    }

    return { text: fullText, model: resolvedModel, backend: 'OpenAI' };
  }

  // Non-streaming fallback (no onChunk passed)
  const data = (await response.json()) as any;
  const text = data.choices?.[0]?.message?.content || '';
  return { text, model: data.model || model, backend: 'OpenAI' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic  (SSE streaming — P1: max_tokens raised to 8 192)
// ─────────────────────────────────────────────────────────────────────────────
async function callAnthropic(
  prompt: string,
  systemPrompt: string,
  apiKey: string,
  onChunk?: StreamChunkCallback,
  model = 'claude-sonnet-4-20250514'
): Promise<AIResponse> {
  const useStreaming = typeof onChunk === 'function';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16384,   // P1: raised to 16K — large diffs need more output room
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
      stream: useStreaming,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic error ${response.status}: ${err}`);
  }

  if (useStreaming && response.body) {
    // P2: consume Anthropic SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let resolvedModel = model;

    while (true) {
      const { done, value } = await reader.read();
      if (done) { break; }
      const raw = decoder.decode(value, { stream: true });
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) { continue; }
        const payload = trimmed.slice(6);
        try {
          const parsed = JSON.parse(payload);
          if (parsed.type === 'message_start' && parsed.message?.model) {
            resolvedModel = parsed.message.model;
          }
          // content_block_delta carries the actual text increments
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            const delta = parsed.delta.text as string;
            fullText += delta;
            onChunk(delta);
          }
        } catch { /* malformed SSE frame — skip */ }
      }
    }

    return { text: fullText, model: resolvedModel, backend: 'Anthropic' };
  }

  // Non-streaming fallback
  const data = (await response.json()) as any;
  const text = data.content?.find((b: any) => b.type === 'text')?.text || '';
  return { text, model: data.model || model, backend: 'Anthropic' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main dispatcher
// ─────────────────────────────────────────────────────────────────────────────
export async function callAI(
  prompt: string,
  systemPrompt: string,
  keys: AIKeys,
  onChunk?: StreamChunkCallback
): Promise<AIResponse> {
  const config = vscode.workspace.getConfiguration('revvy');
  const selectedBackend = config.get<string>('aiBackend', 'copilot');
  const openaiKey    = keys.openai    ?? '';
  const anthropicKey = keys.anthropic ?? '';

  const errors: string[] = [];

  // Try user's selected backend first
  if (selectedBackend === 'copilot') {
    const timeout = TIMEOUT_MS.copilot ?? TIMEOUT_DEFAULT;
    try { return await withTimeout(callCopilot(prompt, systemPrompt, onChunk), timeout, 'Copilot'); }
    catch (e: any) { errors.push(`Copilot: ${e.message}`); }
  } else if (selectedBackend === 'openai' && openaiKey) {
    const timeout = TIMEOUT_MS.openai ?? TIMEOUT_DEFAULT;
    try { return await withTimeout(callOpenAI(prompt, systemPrompt, openaiKey, onChunk), timeout, 'OpenAI'); }
    catch (e: any) { errors.push(`OpenAI: ${e.message}`); }
  } else if (selectedBackend === 'anthropic' && anthropicKey) {
    const timeout = TIMEOUT_MS.anthropic ?? TIMEOUT_DEFAULT;
    try { return await withTimeout(callAnthropic(prompt, systemPrompt, anthropicKey, onChunk), timeout, 'Anthropic'); }
    catch (e: any) { errors.push(`Anthropic: ${e.message}`); }
  }

  // Fallbacks — FIX 5: forward onChunk so the UI stays live even on fallback paths.
  // Previously fallbacks were called without onChunk, causing a silent progress bar
  // with no token counter updates whenever the primary backend failed.
  if (selectedBackend !== 'copilot') {
    const timeout = TIMEOUT_MS.copilot ?? TIMEOUT_DEFAULT;
    try { return await withTimeout(callCopilot(prompt, systemPrompt, onChunk), timeout, 'Copilot (fallback)'); }
    catch (e: any) { errors.push(`Copilot (fallback): ${e.message}`); }
  }
  if (selectedBackend !== 'openai' && openaiKey) {
    const timeout = TIMEOUT_MS.openai ?? TIMEOUT_DEFAULT;
    try { return await withTimeout(callOpenAI(prompt, systemPrompt, openaiKey, onChunk), timeout, 'OpenAI (fallback)'); }
    catch (e: any) { errors.push(`OpenAI (fallback): ${e.message}`); }
  }
  if (selectedBackend !== 'anthropic' && anthropicKey) {
    const timeout = TIMEOUT_MS.anthropic ?? TIMEOUT_DEFAULT;
    try { return await withTimeout(callAnthropic(prompt, systemPrompt, anthropicKey, onChunk), timeout, 'Anthropic (fallback)'); }
    catch (e: any) { errors.push(`Anthropic (fallback): ${e.message}`); }
  }

  throw new Error(
    `All AI backends failed:\n${errors.join('\n')}\n\nSelected backend: ${selectedBackend}\nPlease check your settings or API keys.`
  );
}
