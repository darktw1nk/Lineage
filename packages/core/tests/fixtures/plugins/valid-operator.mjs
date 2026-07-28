export default {
  name: 'fixture-op',
  version: '0.1.0',
  operators: [{
    name: 'reverse-prompt',
    parents: 1,
    async apply({ parent }) {
      return {
        prompt: [...parent.prompt].reverse().join(''),
        changeLog: [{ label: 'REVERSE', text: 'reversed' }],
        cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 },
      };
    },
  }],
};
