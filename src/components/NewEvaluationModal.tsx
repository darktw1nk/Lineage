import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { v4 as uuidv4 } from 'uuid';
import type { EvaluationConfig, TestCase, ModelRef, ModelCostEntry } from '../types';

interface NewEvaluationModalProps {
  onClose: () => void;
  onCreated: (evalId: string) => void;
}

export function NewEvaluationModal({ onClose, onCreated }: NewEvaluationModalProps) {
  const [activeTab, setActiveTab] = useState('main');
  const [config, setConfig] = useState<Partial<EvaluationConfig>>({
    id: uuidv4(),
    name: 'New Evaluation',
    selection: {
      topShare: 0.4,
      policy: 'topk',
      topK: 4,
    },
    operators: {
      mutationFactor: 0.5,
      crossoverFactor: 0.3,
      paramVariation: {
        enabled: false,
        temperature: { min: 0.5, max: 1.5 },
        share: 0.2,
      },
      metaPrompting: {
        enabled: false,
        share: 0.2,
      },
    },
    population: {
      size: 10,
      seedPrompt: '',
      fill: 'auto',
    },
    enabledModels: [],
    testSet: [],
    fitness: {
      weights: {
        quality: 1.0,
        safety: 0,
        cost: 0,
        latency: 0,
        stability: 0,
      },
      guardrails: [],
      costNorm: { maxUSDPerCall: 0.1 },
      latencyNorm: { maxMs: 5000 },
    },
    targets: {
      timeLimitMs: 3600000, // 1 hour
      budgetUSD: 10,
      targetFitness: 9.0,
    },
    serviceModel: { provider: 'openai', model: 'gpt-4' },
    parallelLimit: 5,
    rawBlobCapture: false,
  });

  const [errors, setErrors] = useState<Record<string, string>>({});

  const createEvaluation = useMutation({
    mutationFn: async (config: EvaluationConfig) => {
      const run = await window.electronAPI.eval.create(config);
      return run;
    },
    onSuccess: (run) => {
      onCreated(run.id);
    },
  });

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!config.name) newErrors.main = 'Name is required';
    
    // Validate population based on fill mode
    if (config.population?.fill === 'manual') {
      const manualPrompts = (config.population as any)?.manualPrompts || [];
      if (manualPrompts.length === 0) {
        newErrors.population = 'Manual mode requires at least one prompt';
      } else if (manualPrompts.length < (config.population?.size || 10)) {
        newErrors.population = `Manual mode requires ${config.population?.size || 10} prompts (you have ${manualPrompts.length})`;
      } else {
        // Check if any prompt is empty
        for (let i = 0; i < manualPrompts.length; i++) {
          if (!manualPrompts[i].prompt?.trim()) {
            newErrors.population = `Prompt #${i + 1} is empty`;
            break;
          }
        }
      }
    } else {
      if (!config.population?.seedPrompt) newErrors.population = 'Seed prompt is required';
    }
    
    if (!config.enabledModels || config.enabledModels.length === 0) {
      newErrors.models = 'At least one model must be enabled';
    }
    if (!config.testSet || config.testSet.length === 0) {
      newErrors.testset = 'At least one test is required';
    }
    if (!config.targets?.timeLimitMs && !config.targets?.budgetUSD && !config.targets?.targetFitness) {
      newErrors.targets = 'At least one target must be set';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleStart = () => {
    if (validate()) {
      createEvaluation.mutate(config as EvaluationConfig);
    }
  };

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>New Evaluation</DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
          <TabsList className="grid w-full grid-cols-7">
            <TabsTrigger value="main" className={errors.main ? 'text-red-500' : ''}>
              Main
            </TabsTrigger>
            <TabsTrigger value="population" className={errors.population ? 'text-red-500' : ''}>
              Population
            </TabsTrigger>
            <TabsTrigger value="models" className={errors.models ? 'text-red-500' : ''}>
              Models
            </TabsTrigger>
            <TabsTrigger value="testset" className={errors.testset ? 'text-red-500' : ''}>
              Test Set
            </TabsTrigger>
            <TabsTrigger value="fitness">Fitness</TabsTrigger>
            <TabsTrigger value="targets" className={errors.targets ? 'text-red-500' : ''}>
              Targets
            </TabsTrigger>
            <TabsTrigger value="advanced">Advanced</TabsTrigger>
          </TabsList>

          <div className="flex-1 overflow-y-auto p-4">
            <TabsContent value="main" className="space-y-4 mt-0">
              <MainTab config={config} setConfig={setConfig} />
            </TabsContent>

            <TabsContent value="population" className="space-y-4 mt-0">
              <PopulationTab config={config} setConfig={setConfig} />
            </TabsContent>

            <TabsContent value="models" className="space-y-4 mt-0">
              <ModelsTab config={config} setConfig={setConfig} />
            </TabsContent>

            <TabsContent value="testset" className="space-y-4 mt-0">
              <TestSetTab config={config} setConfig={setConfig} />
            </TabsContent>

            <TabsContent value="fitness" className="space-y-4 mt-0">
              <FitnessTab config={config} setConfig={setConfig} />
            </TabsContent>

            <TabsContent value="targets" className="space-y-4 mt-0">
              <TargetsTab config={config} setConfig={setConfig} />
            </TabsContent>

            <TabsContent value="advanced" className="space-y-4 mt-0">
              <AdvancedTab config={config} setConfig={setConfig} />
            </TabsContent>
          </div>
        </Tabs>

        <div className="flex justify-between border-t pt-4">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleStart}>Start Evaluation</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Main Tab
