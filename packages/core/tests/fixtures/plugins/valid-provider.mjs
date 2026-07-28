export default {
  name: 'fixture-provider',
  providers: [{
    adapter: {
      name: 'echo',
      estimateTokens: () => ({ prompt: 1 }),
      call: async ({ prompt }) => ({ output: prompt, promptTokens: 1, completionTokens: 1, latencyMs: 0, usd: 0 }),
    },
    models: [{ provider: 'echo', model: 'echo-1', promptUSDper1k: 0, completionUSDper1k: 0 }],
  }],
};
