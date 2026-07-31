/**
 * CLI Progress Display
 *
 * Prints progress to stderr (so stdout can be piped for JSON output).
 */

import type { CandidateNode } from '@lineage/core';

export interface DisplayState {
  currentGeneration: number;
  nodesFinished: number;
  nodesTotal: number;
  bestFitness: number;
  bestPrompt: string;
  totalCost: number;
  totalCalls: number;
  cacheHits: number;
}

const state: DisplayState = {
  currentGeneration: 0,
  nodesFinished: 0,
  nodesTotal: 0,
  bestFitness: 0,
  bestPrompt: '',
  totalCost: 0,
  totalCalls: 0,
  cacheHits: 0,
};

function log(msg: string): void {
  process.stderr.write(msg + '\n');
}

export function onNodeCreated(_node: CandidateNode): void {
  state.nodesTotal++;
}

export function onNodeUpdated(node: CandidateNode): void {
  if (node.status === 'finished' || node.status === 'failed') {
    state.nodesFinished++;
  }

  if (node.metrics?.fitness !== undefined && node.metrics.fitness > state.bestFitness) {
    state.bestFitness = node.metrics.fitness;
    state.bestPrompt = node.prompt;
  }

  if (node.status === 'finished') {
    log(`  Node ${node.id.slice(0, 8)} finished | fitness: ${node.metrics?.fitness?.toFixed(2) ?? '?'} | quality: ${node.metrics?.quality?.toFixed(1) ?? '?'}`);
  }
}

export function onGenerationCreated(generation: number, nodes: CandidateNode[]): void {
  // Print summary for the generation that just finished
  log(`\nGeneration ${state.currentGeneration}: ${state.nodesFinished}/${state.nodesTotal} nodes | Best fitness: ${state.bestFitness.toFixed(2)} | Cost: $${state.totalCost.toFixed(4)}`);

  // Reset counters for the new generation. Nodes carried over already
  // terminal (cached elites) never emit a later node_updated — count them now.
  state.currentGeneration = generation;
  state.nodesFinished = nodes.filter(n => n.status === 'finished' || n.status === 'failed').length;
  state.nodesTotal = nodes.length;

  log(`\n--- Generation ${generation} (${nodes.length} nodes) ---`);
}

export function onTotals(totals: { usd: number; calls: number }, cacheHits: number): void {
  state.totalCost = totals.usd;
  state.totalCalls = totals.calls;
  state.cacheHits = cacheHits;
}

export function onPopulationReady(): void {
  log(`\n--- Generation 0 (${state.nodesTotal} nodes) ---`);
}

export function onFinished(): void {
  // Print final generation summary
  log(`\nGeneration ${state.currentGeneration}: ${state.nodesFinished}/${state.nodesTotal} nodes | Best fitness: ${state.bestFitness.toFixed(2)} | Cost: $${state.totalCost.toFixed(4)}`);

  log(`\n${'='.repeat(60)}`);
  log(`EVOLUTION COMPLETE`);
  log(`${'='.repeat(60)}`);
  log(`Total cost: $${state.totalCost.toFixed(4)} | API calls: ${state.totalCalls} | Cache hits: ${state.cacheHits}`);
  log(`Best fitness: ${state.bestFitness.toFixed(2)}`);
  log(`${'='.repeat(60)}`);
  log(`BEST PROMPT:`);
  log(`${'='.repeat(60)}`);
  log(state.bestPrompt);
  log(`${'='.repeat(60)}`);
}

export function onError(message: string): void {
  log(`\nERROR: ${message}`);
}

export function resetState(): void {
  state.currentGeneration = 0;
  state.nodesFinished = 0;
  state.nodesTotal = 0;
  state.bestFitness = 0;
  state.bestPrompt = '';
  state.totalCost = 0;
  state.totalCalls = 0;
  state.cacheHits = 0;
}

export function getState(): DisplayState {
  return { ...state };
}