function MainTab({ config, setConfig }: TabProps) {
  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="name">Evaluation Name</Label>
        <Input
          id="name"
          value={config.name || ''}
          onChange={(e) => setConfig({ ...config, name: e.target.value })}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="mutationFactor">Mutation Factor (0-1)</Label>
          <Input
            id="mutationFactor"
            type="number"
            step="0.1"
            min="0"
            max="1"
            value={config.operators?.mutationFactor || 0.5}
            onChange={(e) =>
              setConfig({
                ...config,
                operators: {
                  ...config.operators!,
                  mutationFactor: parseFloat(e.target.value) || 0,
                },
              })
            }
          />
        </div>

        <div>
          <Label htmlFor="crossoverFactor">Crossover Factor (0-1)</Label>
          <Input
            id="crossoverFactor"
            type="number"
            step="0.1"
            min="0"
            max="1"
            value={config.operators?.crossoverFactor || 0.3}
            onChange={(e) =>
              setConfig({
                ...config,
                operators: {
                  ...config.operators!,
                  crossoverFactor: parseFloat(e.target.value) || 0,
                },
              })
            }
          />
        </div>
      </div>

      <div>
        <Label htmlFor="selectionPolicy">Selection Policy</Label>
        <select
          id="selectionPolicy"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={config.selection?.policy || 'topk'}
          onChange={(e) =>
            setConfig({
              ...config,
              selection: {
                ...config.selection!,
                policy: e.target.value as 'topk' | 'topp',
              },
            })
          }
        >
          <option value="topk">Top-K (select top K candidates)</option>
          <option value="topp">Top-P (select top proportion)</option>
        </select>
      </div>

      <div>
        <Label htmlFor="topShare">Top Share for Selection (0-1)</Label>
        <Input
          id="topShare"
          type="number"
          step="0.1"
          min="0"
          max="1"
          value={config.selection?.topShare || 0.4}
          onChange={(e) =>
            setConfig({
              ...config,
              selection: {
                ...config.selection!,
                topShare: parseFloat(e.target.value) || 0.4,
              },
            })
          }
        />
        <div className="text-xs text-muted-foreground mt-1">
          {config.selection?.policy === 'topk' 
            ? `Will select top ${Math.ceil((config.population?.size || 10) * (config.selection?.topShare || 0.4))} candidates`
            : `Will select top ${((config.selection?.topShare || 0.4) * 100).toFixed(0)}% of candidates`
          }
        </div>
      </div>

      <div className="flex items-center space-x-2">
        <Switch
          id="tempVariation"
          checked={config.operators?.paramVariation?.enabled || false}
          onCheckedChange={(checked) =>
            setConfig({
              ...config,
              operators: {
                ...config.operators!,
                paramVariation: {
                  ...config.operators!.paramVariation!,
                  enabled: checked,
                },
              },
            })
          }
        />
        <Label htmlFor="tempVariation">Enable Temperature Variations</Label>
      </div>

      {config.operators?.paramVariation?.enabled && (
        <div className="grid grid-cols-3 gap-2 pl-6">
          <div>
            <Label htmlFor="tempMin">Min</Label>
            <Input
              id="tempMin"
              type="number"
              step="0.1"
              value={config.operators?.paramVariation?.temperature.min || 0.5}
              onChange={(e) =>
                setConfig({
                  ...config,
                  operators: {
                    ...config.operators!,
                    paramVariation: {
                      ...config.operators!.paramVariation!,
                      temperature: {
                        ...config.operators!.paramVariation!.temperature,
                        min: parseFloat(e.target.value) || 0,
                      },
                    },
                  },
                })
              }
            />
          </div>
          <div>
            <Label htmlFor="tempMax">Max</Label>
            <Input
              id="tempMax"
              type="number"
              step="0.1"
              value={config.operators?.paramVariation?.temperature.max || 1.5}
              onChange={(e) =>
                setConfig({
                  ...config,
                  operators: {
                    ...config.operators!,
                    paramVariation: {
                      ...config.operators!.paramVariation!,
                      temperature: {
                        ...config.operators!.paramVariation!.temperature,
                        max: parseFloat(e.target.value) || 0,
                      },
                    },
                  },
                })
              }
            />
          </div>
          <div>
            <Label htmlFor="tempShare">Share</Label>
            <Input
              id="tempShare"
              type="number"
              step="0.1"
              value={config.operators?.paramVariation?.share || 0.2}
              onChange={(e) =>
                setConfig({
                  ...config,
                  operators: {
                    ...config.operators!,
                    paramVariation: {
                      ...config.operators!.paramVariation!,
                      share: parseFloat(e.target.value) || 0,
                    },
                  },
                })
              }
            />
          </div>
        </div>
      )}

      <div className="flex items-center space-x-2">
        <Switch
          id="metaPrompting"
          checked={config.operators?.metaPrompting?.enabled || false}
          onCheckedChange={(checked) =>
            setConfig({
              ...config,
              operators: {
                ...config.operators!,
                metaPrompting: {
                  ...config.operators!.metaPrompting!,
                  enabled: checked,
                },
              },
            })
          }
        />
        <Label htmlFor="metaPrompting">Enable Meta-Prompting</Label>
      </div>

      {config.operators?.metaPrompting?.enabled && (
        <div className="pl-6">
          <Label htmlFor="metaShare">Meta-Prompting Share</Label>
          <Input
            id="metaShare"
            type="number"
            step="0.1"
            value={config.operators?.metaPrompting?.share || 0.2}
            onChange={(e) =>
              setConfig({
                ...config,
                operators: {
                  ...config.operators!,
                  metaPrompting: {
                    ...config.operators!.metaPrompting!,
                    share: parseFloat(e.target.value) || 0,
                  },
                },
              })
            }
          />
        </div>
      )}
    </div>
  );
}

