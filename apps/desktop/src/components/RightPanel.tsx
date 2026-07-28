import { X, Copy, ChevronDown, ChevronRight, Calculator } from 'lucide-react';
import { Button } from './ui/button';
import { useState, useRef, useEffect } from 'react';
import type { UUID, EvaluationRun, CandidateNode, EvaluationConfig } from '../types';
import { useEvaluation } from '../hooks/useEvaluation';
import { useQuery } from '@tanstack/react-query';

interface RightPanelProps {
  evaluationId: UUID | null;
  nodeId: UUID;
  onClose: () => void;
}

export function RightPanel({ evaluationId, nodeId, onClose }: RightPanelProps) {
  const [expandedTests, setExpandedTests] = useState<Set<UUID>>(new Set());
  const [expandedReasonings, setExpandedReasonings] = useState<Set<UUID>>(new Set());
  const [showFitnessCalc, setShowFitnessCalc] = useState(false);
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem('rightPanelWidth');
    return saved ? parseInt(saved, 10) : 384; // 384px = w-96
  });
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Centralized store - single source of truth!
  const { evaluation } = useEvaluation(evaluationId);

  const node = findNode(evaluation, nodeId);

  // Fetch config to get test names
  const { data: config } = useQuery<EvaluationConfig | null>({
    queryKey: ['evaluation-config', evaluationId],
    queryFn: async () => {
      if (!evaluationId) return null;
      return window.electronAPI.eval.getConfig(evaluationId);
    },
    enabled: !!evaluationId,
  });

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!panelRef.current) return;
      const newWidth = window.innerWidth - e.clientX;
      // Min width: 300px, Max width: 800px
      const clampedWidth = Math.max(300, Math.min(800, newWidth));
      setWidth(clampedWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      localStorage.setItem('rightPanelWidth', width.toString());
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    // Prevent text selection and show resize cursor globally while dragging
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, width]);

  if (!node) {
    return null;
  }

  const toggleTest = (testId: UUID) => {
    const newExpanded = new Set(expandedTests);
    if (newExpanded.has(testId)) {
      newExpanded.delete(testId);
    } else {
      newExpanded.add(testId);
    }
    setExpandedTests(newExpanded);
  };

  const toggleReasoning = (testId: UUID) => {
    const newExpanded = new Set(expandedReasonings);
    if (newExpanded.has(testId)) {
      newExpanded.delete(testId);
    } else {
      newExpanded.add(testId);
    }
    setExpandedReasonings(newExpanded);
  };

  // Helper to get test name by testId
  const getTestName = (testId: UUID): string => {
    const testCase = config?.testSet?.find(t => t.id === testId);
    if (testCase?.name && testCase.name.trim() !== '') {
      return testCase.name;
    }
    return `Test ${testId.substring(0, 8)}`;
  };

  const copyPrompt = () => {
    navigator.clipboard.writeText(node.prompt);
  };

  const passedTests = node.tests?.filter(t => t.passed).length ?? 0;
  const totalTests = node.tests?.length ?? 0;

  return (
    <div 
      ref={panelRef}
      className="relative flex h-full flex-col border-l bg-card"
      style={{ width: `${width}px` }}
    >
      {/* Resize Handle */}
      <div
        className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/50 active:bg-primary transition-colors"
        onMouseDown={() => setIsResizing(true)}
      />
      
      <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b p-4">
        <h2 className="text-lg font-semibold">Node Details</h2>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Chips */}
        <div className="flex flex-wrap gap-2">
          <Chip label="ID" value={node.id.substring(0, 8)} />
          <Chip label="Status" value={node.status} />
          <Chip label="Model" value={node.params.model.model} />
          <Chip label="Temp" value={node.params.temperature.toString()} />
          {node.timings?.finishedAt && node.timings?.startedAt && (
            <Chip
              label="Time"
              value={`${((node.timings.finishedAt - node.timings.startedAt) / 1000).toFixed(1)}s`}
            />
          )}
          {node.metrics?.fitness !== undefined && (
            <Chip label="Score" value={node.metrics.fitness.toFixed(2)} />
          )}
        </div>

        {/* Prompt & Params */}
        <Section title="Prompt & Parameters">
          <div className="space-y-3">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium">Prompt</span>
                <Button variant="ghost" size="sm" onClick={copyPrompt}>
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
              <div className="max-h-60 overflow-y-auto rounded-md border bg-muted p-3 text-sm whitespace-pre-wrap font-mono">
                {node.prompt}
              </div>
            </div>
            
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <span className="text-muted-foreground">Model:</span>{' '}
                <span className="font-medium">{node.params.model.model}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Temperature:</span>{' '}
                <span className="font-medium">{node.params.temperature}</span>
              </div>
              {node.params.seed && (
                <div>
                  <span className="text-muted-foreground">Seed:</span>{' '}
                  <span className="font-medium">{node.params.seed}</span>
                </div>
              )}
            </div>
          </div>
        </Section>

        {/* Change Log */}
        {node.changeLog.length > 0 && (
          <Section title="Change Log">
            <div className="space-y-2">
              {node.changeLog.map((change, idx) => (
                <div key={idx} className="rounded border bg-muted p-2 text-sm">
                  <span className="font-semibold text-primary">[{change.label}]</span>{' '}
                  <span className="whitespace-pre-wrap">{change.text}</span>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Tests */}
        {node.tests && node.tests.length > 0 && (
          <Section title={`Tests (${passedTests}/${totalTests})`}>
            <div className="space-y-2">
              {node.tests.map((test) => (
                <div key={test.testId} className="rounded border">
                  <button
                    onClick={() => toggleTest(test.testId)}
                    className="flex w-full items-center justify-between p-3 text-left hover:bg-accent"
                  >
                    <div className="flex items-center space-x-2">
                      {expandedTests.has(test.testId) ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                      <span className="text-sm font-medium">
                        {getTestName(test.testId)}
                      </span>
                      <span className={`text-xs ${test.passed ? 'text-green-600' : 'text-red-600'}`}>
                        {test.passed ? '✓ Passed' : '✗ Failed'}
                      </span>
                    </div>
                    <span className="text-sm font-semibold">{test.score}/10</span>
                  </button>

                  {expandedTests.has(test.testId) && (
                    <div className="border-t p-3 space-y-2 text-sm">
                      <div>
                        <span className="font-medium">Output:</span>
                        <div className="mt-1 max-h-32 overflow-y-auto rounded bg-muted p-2 whitespace-pre-wrap font-mono text-xs">
                          {test.outputText || 'No output'}
                        </div>
                      </div>
                      
                      {/* LLM Grading Reasoning (collapsible) */}
                      {test.llmGradeReasoning && (
                        <div>
                          <button
                            onClick={() => toggleReasoning(test.testId)}
                            className="flex items-center space-x-1 text-xs font-medium text-primary hover:underline"
                          >
                            {expandedReasonings.has(test.testId) ? (
                              <ChevronDown className="h-3 w-3" />
                            ) : (
                              <ChevronRight className="h-3 w-3" />
                            )}
                            <span>LLM Judge Reasoning</span>
                          </button>
                          {expandedReasonings.has(test.testId) && (
                            <div className="mt-1 max-h-32 overflow-y-auto rounded bg-muted/50 p-2 whitespace-pre-wrap font-mono text-xs border-l-2 border-primary">
                              {test.llmGradeReasoning}
                            </div>
                          )}
                        </div>
                      )}
                      
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>Prompt tokens: {test.promptTokens}</span>
                        <span>Completion tokens: {test.completionTokens}</span>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Metrics */}
        {node.metrics && (
          <Section title="Metrics">
            <div className="grid grid-cols-2 gap-2 text-sm">
              {node.metrics.quality !== undefined && (
                <Metric label="Quality" value={node.metrics.quality.toFixed(2)} />
              )}
              {node.metrics.safety !== undefined && (
                <Metric label="Safety" value={node.metrics.safety.toFixed(2)} />
              )}
              {node.metrics.costUSD !== undefined && (
                <Metric label="Cost" value={formatCost(node.metrics.costUSD)} />
              )}
              {node.metrics.latencyMs !== undefined && (
                <Metric label="Latency" value={`${node.metrics.latencyMs}ms`} />
              )}
              {node.metrics.stability !== undefined && (
                <Metric label="Stability" value={node.metrics.stability.toFixed(2)} />
              )}
              {node.metrics.fitness !== undefined && (
                <Metric label="Fitness" value={node.metrics.fitness.toFixed(2)} />
              )}
              {node.metrics.playoffRank !== undefined && (
                <Metric label="Playoff" value={`#${node.metrics.playoffRank}`} />
              )}
            </div>
          </Section>
        )}

        {/* Fitness Calculation Breakdown */}
        {node.metrics && config && (
          <div className="border rounded-lg">
            <button
              onClick={() => setShowFitnessCalc(!showFitnessCalc)}
              className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <Calculator className="h-4 w-4" />
                <span className="font-semibold text-sm">Fitness Calculation</span>
              </div>
              {showFitnessCalc ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
            {showFitnessCalc && (
              <div className="p-3 pt-0 space-y-3 text-xs">
                <FitnessBreakdown node={node} config={config} evaluation={evaluation} />
              </div>
            )}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {children}
    </div>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-full bg-secondary px-3 py-1 text-xs">
      <span className="font-semibold">{label}:</span> {value}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-muted-foreground">{label}:</span>{' '}
      <span className="font-medium">{value}</span>
    </div>
  );
}

function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost >= 0.01) return `$${cost.toFixed(4)}`; // Regular format for normal costs
  if (cost >= 0.000001) return `$${cost.toFixed(6)}`; // 6 decimals for very small costs
  // For extremely tiny costs, use scientific notation
  return `$${cost.toExponential(2)}`;
}

function FitnessBreakdown({ node, config, evaluation }: { node: CandidateNode; config: EvaluationConfig; evaluation: EvaluationRun | null }) {
  if (!node.metrics) return null;

  // Calculate normalized weights
  const weights = config.fitness.weights;
  const sum = (weights.quality || 0) + (weights.safety || 0) + (weights.cost || 0) + (weights.latency || 0) + (weights.stability || 0);
  const normalizedWeights = sum > 0 ? {
    quality: weights.quality / sum,
    safety: weights.safety ? weights.safety / sum : 0,
    cost: weights.cost ? weights.cost / sum : 0,
    latency: weights.latency ? weights.latency / sum : 0,
    stability: weights.stability ? weights.stability / sum : 0,
  } : { quality: 1, safety: 0, cost: 0, latency: 0, stability: 0 };

  // Calculate dynamic max values for relative mode
  let maxCost: number | undefined;
  let maxCostNodeId: string | undefined;
  let maxLatency: number | undefined;
  let maxLatencyNodeId: string | undefined;
  
  if (evaluation && config.fitness.costNorm?.mode === 'relative' && weights.cost) {
    const finishedNodes: CandidateNode[] = [];
    for (const generation of evaluation.generations) {
      for (const n of generation) {
        if (n.status === 'finished' && n.metrics?.costUSD !== undefined) {
          finishedNodes.push(n);
        }
      }
    }
    if (finishedNodes.length > 0) {
      const nodeWithMaxCost = finishedNodes.reduce((max, n) => 
        (n.metrics!.costUSD! > (max.metrics?.costUSD || 0)) ? n : max
      );
      maxCost = nodeWithMaxCost.metrics!.costUSD;
      maxCostNodeId = nodeWithMaxCost.id;
    }
  }

  if (evaluation && config.fitness.latencyNorm?.mode === 'relative' && weights.latency) {
    const finishedNodes: CandidateNode[] = [];
    for (const generation of evaluation.generations) {
      for (const n of generation) {
        if (n.status === 'finished' && n.metrics?.latencyMs !== undefined) {
          finishedNodes.push(n);
        }
      }
    }
    if (finishedNodes.length > 0) {
      const nodeWithMaxLatency = finishedNodes.reduce((max, n) => 
        (n.metrics!.latencyMs! > (max.metrics?.latencyMs || 0)) ? n : max
      );
      maxLatency = nodeWithMaxLatency.metrics!.latencyMs;
      maxLatencyNodeId = nodeWithMaxLatency.id;
    }
  }

  // Calculate components
  const components: Array<{ label: string; value: number; weight: number; contribution: number; details?: string }> = [];

  // Quality
  if (node.metrics.quality !== undefined) {
    components.push({
      label: 'Quality',
      value: node.metrics.quality,
      weight: normalizedWeights.quality,
      contribution: normalizedWeights.quality * node.metrics.quality,
    });
  }

  // Safety
  if (node.metrics.safety !== undefined && normalizedWeights.safety > 0) {
    components.push({
      label: 'Safety',
      value: node.metrics.safety,
      weight: normalizedWeights.safety,
      contribution: normalizedWeights.safety * node.metrics.safety,
    });
  }

  // Cost
  if (node.metrics.costUSD !== undefined && normalizedWeights.cost > 0 && config.fitness.costNorm) {
    const maxCostValue = config.fitness.costNorm.mode === 'relative' && maxCost !== undefined
      ? maxCost
      : config.fitness.costNorm.maxUSDPerCall || 0.1;
    const costNorm = Math.min(1, node.metrics.costUSD / maxCostValue);
    const costScore = (1 - costNorm) * 10;
    
    let details = `Formula: score = (1 - (cost / maxCost)) × 10\n`;
    details += `• This cost: ${formatCost(node.metrics.costUSD)}\n`;
    details += `• Max cost: ${formatCost(maxCostValue)}`;
    if (config.fitness.costNorm.mode === 'relative' && maxCostNodeId) {
      details += ` (from node ${maxCostNodeId.slice(0, 8)})`;
    } else {
      details += ` (${config.fitness.costNorm.mode} mode)`;
    }
    details += `\n• Normalized: ${node.metrics.costUSD.toFixed(6)} / ${maxCostValue.toFixed(6)} = ${costNorm.toFixed(3)}`;
    details += `\n• Score: (1 - ${costNorm.toFixed(3)}) × 10 = ${costScore.toFixed(2)}`;
    details += `\n• Lower cost = higher score`;
    
    components.push({
      label: 'Cost',
      value: costScore,
      weight: normalizedWeights.cost,
      contribution: normalizedWeights.cost * costScore,
      details,
    });
  }

  // Latency
  if (node.metrics.latencyMs !== undefined && normalizedWeights.latency > 0 && config.fitness.latencyNorm) {
    const maxLatencyValue = config.fitness.latencyNorm.mode === 'relative' && maxLatency !== undefined
      ? maxLatency
      : config.fitness.latencyNorm.maxMs || 30000;
    const latencyNorm = Math.min(1, node.metrics.latencyMs / maxLatencyValue);
    const latencyScore = (1 - latencyNorm) * 10;
    
    let details = `Formula: score = (1 - (latency / maxLatency)) × 10\n`;
    details += `• This latency: ${node.metrics.latencyMs.toFixed(0)}ms\n`;
    details += `• Max latency: ${maxLatencyValue.toFixed(0)}ms`;
    if (config.fitness.latencyNorm.mode === 'relative' && maxLatencyNodeId) {
      details += ` (from node ${maxLatencyNodeId.slice(0, 8)})`;
    } else {
      details += ` (${config.fitness.latencyNorm.mode} mode)`;
    }
    details += `\n• Normalized: ${node.metrics.latencyMs.toFixed(1)} / ${maxLatencyValue.toFixed(1)} = ${latencyNorm.toFixed(3)}`;
    details += `\n• Score: (1 - ${latencyNorm.toFixed(3)}) × 10 = ${latencyScore.toFixed(2)}`;
    details += `\n• Lower latency = higher score`;
    
    components.push({
      label: 'Latency',
      value: latencyScore,
      weight: normalizedWeights.latency,
      contribution: normalizedWeights.latency * latencyScore,
      details,
    });
  }

  // Stability
  const stabilityValue = node.metrics?.stability;
  if (stabilityValue !== undefined && normalizedWeights.stability > 0) {
    components.push({
      label: 'Stability',
      value: stabilityValue,
      weight: normalizedWeights.stability,
      contribution: normalizedWeights.stability * stabilityValue,
    });
  }

  const totalFitness = components.reduce((sum, c) => sum + c.contribution, 0);

  return (
    <div className="space-y-3">
      {/* Formula */}
      <div className="font-mono text-xs bg-muted p-2 rounded">
        <div className="font-semibold mb-1 text-foreground">Formula:</div>
        <div className="text-muted-foreground">
          fitness = {components.map((c, i) => (
            <span key={i}>
              {i > 0 && ' + '}
              <span className="text-foreground">{c.weight.toFixed(3)}</span> × {c.label.toLowerCase()}
            </span>
          ))}
        </div>
      </div>

      {/* Components */}
      <div className="space-y-2">
        <div className="font-semibold text-foreground">Components:</div>
        {components.map((c, i) => (
          <div key={i} className="bg-muted/50 p-2 rounded space-y-1">
            <div className="flex justify-between items-start">
              <span className="font-medium text-foreground">{c.label}:</span>
              <span className="font-mono text-primary">{c.contribution.toFixed(3)}</span>
            </div>
            <div className="text-muted-foreground pl-2">
              <div>{c.weight.toFixed(3)} (weight) × {c.value.toFixed(2)} (score)</div>
              {c.details && (
                <div className="text-[10px] mt-2 font-mono whitespace-pre-line opacity-90 bg-background p-2 rounded border">
                  {c.details}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Total */}
      <div className="border-t pt-2 flex justify-between items-center font-semibold">
        <span className="text-foreground">Total Fitness:</span>
        <span className="font-mono text-lg text-primary">{totalFitness.toFixed(3)}</span>
      </div>
    </div>
  );
}

function findNode(evaluation: EvaluationRun | null | undefined, nodeId: UUID): CandidateNode | null {
  if (!evaluation) return null;
  
  for (const generation of evaluation.generations) {
    const node = generation.find(n => n.id === nodeId);
    if (node) return node;
  }
  
  return null;
}

