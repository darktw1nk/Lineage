export default {
  name: 'fixture-dir',
  operators: [{
    name: 'dir-op',
    parents: 1,
    async apply({ parent }) {
      return { prompt: parent.prompt + ' [dir]', changeLog: [{ label: 'DIR', text: '-' }], cost: { promptTokens: 0, completionTokens: 0, usd: 0, calls: 0 } };
    },
  }],
};