// Population Tab
function PopulationTab({ config, setConfig }: TabProps) {
  const { data: costs = [] } = useQuery<ModelCostEntry[]>({
    queryKey: ['costs'],
    queryFn: () => window.electronAPI.costs.getAll(),
  });

  const isManualMode = config.population?.fill === 'manual';
  const manualPrompts = (config.population as any)?.manualPrompts || [];

  const addManualPrompt = () => {
    const newPrompts = [...manualPrompts, { prompt: '', model: costs[0] ? { provider: costs[0].provider, model: costs[0].model } : { provider: 'openai', model: 'gpt-4' } }];
    setConfig({
      ...config,
      population: {
        ...config.population!,
        manualPrompts: newPrompts,
      } as any,
    });
  };

  const updateManualPrompt = (index: number, field: 'prompt' | 'model', value: any) => {
    const newPrompts = [...manualPrompts];
    if (field === 'prompt') {
      newPrompts[index].prompt = value;
    } else {
      const [provider, model] = value.split(':');
      newPrompts[index].model = { provider, model };
    }
    setConfig({
      ...config,
      population: {
        ...config.population!,
        manualPrompts: newPrompts,
      } as any,
    });
  };

  const removeManualPrompt = (index: number) => {
    const newPrompts = manualPrompts.filter((_: any, i: number) => i !== index);
    setConfig({
      ...config,
      population: {
        ...config.population!,
        manualPrompts: newPrompts,
      } as any,
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="popSize">Initial Population Size</Label>
        <Input
          id="popSize"
          type="number"
          min="1"
          value={config.population?.size || 10}
          onChange={(e) =>
            setConfig({
              ...config,
              population: {
                ...config.population!,
                size: parseInt(e.target.value) || 10,
              },
            })
          }
        />
      </div>

      <div>
        <Label htmlFor="fill">Population Fill Mode</Label>
        <select
          id="fill"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={config.population?.fill || 'auto'}
          onChange={(e) =>
            setConfig({
              ...config,
              population: {
                ...config.population!,
                fill: e.target.value as 'auto' | 'manual',
              },
            })
          }
        >
          <option value="auto">Auto (generate via mutations from seed)</option>
          <option value="manual">Manual (specify each prompt)</option>
        </select>
      </div>

      {!isManualMode ? (
        <div>
          <Label htmlFor="seedPrompt">Seed Prompt</Label>
          <textarea
            id="seedPrompt"
            className="w-full h-32 rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={config.population?.seedPrompt || ''}
            onChange={(e) =>
              setConfig({
                ...config,
                population: {
                  ...config.population!,
                  seedPrompt: e.target.value,
                },
              })
            }
            placeholder="Enter the initial prompt to evolve..."
          />
          <div className="text-xs text-muted-foreground mt-1">
            The seed prompt will be used to generate {config.population?.size || 10} variations
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label>Manual Prompts ({manualPrompts.length} / {config.population?.size || 10})</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addManualPrompt}
              disabled={manualPrompts.length >= (config.population?.size || 10)}
            >
              + Add Prompt
            </Button>
          </div>

          {manualPrompts.length === 0 && (
            <div className="text-sm text-muted-foreground bg-muted p-3 rounded-md">
              Click "Add Prompt" to manually specify each initial prompt
            </div>
          )}

          <div className="space-y-3 max-h-96 overflow-y-auto">
            {manualPrompts.map((item: any, index: number) => (
              <div key={index} className="border rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-semibold">Prompt #{index + 1}</Label>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => removeManualPrompt(index)}
                  >
                    Remove
                  </Button>
                </div>
                <textarea
                  className="w-full h-24 rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={item.prompt}
                  onChange={(e) => updateManualPrompt(index, 'prompt', e.target.value)}
                  placeholder="Enter prompt text..."
                />
                <div>
                  <Label className="text-xs">Model</Label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                    value={`${item.model.provider}:${item.model.model}`}
                    onChange={(e) => updateManualPrompt(index, 'model', e.target.value)}
                  >
                    {costs.map((cost, idx) => (
                      <option key={idx} value={`${cost.provider}:${cost.model}`}>
                        {cost.provider}/{cost.model}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ))}
          </div>

          {manualPrompts.length < (config.population?.size || 10) && manualPrompts.length > 0 && (
            <div className="text-sm text-yellow-600 bg-yellow-50 p-3 rounded-md">
              ⚠ You have {manualPrompts.length} prompt(s), but population size is {config.population?.size || 10}. 
              Add {(config.population?.size || 10) - manualPrompts.length} more prompt(s).
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Models Tab
function ModelsTab({ config, setConfig }: TabProps) {
  const { data: costs = [] } = useQuery<ModelCostEntry[]>({
    queryKey: ['costs'],
    queryFn: () => window.electronAPI.costs.getAll(),
  });

  const availableModels: ModelRef[] = costs.map(cost => ({
    provider: cost.provider,
    model: cost.model,
  }));

  const toggleModel = (model: ModelRef) => {
    const enabled = config.enabledModels || [];
    const isEnabled = enabled.some(
      (m) => m.provider === model.provider && m.model === model.model
    );

    if (isEnabled) {
      setConfig({
        ...config,
        enabledModels: enabled.filter(
          (m) => !(m.provider === model.provider && m.model === model.model)
        ),
      });
    } else {
      setConfig({
        ...config,
        enabledModels: [...enabled, model],
      });
    }
  };

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">
        Select models to use in the evaluation (loaded from Models & Costs settings)
      </div>

      {availableModels.length === 0 && (
        <div className="text-sm text-yellow-600 bg-yellow-50 p-3 rounded-md">
          No models configured. Please go to Settings → Models & Costs to add models.
        </div>
      )}

      <div className="space-y-2 max-h-96 overflow-y-auto">
        {availableModels.map((model, idx) => {
          const isEnabled = (config.enabledModels || []).some(
            (m) => m.provider === model.provider && m.model === model.model
          );

          return (
            <div key={idx} className="flex items-center space-x-2">
              <input
                type="checkbox"
                id={`model-${idx}`}
                checked={isEnabled}
                onChange={() => toggleModel(model)}
                className="h-4 w-4"
              />
              <Label htmlFor={`model-${idx}`} className="flex-1 cursor-pointer">
                {model.provider} / {model.model}
              </Label>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Test Set Tab
function TestSetTab({ config, setConfig }: TabProps) {
  const addTest = () => {
    const newTest: TestCase = {
      id: uuidv4(),
      name: `Test ${(config.testSet?.length || 0) + 1}`,
      mode: 'llm_grade',
      prompt: '',
    };

    setConfig({
      ...config,
      testSet: [...(config.testSet || []), newTest],
    });
  };

  const updateTest = (id: string, updates: Partial<TestCase>) => {
    setConfig({
      ...config,
      testSet: (config.testSet || []).map((t) =>
        t.id === id ? { ...t, ...updates } : t
      ),
    });
  };

  const removeTest = (id: string) => {
    setConfig({
      ...config,
      testSet: (config.testSet || []).filter((t) => t.id !== id),
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div className="text-sm text-muted-foreground">
          Define tests for evaluating prompt quality
        </div>
        <Button size="sm" onClick={addTest}>
          Add Test
        </Button>
      </div>

      <div className="space-y-4">
        {(config.testSet || []).map((test) => (
          <div key={test.id} className="border rounded-lg p-4 space-y-3">
            <div className="flex justify-between">
              <Input
                value={test.name}
                onChange={(e) => updateTest(test.id, { name: e.target.value })}
                className="flex-1 mr-2"
                placeholder="Test name"
              />
              <Button
                size="sm"
                variant="destructive"
                onClick={() => removeTest(test.id)}
              >
                Remove
              </Button>
            </div>

            <div>
              <Label>Mode</Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={test.mode}
                onChange={(e) =>
                  updateTest(test.id, { mode: e.target.value as any })
                }
              >
                <option value="llm_grade">LLM Graded (1-10)</option>
                <option value="exact_match">Exact Match</option>
              </select>
            </div>

            <div>
              <Label>Test Prompt</Label>
              <textarea
                className="w-full h-20 rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={test.prompt}
                onChange={(e) => updateTest(test.id, { prompt: e.target.value })}
                placeholder="Enter test prompt..."
              />
            </div>

            {test.mode === 'exact_match' && (
              <div>
                <Label>Expected Output</Label>
                <Input
                  value={test.expected || ''}
                  onChange={(e) => updateTest(test.id, { expected: e.target.value })}
                  placeholder="Expected output..."
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Fitness Tab
function FitnessTab({ config, setConfig }: TabProps) {
  const weights = config.fitness?.weights || {};

  const setWeight = (key: string, value: number) => {
    setConfig({
      ...config,
      fitness: {
        ...config.fitness!,
        weights: {
          ...weights,
          [key]: value,
        },
      },
    });
  };

  // Calculate normalized weights for preview
  const sum = (weights.quality || 0) + 
               (weights.safety || 0) + 
               (weights.cost || 0) + 
               (weights.latency || 0) + 
               (weights.stability || 0);
  
  const normalized = sum > 0 ? {
    quality: ((weights.quality || 0) / sum).toFixed(3),
    safety: weights.safety ? ((weights.safety / sum).toFixed(3)) : undefined,
    cost: weights.cost ? ((weights.cost / sum).toFixed(3)) : undefined,
    latency: weights.latency ? ((weights.latency / sum).toFixed(3)) : undefined,
    stability: weights.stability ? ((weights.stability / sum).toFixed(3)) : undefined,
  } : null;

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">
        Configure fitness function weights (will be auto-normalized)
      </div>

      {/* Formula Preview */}
      {normalized && (
        <div className="rounded-md border bg-muted p-3 text-sm font-mono">
          <div className="font-semibold mb-2">Fitness Formula Preview:</div>
          <div>
            fitness = {normalized.quality} × quality
            {normalized.safety && ` + ${normalized.safety} × safety`}
            {normalized.stability && ` + ${normalized.stability} × stability`}
            {normalized.cost && ` + ${normalized.cost} × (1 - cost_norm)`}
            {normalized.latency && ` + ${normalized.latency} × (1 - latency_norm)`}
          </div>
        </div>
      )}

      <div>
        <Label htmlFor="quality-weight">Quality (required)</Label>
        <Input
          id="quality-weight"
          type="number"
          step="0.1"
          value={weights.quality || 1}
          onChange={(e) => setWeight('quality', parseFloat(e.target.value) || 0)}
        />
      </div>

      <div className="flex items-center space-x-2">
        <Switch
          id="safety-enabled"
          checked={(weights.safety || 0) > 0}
          onCheckedChange={(checked) => {
            setWeight('safety', checked ? 0.15 : 0);
            // Add default guardrail when safety is enabled
            if (checked && (!config.fitness?.guardrails || config.fitness.guardrails.length === 0)) {
              setConfig({
                ...config,
                fitness: {
                  ...config.fitness!,
                  guardrails: ['The output must be safe, respectful, and appropriate for all audiences. It should not contain harmful, offensive, or inappropriate content including profanity, hate speech, violence, or explicit material.'],
                },
              });
            }
          }}
        />
        <Label htmlFor="safety-enabled">Safety</Label>
        {(weights.safety || 0) > 0 && (
          <Input
            type="number"
            step="0.1"
            value={weights.safety || 0}
            onChange={(e) => setWeight('safety', parseFloat(e.target.value) || 0)}
            className="w-24"
          />
        )}
      </div>

      <div className="flex items-center space-x-2">
        <Switch
          id="cost-enabled"
          checked={(weights.cost || 0) > 0}
          onCheckedChange={(checked) => setWeight('cost', checked ? 0.1 : 0)}
        />
        <Label htmlFor="cost-enabled">Cost</Label>
        {(weights.cost || 0) > 0 && (
          <Input
            type="number"
            step="0.1"
            value={weights.cost || 0}
            onChange={(e) => setWeight('cost', parseFloat(e.target.value) || 0)}
            className="w-24"
          />
        )}
      </div>

      <div className="flex items-center space-x-2">
        <Switch
          id="latency-enabled"
          checked={(weights.latency || 0) > 0}
          onCheckedChange={(checked) => setWeight('latency', checked ? 0.05 : 0)}
        />
        <Label htmlFor="latency-enabled">Latency</Label>
        {(weights.latency || 0) > 0 && (
          <Input
            type="number"
            step="0.1"
            value={weights.latency || 0}
            onChange={(e) => setWeight('latency', parseFloat(e.target.value) || 0)}
            className="w-24"
          />
        )}
      </div>

      <div className="flex items-center space-x-2">
        <Switch
          id="stability-enabled"
          checked={(weights.stability || 0) > 0}
          onCheckedChange={(checked) => setWeight('stability', checked ? 0.15 : 0)}
        />
        <Label htmlFor="stability-enabled">Stability</Label>
        {(weights.stability || 0) > 0 && (
          <Input
            type="number"
            step="0.1"
            value={weights.stability || 0}
            onChange={(e) => setWeight('stability', parseFloat(e.target.value) || 0)}
            className="w-24"
          />
        )}
      </div>

      {/* Guardrails for Safety */}
      {(weights.safety || 0) > 0 && (
        <div className="border-t pt-4 space-y-3">
          <div className="flex items-center justify-between">
            <Label>Safety Guardrails</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const guardrails = config.fitness?.guardrails || [];
                setConfig({
                  ...config,
                  fitness: {
                    ...config.fitness!,
                    guardrails: [...guardrails, ''],
                  },
                });
              }}
            >
              + Add Guardrail
            </Button>
          </div>
          <div className="text-xs text-muted-foreground">
            Each guardrail is a safety check performed by the service model (0-10 score)
          </div>

          {(!config.fitness?.guardrails || config.fitness.guardrails.length === 0) && (
            <div className="text-sm text-muted-foreground bg-muted p-3 rounded-md">
              No guardrails configured. Add prompts to check safety constraints.
            </div>
          )}

          <div className="space-y-2 max-h-64 overflow-y-auto">
            {(config.fitness?.guardrails || []).map((guardrail, index) => (
              <div key={index} className="flex gap-2 items-start">
                <textarea
                  className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[80px]"
                  value={guardrail}
                  onChange={(e) => {
                    const newGuardrails = [...(config.fitness?.guardrails || [])];
                    newGuardrails[index] = e.target.value;
                    setConfig({
                      ...config,
                      fitness: {
                        ...config.fitness!,
                        guardrails: newGuardrails,
                      },
                    });
                  }}
                  placeholder="e.g., Output must not contain profanity or offensive language"
                />
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    const newGuardrails = (config.fitness?.guardrails || []).filter((_, i) => i !== index);
                    setConfig({
                      ...config,
                      fitness: {
                        ...config.fitness!,
                        guardrails: newGuardrails,
                      },
                    });
                  }}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Targets Tab
function TargetsTab({ config, setConfig }: TabProps) {
  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">
        Set stopping conditions (at least one required)
      </div>

      <div>
        <Label htmlFor="timeLimit">Time Limit (minutes)</Label>
        <Input
          id="timeLimit"
          type="number"
          value={(config.targets?.timeLimitMs || 0) / 60000}
          onChange={(e) =>
            setConfig({
              ...config,
              targets: {
                ...config.targets!,
                timeLimitMs: parseFloat(e.target.value) * 60000 || undefined,
              },
            })
          }
          placeholder="e.g., 60 for 1 hour"
        />
      </div>

      <div>
        <Label htmlFor="budget">Budget Limit (USD)</Label>
        <Input
          id="budget"
          type="number"
          step="0.1"
          value={config.targets?.budgetUSD || ''}
          onChange={(e) =>
            setConfig({
              ...config,
              targets: {
                ...config.targets!,
                budgetUSD: parseFloat(e.target.value) || undefined,
              },
            })
          }
          placeholder="e.g., 10"
        />
      </div>

      <div>
        <Label htmlFor="targetFitness">Target Fitness Score</Label>
        <Input
          id="targetFitness"
          type="number"
          step="0.1"
          min="0"
          max="10"
          value={config.targets?.targetFitness || ''}
          onChange={(e) =>
            setConfig({
              ...config,
              targets: {
                ...config.targets!,
                targetFitness: parseFloat(e.target.value) || undefined,
              },
            })
          }
          placeholder="e.g., 9.0"
        />
      </div>
    </div>
  );
}

// Advanced Tab
function AdvancedTab({ config, setConfig }: TabProps) {
  const { data: costs = [] } = useQuery<ModelCostEntry[]>({
    queryKey: ['costs'],
    queryFn: () => window.electronAPI.costs.getAll(),
  });

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="parallelLimit">Parallel Execution Limit</Label>
        <Input
          id="parallelLimit"
          type="number"
          min="1"
          max="20"
          value={config.parallelLimit || 5}
          onChange={(e) =>
            setConfig({ ...config, parallelLimit: parseInt(e.target.value) || 5 })
          }
        />
      </div>

      <div className="flex items-center space-x-2">
        <Switch
          id="rawBlob"
          checked={config.rawBlobCapture || false}
          onCheckedChange={(checked) =>
            setConfig({ ...config, rawBlobCapture: checked })
          }
        />
        <Label htmlFor="rawBlob">Capture Raw API Responses</Label>
      </div>

      <div className="space-y-2">
        <Label htmlFor="serviceModel">Service Model (for mutations/crossover/grading)</Label>
        <select
          id="serviceModel"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={`${config.serviceModel?.provider || 'openai'}:${config.serviceModel?.model || 'gpt-4'}`}
          onChange={(e) => {
            const [provider, model] = e.target.value.split(':');
            setConfig({
              ...config,
              serviceModel: { provider: provider as any, model },
            });
          }}
        >
          {costs.length === 0 && (
            <option value="">No models configured - go to Settings</option>
          )}
          {costs.map((cost, idx) => (
            <option key={idx} value={`${cost.provider}:${cost.model}`}>
              {cost.provider}/{cost.model}
            </option>
          ))}
        </select>
        <div className="text-xs text-muted-foreground">
          Models are loaded from Settings → Models & Costs
        </div>
      </div>
    </div>
  );
}

type TabProps = {
  config: Partial<EvaluationConfig>;
  setConfig: (config: Partial<EvaluationConfig>) => void;
};

