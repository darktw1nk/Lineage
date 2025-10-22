import { X, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from './ui/button';
import { useState } from 'react';
import type { UUID, EvaluationConfig } from '../types';
import { useQuery } from '@tanstack/react-query';

interface EvaluationConfigPanelProps {
  evaluationId: UUID | null;
  onClose: () => void;
}

export function EvaluationConfigPanel({ evaluationId, onClose }: EvaluationConfigPanelProps) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(['selection', 'operators', 'models', 'tests', 'fitness', 'targets'])
  );

  const { data: config } = useQuery<EvaluationConfig | null>({
    queryKey: ['evaluation-config', evaluationId],
    queryFn: async () => {
      if (!evaluationId) return null;
      return window.electronAPI.eval.getConfig(evaluationId);
    },
    enabled: !!evaluationId,
  });

  if (!config) {
    return null;
  }

  const toggleSection = (section: string) => {
    const newExpanded = new Set(expandedSections);
    if (newExpanded.has(section)) {
      newExpanded.delete(section);
    } else {
      newExpanded.add(section);
    }
    setExpandedSections(newExpanded);
  };

  return (
    <div className="flex h-full w-96 flex-col border-l bg-card">
      {/* Header */}
      <div className="flex items-center justify-between border-b p-4">
        <h2 className="text-lg font-semibold">Evaluation Config</h2>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Name */}
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground mb-1">Name</h3>
          <p className="text-sm font-mono">{config.name}</p>
        </div>

        {/* Selection */}
        <CollapsibleSection
          title="Selection"
          isExpanded={expandedSections.has('selection')}
          onToggle={() => toggleSection('selection')}
        >
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Policy:</span>
              <span className="font-mono">{config.selection.policy.toUpperCase()}</span>
            </div>
            {config.selection.policy === 'topk' && config.selection.topK !== undefined && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Top K:</span>
                <span className="font-mono">{config.selection.topK}</span>
              </div>
            )}
            {config.selection.policy === 'topp' && config.selection.topP !== undefined && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Top P:</span>
                <span className="font-mono">{config.selection.topP}</span>
              </div>
            )}
          </div>
        </CollapsibleSection>

        {/* Operators */}
        <CollapsibleSection
          title="Genetic Operators"
          isExpanded={expandedSections.has('operators')}
          onToggle={() => toggleSection('operators')}
        >
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Mutation Factor:</span>
              <span className="font-mono">{config.operators.mutationFactor}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Crossover Factor:</span>
              <span className="font-mono">{config.operators.crossoverFactor}</span>
            </div>
            {config.operators.metaPrompting?.enabled && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Meta-Prompting:</span>
                <span className="font-mono">Share: {config.operators.metaPrompting.share}</span>
              </div>
            )}
            {config.operators.paramVariation?.enabled && (
              <div className="space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Param Variation:</span>
                  <span className="font-mono">Share: {config.operators.paramVariation.share}</span>
                </div>
                <div className="flex justify-between pl-4">
                  <span className="text-muted-foreground">Temp Range:</span>
                  <span className="font-mono">
                    {config.operators.paramVariation.temperature.min} - {config.operators.paramVariation.temperature.max}
                  </span>
                </div>
              </div>
            )}
          </div>
        </CollapsibleSection>

        {/* Population */}
        <CollapsibleSection
          title="Population"
          isExpanded={expandedSections.has('population')}
          onToggle={() => toggleSection('population')}
        >
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Size:</span>
              <span className="font-mono">{config.population.size}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Fill:</span>
              <span className="font-mono capitalize">{config.population.fill}</span>
            </div>
            <div>
              <div className="text-muted-foreground mb-1">Seed Prompt:</div>
              <div className="text-xs font-mono bg-muted p-2 rounded max-h-32 overflow-y-auto">
                {config.population.seedPrompt}
              </div>
            </div>
          </div>
        </CollapsibleSection>

        {/* Enabled Models */}
        <CollapsibleSection
          title="Enabled Models"
          isExpanded={expandedSections.has('models')}
          onToggle={() => toggleSection('models')}
        >
          <div className="space-y-1 text-sm">
            {config.enabledModels.map((model, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <span className="text-muted-foreground">{model.provider}:</span>
                <span className="font-mono text-xs">{model.model}</span>
              </div>
            ))}
          </div>
        </CollapsibleSection>

        {/* Test Set */}
        <CollapsibleSection
          title="Test Set"
          isExpanded={expandedSections.has('tests')}
          onToggle={() => toggleSection('tests')}
        >
          <div className="space-y-3 text-sm">
            {config.testSet.map((test, idx) => (
              <div key={test.id} className="border-l-2 border-muted pl-3">
                <div className="font-semibold mb-1">Test {idx + 1}: {test.name}</div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-muted-foreground">Mode:</span>
                  <span className="font-mono">{test.mode}</span>
                </div>
                <div className="text-xs font-mono bg-muted p-2 rounded max-h-24 overflow-y-auto">
                  {test.prompt.substring(0, 150)}{test.prompt.length > 150 ? '...' : ''}
                </div>
                {test.expected && (
                  <div className="text-xs mt-1">
                    <span className="text-muted-foreground">Expected:</span>
                    <div className="font-mono bg-muted p-1 rounded mt-1">
                      {test.expected.substring(0, 100)}{test.expected.length > 100 ? '...' : ''}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </CollapsibleSection>

        {/* Fitness Function */}
        <CollapsibleSection
          title="Fitness Function"
          isExpanded={expandedSections.has('fitness')}
          onToggle={() => toggleSection('fitness')}
        >
          <div className="space-y-2 text-sm">
            <div className="font-semibold text-xs text-muted-foreground mb-2">Weights:</div>
            {Object.entries(config.fitness.weights).map(([key, value]) => (
              value !== undefined && (
                <div key={key} className="flex justify-between">
                  <span className="text-muted-foreground capitalize">{key}:</span>
                  <span className="font-mono">{value}</span>
                </div>
              )
            ))}
            {config.fitness.guardrails && config.fitness.guardrails.length > 0 && (
              <div className="mt-2">
                <div className="text-muted-foreground mb-1">Guardrails:</div>
                <div className="text-xs font-mono bg-muted p-2 rounded max-h-24 overflow-y-auto">
                  {config.fitness.guardrails.map((g, idx) => (
                    <div key={idx} className="mb-1">• {g.substring(0, 100)}{g.length > 100 ? '...' : ''}</div>
                  ))}
                </div>
              </div>
            )}
            {config.fitness.costNorm && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Cost Norm Max:</span>
                <span className="font-mono">${config.fitness.costNorm.maxUSDPerCall}</span>
              </div>
            )}
            {config.fitness.latencyNorm && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Latency Norm Max:</span>
                <span className="font-mono">{config.fitness.latencyNorm.maxMs}ms</span>
              </div>
            )}
          </div>
        </CollapsibleSection>

        {/* Targets (Stopping Conditions) */}
        <CollapsibleSection
          title="Targets (Stop Conditions)"
          isExpanded={expandedSections.has('targets')}
          onToggle={() => toggleSection('targets')}
        >
          <div className="space-y-2 text-sm">
            {config.targets.timeLimitMs && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Time Limit:</span>
                <span className="font-mono">{(config.targets.timeLimitMs / 1000).toFixed(0)}s</span>
              </div>
            )}
            {config.targets.budgetUSD && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Budget:</span>
                <span className="font-mono">${config.targets.budgetUSD}</span>
              </div>
            )}
            {config.targets.targetFitness && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Target Fitness:</span>
                <span className="font-mono">{config.targets.targetFitness}</span>
              </div>
            )}
            {config.targets.maxGenerations && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Max Generations:</span>
                <span className="font-mono">{config.targets.maxGenerations}</span>
              </div>
            )}
          </div>
        </CollapsibleSection>

        {/* Service Model & Advanced */}
        <CollapsibleSection
          title="Advanced Settings"
          isExpanded={expandedSections.has('advanced')}
          onToggle={() => toggleSection('advanced')}
        >
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Service Model:</span>
              <span className="font-mono text-xs">{config.serviceModel.provider}/{config.serviceModel.model}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Parallel Limit:</span>
              <span className="font-mono">{config.parallelLimit}</span>
            </div>
            {config.rawBlobCapture && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Raw Capture:</span>
                <span className="font-mono">Enabled</span>
              </div>
            )}
          </div>
        </CollapsibleSection>
      </div>
    </div>
  );
}

// Collapsible Section Component
function CollapsibleSection({
  title,
  isExpanded,
  onToggle,
  children,
}: {
  title: string;
  isExpanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border rounded-lg">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
      >
        <span className="font-semibold text-sm">{title}</span>
        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>
      {isExpanded && <div className="p-3 pt-0">{children}</div>}
    </div>
  );
}

