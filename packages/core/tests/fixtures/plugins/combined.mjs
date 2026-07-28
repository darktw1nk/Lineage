export default {
  name: 'fixture-combined',
  operators: [{
    name: 'noop-op',
    parents: 1,
    async apply({ parent }) {
      return { prompt: parent.prompt, changeLog: [{ label: 'NOOP', text: '-' }], cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 } };
    },
  }],
  providers: [{
    adapter: {
      name: 'null-provider',
      estimateTokens: () => ({ prompt: 0 }),
      call: async () => ({ output: '', promptTokens: 0, completionTokens: 0, latencyMs: 0, usd: 0 }),
    },
  }],
};
