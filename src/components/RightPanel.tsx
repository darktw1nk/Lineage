import { X, Copy, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from './ui/button';
import { useState, useRef, useEffect } from 'react';
import type { UUID, EvaluationRun, CandidateNode } from '../types';
import { useEvaluation } from '../hooks/useEvaluation';

interface RightPanelProps {
  evaluationId: UUID | null;
  nodeId: UUID;
  onClose: () => void;
}

export function RightPanel({ evaluationId, nodeId, onClose }: RightPanelProps) {
  const [expandedTests, setExpandedTests] = useState<Set<UUID>>(new Set());
  const [expandedReasonings, setExpandedReasonings] = useState<Set<UUID>>(new Set());
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem('rightPanelWidth');
    return saved ? parseInt(saved, 10) : 384; // 384px = w-96
  });
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Centralized store - single source of truth!
  const { evaluation } = useEvaluation(evaluationId);

  const node = findNode(evaluation, nodeId);

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
                        Test {test.testId.substring(0, 8)}
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
                <Metric label="Cost" value={`$${node.metrics.costUSD.toFixed(4)}`} />
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
            </div>
          </Section>
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

function findNode(evaluation: EvaluationRun | null | undefined, nodeId: UUID): CandidateNode | null {
  if (!evaluation) return null;
  
  for (const generation of evaluation.generations) {
    const node = generation.find(n => n.id === nodeId);
    if (node) return node;
  }
  
  return null;
}

