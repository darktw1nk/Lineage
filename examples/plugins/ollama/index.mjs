/**
 * Example PromptEngine provider plugin: local Ollama server via its
 * OpenAI-compatible endpoint (http://localhost:11434). No API key needed.
 * Requires: `ollama serve` running and the model pulled (e.g. `ollama pull llama3.2`).
 */
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

const adapter = {
  name: 'ollama',
  estimateTokens(input) {
    return { prompt: Math.ceil(input.length / 4) };
  },
  async call({ model, prompt, temperature, maxTokens }) {
    const started = Date.now();
    const res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxTokens,
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return {
      output: data.choices?.[0]?.message?.content ?? '',
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - started,
      usd: 0, // local inference is free
    };
  },
};

export default {
  name: 'ollama',
  version: '1.0.0',
  providers: [{
    adapter,
    models: [
      { provider: 'ollama', model: 'llama3.2', promptUSDper1k: 0, completionUSDper1k: 0 },
      { provider: 'ollama', model: 'qwen2.5', promptUSDper1k: 0, completionUSDper1k: 0 },
    ],
  }],
};
