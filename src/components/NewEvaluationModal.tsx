import { useState, useEffect } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { LabelWithTooltip } from './LabelWithTooltip';
import { HelpCircle } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import type { EvaluationConfig, TestCase, ModelRef, ModelCostEntry } from '../types';

interface NewEvaluationModalProps {
  onClose: () => void;
  onCreated: (evalId: string) => void;
}

export function NewEvaluationModal({ onClose, onCreated }: NewEvaluationModalProps) {
  const [activeTab, setActiveTab] = useState('main');
  
  // Generate new ID each time modal is opened to avoid conflicts
  const [configId] = useState(() => uuidv4());
  
  // Load settings to get service model
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => window.electronAPI.settings.get(),
  });
  
  const [config, setConfig] = useState<Partial<EvaluationConfig>>({
    id: configId,
    name: 'New Evaluation',
    selection: {
      policy: 'topk',
      topK: 4,
      eliteShare: 0.05,
    },
    operators: {
      mutationShare: 0.4,
      crossoverShare: 0.3,
      metaPrompting: {
        enabled: false,
        share: 0.1,
      },
      modelVariation: {
        enabled: false,
        share: 0.2,
      },
      paramVariation: {
        enabled: false,
        share: 0.2,
        temperature: { enabled: false, min: 0.5, max: 1.5 },
      },
    },
    population: {
      initialSize: 10,
      generationSize: 10,
      seedPrompt: `Please read the following bug report and extract the key information into a JSON format.

The JSON should have the bug id, a summary, the priority, if it is a UI bug, and a list of components that are affected.

Here is the bug report:
-----------`,
      fill: 'auto',
    },
    enabledModels: [
      { provider: 'openai', model: 'gpt-5-mini' },
      { provider: 'openai', model: 'gpt-5-nano' },
      { provider: 'openai', model: 'gpt-4.1-mini' },
      { provider: 'openai', model: 'gpt-4.1-nano' },
    ],
    testSet: [
      {
        id: uuidv4(),
        name: 'Bug Report Test',
        prompt: `Okay, so my user ID is 952. When I click the 'Export' button on the main dashboard, the whole app crashes. It's super frustrating. I'd say this is a high priority issue. It seems to affect the Reporting and Dashboard modules.`,
        mode: 'llm_grade',
      },
    ],
    fitness: {
      weights: {
        quality: 0.4,
        safety: 0,
        cost: 0.3,
        latency: 0.3,
        stability: 0,
      },
      guardrails: [],
      costNorm: { mode: 'absolute', maxUSDPerCall: 0.1 },
      latencyNorm: { mode: 'absolute', maxMs: 30000 },
    },
    targets: {
      timeLimitMs: 3600000, // 1 hour
      budgetUSD: 10,
      targetFitness: 9.0,
      maxGenerations: 3,
    },
    serviceModel: settings?.serviceModel || undefined,
    parallelLimit: settings?.globalParallelLimit || 5,
    serviceModelMaxTokens: settings?.serviceModelMaxTokens || 20000, // Load from settings - applies to ALL models
  });

  const [errors, setErrors] = useState<Record<string, string>>({});

  // Update serviceModel when settings load
  useEffect(() => {
    if (settings?.serviceModel && !config.serviceModel?.model) {
      console.log('[NewEval] Updating serviceModel from settings:', settings.serviceModel);
      setConfig(prev => ({
        ...prev,
        serviceModel: settings.serviceModel,
        parallelLimit: settings.globalParallelLimit || 5,
        serviceModelMaxTokens: settings.serviceModelMaxTokens || 20000,
      }));
    }
  }, [settings]);

  const createEvaluation = useMutation({
    mutationFn: async (config: EvaluationConfig) => {
      console.log('[NewEval] Creating evaluation...');
      const run = await window.electronAPI.eval.create(config);
      console.log('[NewEval] Evaluation created:', run.id);
      
      // CRITICAL: Select the evaluation BEFORE starting it
      // This ensures IPC subscription is set up before backend sends updates
      console.log('[NewEval] Selecting evaluation (to set up IPC subscription)...');
      onCreated(run.id);
      
      // Wait a tiny bit for React to process the state change and subscribe
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // NOW start the evaluation - subscription is ready!
      console.log('[NewEval] Starting evaluation on backend...');
      await window.electronAPI.eval.start(run.id);
      console.log('[NewEval] Backend start call completed');
      return run;
    },
    onError: (error: any) => {
      console.error('[NewEval] Mutation failed:', error);
      toast.error(`Failed to create evaluation: ${error instanceof Error ? error.message : String(error)}`);
    },
  });

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!config.name) newErrors.main = 'Name is required';
    if (!config.serviceModel || !config.serviceModel.model) {
      newErrors.main = 'Service Model is required - please set it in Settings first';
    }
    
    // Validate population based on fill mode
    if (config.population?.fill === 'manual') {
      const manualPrompts = (config.population as any)?.manualPrompts || [];
      if (manualPrompts.length === 0) {
        newErrors.population = 'Manual mode requires at least one prompt';
      } else if (manualPrompts.length < (config.population?.initialSize || 10)) {
        newErrors.population = `Manual mode requires ${config.population?.initialSize || 10} prompts (you have ${manualPrompts.length})`;
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
    if (!config.targets?.timeLimitMs && !config.targets?.budgetUSD && !config.targets?.targetFitness && !config.targets?.maxGenerations) {
      newErrors.targets = 'At least one target must be set';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleStart = () => {
    console.log('[NewEval] Start button clicked');
    console.log('[NewEval] Config:', config);
    const isValid = validate();
    console.log('[NewEval] Validation result:', isValid);
    console.log('[NewEval] Errors:', errors);
    if (isValid) {
      console.log('[NewEval] Starting evaluation...');
      createEvaluation.mutate(config as EvaluationConfig);
    } else {
      console.error('[NewEval] Validation failed:', errors);
      alert('Please fix the errors highlighted in red tabs: ' + Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join(', '));
    }
  };

  return (
    <TooltipProvider>
      <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>New Evaluation</DialogTitle>
          <DialogDescription>
            Configure and start a new prompt evolution evaluation
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
          <TabsList className="grid w-full grid-cols-8">
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
            <TabsTrigger value="variations">Variations</TabsTrigger>
            <TabsTrigger value="fitness">Fitness</TabsTrigger>
            <TabsTrigger value="targets" className={errors.targets ? 'text-red-500' : ''}>
              Targets
            </TabsTrigger>
            <TabsTrigger value="advanced">Advanced</TabsTrigger>
          </TabsList>

          <div className="overflow-y-auto p-4 h-[500px] min-h-0">
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

            <TabsContent value="variations" className="space-y-4 mt-0">
              <VariationsTab config={config} setConfig={setConfig} />
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
    </TooltipProvider>
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

      <div>
        <LabelWithTooltip 
          htmlFor="selectionPolicy" 
          label="Selection Policy"
          tooltip="How to select parents for the next generation. Top-K selects the best K candidates. Top-P selects candidates until their cumulative fitness reaches P% of total fitness."
        />
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
                topK: e.target.value === 'topk' ? 4 : undefined,
                topP: e.target.value === 'topp' ? 0.8 : undefined,
              },
            })
          }
        >
          <option value="topk">Top-K (fixed number of best)</option>
          <option value="topp">Top-P (cumulative probability)</option>
        </select>
        <div className="text-xs text-muted-foreground mt-1">
          {config.selection?.policy === 'topk' 
            ? 'Select a fixed number of top performers'
            : 'Select candidates until cumulative fitness probability reaches threshold'
          }
        </div>
      </div>

      {config.selection?.policy === 'topk' ? (
        <div>
          <LabelWithTooltip 
            htmlFor="topK" 
            label="Top K (number of candidates)"
            tooltip="Number of best-performing candidates to select as parents for the next generation. Higher values maintain more diversity but may slow convergence."
          />
          <Input
            id="topK"
            type="number"
            min="1"
            max={config.population?.generationSize || 10}
            value={config.selection?.topK || 4}
            onChange={(e) =>
              setConfig({
                ...config,
                selection: {
                  ...config.selection!,
                  topK: parseInt(e.target.value) || 4,
                },
              })
            }
          />
          <div className="text-xs text-muted-foreground mt-1">
            Will select top {config.selection?.topK || 4} candidates from each generation
          </div>
        </div>
      ) : (
        <div>
          <Label htmlFor="topP">Top P (cumulative probability 0-1)</Label>
          <Input
            id="topP"
            type="number"
            step="0.05"
            min="0.1"
            max="1"
            value={config.selection?.topP || 0.8}
            onChange={(e) =>
              setConfig({
                ...config,
                selection: {
                  ...config.selection!,
                  topP: parseFloat(e.target.value) || 0.8,
                },
              })
            }
          />
          <div className="text-xs text-muted-foreground mt-1">
            Will select candidates until {((config.selection?.topP || 0.8) * 100).toFixed(0)}% of total fitness is covered
          </div>
        </div>
      )}

      <div>
        <LabelWithTooltip 
          htmlFor="eliteShare" 
          label="Elite Share (0-1)"
          tooltip="Fraction of the best candidates from the previous generation to carry forward unchanged. Ensures the best solutions are never lost. Always carries at least 1 elite when enabled."
        />
        <Input
          id="eliteShare"
          type="number"
          min="0"
          max="0.5"
          value={config.selection?.eliteShare || 0}
          onChange={(e) =>
            setConfig({
              ...config,
              selection: {
                ...config.selection!,
                eliteShare: parseFloat(e.target.value) || 0,
              },
            })
          }
          placeholder="0.05"
        />
        <div className="text-xs text-muted-foreground mt-1">
          {config.selection?.eliteShare && config.selection.eliteShare > 0
            ? `Will carry over ${Math.round((config.selection.eliteShare) * 100)}% best nodes from previous generation (minimum 1, currently ${Math.max(1, Math.round((config.selection.eliteShare) * (config.population?.generationSize || 10)))} elite${Math.max(1, Math.round((config.selection.eliteShare) * (config.population?.generationSize || 10))) === 1 ? '' : 's'})`
            : 'Elitism disabled. When enabled, always carries at least 1 best node from previous generation'
          }
        </div>
      </div>
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
    if (!costs || costs.length === 0) {
      alert('No models configured. Please add models in Settings first.');
      return;
    }
    const newPrompts = [...manualPrompts, { prompt: '', model: { provider: costs[0].provider, model: costs[0].model } }];
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
        <LabelWithTooltip 
          htmlFor="initialSize" 
          label="Initial Population Size (Generation 0)"
          tooltip="Number of candidates in the first generation. Use a larger value for broader initial exploration or a smaller value for faster startup."
        />
        <Input
          id="initialSize"
          type="number"
          min="1"
          value={config.population?.initialSize || 10}
          onChange={(e) =>
            setConfig({
              ...config,
              population: {
                ...config.population!,
                initialSize: parseInt(e.target.value) || 10,
              },
            })
          }
        />
        <div className="text-xs text-muted-foreground mt-1">
          Number of candidates in the first generation
        </div>
      </div>

      <div>
        <LabelWithTooltip 
          htmlFor="generationSize" 
          label="Generation Size (Gen 1+)"
          tooltip="Number of candidates in each generation after the first. This determines the population size for generations 1, 2, 3, etc."
        />
        <Input
          id="generationSize"
          type="number"
          min="1"
          value={config.population?.generationSize || 10}
          onChange={(e) =>
            setConfig({
              ...config,
              population: {
                ...config.population!,
                generationSize: parseInt(e.target.value) || 10,
              },
            })
          }
        />
        <div className="text-xs text-muted-foreground mt-1">
          Number of candidates in each subsequent generation
        </div>
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
            The seed prompt will be used to generate {config.population?.initialSize || 10} variations for generation 0
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label>Manual Prompts ({manualPrompts.length} / {config.population?.initialSize || 10})</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addManualPrompt}
              disabled={manualPrompts.length >= (config.population?.initialSize || 10)}
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

          {manualPrompts.length < (config.population?.initialSize || 10) && manualPrompts.length > 0 && (
            <div className="text-sm text-yellow-600 bg-yellow-50 p-3 rounded-md">
              ⚠ You have {manualPrompts.length} prompt(s), but initial population size is {config.population?.initialSize || 10}. 
              Add {(config.population?.initialSize || 10) - manualPrompts.length} more prompt(s).
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
        <LabelWithTooltip 
          htmlFor="testset-section" 
          label="Define tests for evaluating prompt quality"
          tooltip="Each candidate prompt is evaluated against the entire test set, one test at a time. All test results are aggregated to compute the final quality score. Test Modes: (1) Exact Match - compares LLM output to expected string: 'strict' mode requires perfect match, or use distance metrics (Levenshtein/Hamming/Jaro) for fuzzy matching with configurable thresholds. (2) LLM Graded - service model evaluates output quality on 0-10 scale based on your rubric/criteria, useful for subjective or complex evaluations."
        />
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
              <>
                <div>
                  <Label>Expected Output</Label>
                  <Input
                    value={test.expected || ''}
                    onChange={(e) => updateTest(test.id, { expected: e.target.value })}
                    placeholder="Expected output..."
                  />
                </div>

                <div className="border-t pt-3 space-y-3">
                  <div className="flex items-center space-x-2">
                    <Switch
                      id={`strict-${test.id}`}
                      checked={test.grading?.strictZeroOnDeviation || false}
                      onCheckedChange={(checked) =>
                        updateTest(test.id, {
                          grading: {
                            ...test.grading,
                            strictZeroOnDeviation: checked,
                          },
                        })
                      }
                    />
                    <Label htmlFor={`strict-${test.id}`} className="text-sm">
                      Strict Mode (0 or 10 only)
                    </Label>
                  </div>

                  {!test.grading?.strictZeroOnDeviation && (
                    <div>
                      <Label className="text-sm">Distance Metric</Label>
                      <select
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={test.grading?.distanceMetric || 'levenshtein'}
                        onChange={(e) =>
                          updateTest(test.id, {
                            grading: {
                              ...test.grading,
                              distanceMetric: e.target.value as any,
                            },
                          })
                        }
                      >
                        <option value="levenshtein">Levenshtein (text similarity)</option>
                        <option value="json_diff">JSON Diff (structure similarity)</option>
                        <option value="numeric_abs">Numeric Absolute (number closeness)</option>
                      </select>
                      <div className="text-xs text-muted-foreground mt-1">
                        Score 0-10 based on similarity. Pass threshold: ≥7
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Variations Tab
function VariationsTab({ config, setConfig }: TabProps) {
  // Calculate normalized shares for display (all shares are normalized to 100%)
  const mutationShare = config.operators?.mutationShare || 0;
  const crossoverShare = config.operators?.crossoverShare || 0;
  const metaShare = config.operators?.metaPrompting?.enabled ? (config.operators.metaPrompting.share || 0) : 0;
  const modelShare = config.operators?.modelVariation?.enabled ? (config.operators.modelVariation.share || 0) : 0;
  const paramShare = config.operators?.paramVariation?.enabled ? (config.operators.paramVariation.share || 0) : 0;
  
  const totalShare = mutationShare + crossoverShare + metaShare + modelShare + paramShare;
  
  // Normalize to percentages (shares are automatically scaled to sum to 100%)
  const normalizedMutation = totalShare > 0 ? (mutationShare / totalShare) * 100 : 0;
  const normalizedCrossover = totalShare > 0 ? (crossoverShare / totalShare) * 100 : 0;
  const normalizedMeta = totalShare > 0 ? (metaShare / totalShare) * 100 : 0;
  const normalizedModel = totalShare > 0 ? (modelShare / totalShare) * 100 : 0;
  const normalizedParam = totalShare > 0 ? (paramShare / totalShare) * 100 : 0;

  return (
    <div className="space-y-6">
      {/* Normalized Shares Display */}
      <div className="p-4 border rounded-lg bg-muted/30">
        <h3 className="text-sm font-semibold mb-3">Operator Distribution (Normalized to 100%)</h3>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span>Mutation:</span>
            <span className="font-mono">{normalizedMutation.toFixed(1)}%</span>
          </div>
          <div className="flex justify-between">
            <span>Crossover:</span>
            <span className="font-mono">{normalizedCrossover.toFixed(1)}%</span>
          </div>
          <div className="flex justify-between">
            <span>Meta-prompting:</span>
            <span className="font-mono">{normalizedMeta.toFixed(1)}%</span>
          </div>
          <div className="flex justify-between">
            <span>Model Variation:</span>
            <span className="font-mono">{normalizedModel.toFixed(1)}%</span>
          </div>
          <div className="flex justify-between">
            <span>Parameter Variation:</span>
            <span className="font-mono">{normalizedParam.toFixed(1)}%</span>
          </div>
        </div>
        <div className="text-xs text-muted-foreground mt-3">
          All operator shares are normalized to create exactly N children per generation.
          {totalShare === 0 && ' (Warning: All shares are 0 - no genetic operators will be applied)'}
        </div>
      </div>

      {/* Mutation Share */}
      <div>
        <LabelWithTooltip 
          htmlFor="mutationShare" 
          label="Mutation Share (0-1)"
          tooltip="Fraction of children created via random mutations. Mutations apply small, precise edits to prompts to explore variations."
        />
        <Input
          id="mutationShare"
          type="number"
          step="0.05"
          min="0"
          max="1"
          value={config.operators?.mutationShare || 0}
          onChange={(e) =>
            setConfig({
              ...config,
              operators: {
                ...config.operators!,
                mutationShare: parseFloat(e.target.value) || 0,
              },
            })
          }
          placeholder="0.4"
        />
        <div className="text-xs text-muted-foreground mt-1">
          Fraction of children created via random mutations
        </div>
      </div>

      {/* Crossover Share */}
      <div>
        <LabelWithTooltip 
          htmlFor="crossoverShare" 
          label="Crossover Share (0-1)"
          tooltip="Fraction of children created by merging two parent prompts. Crossover combines the best parts of successful prompts."
        />
        <Input
          id="crossoverShare"
          type="number"
          step="0.05"
          min="0"
          max="1"
          value={config.operators?.crossoverShare || 0}
          onChange={(e) =>
            setConfig({
              ...config,
              operators: {
                ...config.operators!,
                crossoverShare: parseFloat(e.target.value) || 0,
              },
            })
          }
          placeholder="0.3"
        />
        <div className="text-xs text-muted-foreground mt-1">
          Fraction of children created by combining two parents
        </div>
      </div>

      {/* Meta-prompting */}
      <div className="space-y-3">
        <div className="flex items-center space-x-2">
          <Switch
            id="metaPrompting"
            checked={config.operators?.metaPrompting?.enabled || false}
            onCheckedChange={(checked) =>
              setConfig({
                ...config,
                operators: {
                  ...config.operators!,
                  metaPrompting: checked
                    ? { enabled: true, share: config.operators?.metaPrompting?.share || 0.1 }
                    : { enabled: false, share: 0 },
                },
              })
            }
          />
          <LabelWithTooltip 
            htmlFor="metaPrompting" 
            label="Meta-Prompting"
            tooltip="Uses LLM to analyze test failures and suggest targeted edits to fix them. When no failures exist, suggests general refinements for clarity, precision, and edge case handling."
          />
        </div>
        {config.operators?.metaPrompting?.enabled && (
          <div>
            <Label htmlFor="metaShare">Meta-Prompting Share (0-1)</Label>
            <Input
              id="metaShare"
              type="number"
              step="0.05"
              min="0"
              max="1"
              value={config.operators?.metaPrompting?.share || 0}
              onChange={(e) =>
                setConfig({
                  ...config,
                  operators: {
                    ...config.operators!,
                    metaPrompting: {
                      enabled: true,
                      share: parseFloat(e.target.value) || 0,
                    },
                  },
                })
              }
              placeholder="0.1"
            />
            <div className="text-xs text-muted-foreground mt-1">
              Fraction of children created via LLM-driven prompt refinement based on test failures
            </div>
          </div>
        )}
      </div>

      {/* Model Variation */}
      <div className="space-y-3">
        <div className="flex items-center space-x-2">
          <Switch
            id="modelVariation"
            checked={config.operators?.modelVariation?.enabled || false}
            onCheckedChange={(checked) =>
              setConfig({
                ...config,
                operators: {
                  ...config.operators!,
                  modelVariation: checked
                    ? { enabled: true, share: config.operators?.modelVariation?.share || 0.2 }
                    : { enabled: false, share: 0 },
                },
              })
            }
          />
          <Label htmlFor="modelVariation">Model Variation</Label>
        </div>
        {config.operators?.modelVariation?.enabled && (
          <div>
            <Label htmlFor="modelShare">Model Variation Share (0-1)</Label>
            <Input
              id="modelShare"
              type="number"
              step="0.05"
              min="0"
              max="1"
              value={config.operators?.modelVariation?.share || 0}
              onChange={(e) =>
                setConfig({
                  ...config,
                  operators: {
                    ...config.operators!,
                    modelVariation: {
                      enabled: true,
                      share: parseFloat(e.target.value) || 0,
                    },
                  },
                })
              }
              placeholder="0.2"
            />
            <div className="text-xs text-muted-foreground mt-1">
              Fraction of children with randomly selected models (explores different model capabilities)
            </div>
          </div>
        )}
      </div>

      {/* Parameter Variation Section */}
      <div className="p-4 border rounded-lg space-y-4">
        <div className="flex items-center gap-1.5 mb-2">
          <h3 className="text-sm font-semibold">Parameter Variation</h3>
          <Tooltip>
            <TooltipTrigger asChild>
              <HelpCircle className="h-3.5 w-3.5 text-muted-foreground cursor-help flex-shrink-0" />
            </TooltipTrigger>
            <TooltipContent className="max-w-md">
              <p>Varies LLM parameters (like temperature) to explore different model behaviors while keeping the prompt unchanged. Helps find optimal generation settings.</p>
            </TooltipContent>
          </Tooltip>
        </div>
        
        <div className="flex items-center space-x-2">
          <Switch
            id="paramVariation"
            checked={config.operators?.paramVariation?.enabled || false}
            onCheckedChange={(checked) =>
              setConfig({
                ...config,
                operators: {
                  ...config.operators!,
                  paramVariation: checked
                    ? {
                        enabled: true,
                        share: config.operators?.paramVariation?.share || 0.2,
                        temperature: config.operators?.paramVariation?.temperature || { enabled: false, min: 0.5, max: 1.5 },
                      }
                    : {
                        enabled: false,
                        share: 0,
                        temperature: { enabled: false, min: 0.5, max: 1.5 },
                      },
                },
              })
            }
          />
          <Label htmlFor="paramVariation">Enable Parameter Variation</Label>
        </div>

        {config.operators?.paramVariation?.enabled && (
          <>
            <div>
              <Label htmlFor="paramShare">Parameter Variation Share (0-1)</Label>
              <Input
                id="paramShare"
                type="number"
                step="0.05"
                min="0"
                max="1"
                value={config.operators?.paramVariation?.share || 0}
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
                placeholder="0.2"
              />
              <div className="text-xs text-muted-foreground mt-1">
                Overall fraction of children with varied execution parameters
              </div>
            </div>

            {/* Temperature Variation */}
            <div className="pl-4 border-l-2 space-y-3">
              <div className="flex items-center space-x-2">
                <Switch
                  id="tempVariation"
                  checked={config.operators?.paramVariation?.temperature?.enabled || false}
                  onCheckedChange={(checked) =>
                    setConfig({
                      ...config,
                      operators: {
                        ...config.operators!,
                        paramVariation: {
                          ...config.operators!.paramVariation!,
                          temperature: checked
                            ? {
                                enabled: true,
                                min: config.operators?.paramVariation?.temperature?.min || 0.5,
                                max: config.operators?.paramVariation?.temperature?.max || 1.5,
                              }
                            : { enabled: false, min: 0.5, max: 1.5 },
                        },
                      },
                    })
                  }
                />
                <Label htmlFor="tempVariation">Temperature Variation</Label>
              </div>

              {config.operators?.paramVariation?.temperature?.enabled && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="tempMin">Min Temperature</Label>
                    <Input
                      id="tempMin"
                      type="number"
                      step="0.1"
                      min="0"
                      max="2"
                      value={config.operators?.paramVariation?.temperature?.min || 0.5}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          operators: {
                            ...config.operators!,
                            paramVariation: {
                              ...config.operators!.paramVariation!,
                              temperature: {
                                enabled: true,
                                min: parseFloat(e.target.value) || 0.5,
                                max: config.operators!.paramVariation!.temperature!.max,
                              },
                            },
                          },
                        })
                      }
                    />
                  </div>
                  <div>
                    <Label htmlFor="tempMax">Max Temperature</Label>
                    <Input
                      id="tempMax"
                      type="number"
                      step="0.1"
                      min="0"
                      max="2"
                      value={config.operators?.paramVariation?.temperature?.max || 1.5}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          operators: {
                            ...config.operators!,
                            paramVariation: {
                              ...config.operators!.paramVariation!,
                              temperature: {
                                enabled: true,
                                min: config.operators!.paramVariation!.temperature!.min,
                                max: parseFloat(e.target.value) || 1.5,
                              },
                            },
                          },
                        })
                      }
                    />
                  </div>
                </div>
              )}
            </div>
          </>
        )}
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
      <LabelWithTooltip 
        htmlFor="fitness-section" 
        label="Configure fitness function weights (will be auto-normalized)"
        tooltip="Fitness function evaluates candidate prompts. Weights determine importance of each metric (Quality, Safety, Cost, Latency, Stability). All weights are normalized to sum to 1.0, so relative ratios matter. Higher weight = more influence on selection."
      />

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
          <>
            <Input
              type="number"
              step="0.1"
              value={weights.cost || 0}
              onChange={(e) => setWeight('cost', parseFloat(e.target.value) || 0)}
              className="w-24"
            />
            <select
              className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm"
              value={config.fitness?.costNorm?.mode || 'absolute'}
              onChange={(e) => {
                setConfig({
                  ...config,
                  fitness: {
                    ...config.fitness!,
                    costNorm: {
                      mode: e.target.value as 'absolute' | 'relative',
                      maxUSDPerCall: config.fitness?.costNorm?.maxUSDPerCall || 0.1,
                    },
                  },
                });
              }}
            >
              <option value="absolute">Absolute</option>
              <option value="relative">Relative</option>
            </select>
            {config.fitness?.costNorm?.mode === 'absolute' && (
              <>
                <Label htmlFor="cost-norm-max" className="text-xs text-muted-foreground whitespace-nowrap">
                  Max $
                </Label>
                <Input
                  id="cost-norm-max"
                  type="number"
                  step="0.01"
                  min="0.001"
                  value={config.fitness?.costNorm?.maxUSDPerCall || 0.1}
                  onChange={(e) => {
                    setConfig({
                      ...config,
                      fitness: {
                        ...config.fitness!,
                        costNorm: {
                          mode: config.fitness?.costNorm?.mode || 'absolute',
                          maxUSDPerCall: parseFloat(e.target.value) || 0.1,
                        },
                      },
                    });
                  }}
                  className="w-24"
                  placeholder="0.1"
                />
              </>
            )}
          </>
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
          <>
            <Input
              type="number"
              step="0.1"
              value={weights.latency || 0}
              onChange={(e) => setWeight('latency', parseFloat(e.target.value) || 0)}
              className="w-24"
            />
            <select
              className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm"
              value={config.fitness?.latencyNorm?.mode || 'absolute'}
              onChange={(e) => {
                setConfig({
                  ...config,
                  fitness: {
                    ...config.fitness!,
                    latencyNorm: {
                      mode: e.target.value as 'absolute' | 'relative',
                      maxMs: config.fitness?.latencyNorm?.maxMs || 30000,
                    },
                  },
                });
              }}
            >
              <option value="absolute">Absolute</option>
              <option value="relative">Relative</option>
            </select>
            {config.fitness?.latencyNorm?.mode === 'absolute' && (
              <>
                <Label htmlFor="latency-norm-max" className="text-xs text-muted-foreground whitespace-nowrap">
                  Max ms
                </Label>
                <Input
                  id="latency-norm-max"
                  type="number"
                  step="1000"
                  min="100"
                  value={config.fitness?.latencyNorm?.maxMs || 30000}
                  onChange={(e) => {
                    setConfig({
                      ...config,
                      fitness: {
                        ...config.fitness!,
                        latencyNorm: {
                          mode: config.fitness?.latencyNorm?.mode || 'absolute',
                          maxMs: parseFloat(e.target.value) || 30000,
                        },
                      },
                    });
                  }}
                  className="w-32"
                  placeholder="30000"
                />
              </>
            )}
          </>
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
  const hasTimeLimit = (config.targets?.timeLimitMs || 0) > 0;
  const hasBudgetLimit = (config.targets?.budgetUSD || 0) > 0;
  const hasTargetFitness = (config.targets?.targetFitness || 0) > 0;
  const hasMaxGenerations = (config.targets?.maxGenerations || 0) > 0;

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">
        Set stopping conditions (at least one required). Evaluation stops when ANY condition is met.
      </div>

      <div className="flex items-center space-x-2">
        <Switch
          id="time-enabled"
          checked={hasTimeLimit}
          onCheckedChange={(checked) => {
            setConfig({
              ...config,
              targets: {
                ...config.targets!,
                timeLimitMs: checked ? 3600000 : undefined, // Default 1 hour
              },
            });
          }}
        />
        <Label htmlFor="time-enabled">Time Limit</Label>
        {hasTimeLimit && (
          <div className="flex items-center gap-2">
            <Input
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
              placeholder="60"
              className="w-24"
            />
            <span className="text-sm text-muted-foreground">minutes</span>
          </div>
        )}
      </div>

      <div className="flex items-center space-x-2">
        <Switch
          id="budget-enabled"
          checked={hasBudgetLimit}
          onCheckedChange={(checked) => {
            setConfig({
              ...config,
              targets: {
                ...config.targets!,
                budgetUSD: checked ? 10 : undefined, // Default $10
              },
            });
          }}
        />
        <Label htmlFor="budget-enabled">Budget Limit</Label>
        {hasBudgetLimit && (
          <div className="flex items-center gap-2">
            <span className="text-sm">$</span>
            <Input
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
              placeholder="10"
              className="w-24"
            />
            <span className="text-sm text-muted-foreground">USD</span>
          </div>
        )}
      </div>

      <div className="flex items-center space-x-2">
        <Switch
          id="fitness-enabled"
          checked={hasTargetFitness}
          onCheckedChange={(checked) => {
            setConfig({
              ...config,
              targets: {
                ...config.targets!,
                targetFitness: checked ? 9.0 : undefined, // Default 9.0
              },
            });
          }}
        />
        <Label htmlFor="fitness-enabled">Target Fitness Score</Label>
        {hasTargetFitness && (
          <div className="flex items-center gap-2">
            <Input
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
              placeholder="9.0"
              className="w-24"
            />
            <span className="text-sm text-muted-foreground">(0-10)</span>
          </div>
        )}
      </div>

      <div className="flex items-center space-x-2">
        <Switch
          id="generations-enabled"
          checked={hasMaxGenerations}
          onCheckedChange={(checked) => {
            setConfig({
              ...config,
              targets: {
                ...config.targets!,
                maxGenerations: checked ? 10 : undefined, // Default 10 generations
              },
            });
          }}
        />
        <Label htmlFor="generations-enabled">Max Generations</Label>
        {hasMaxGenerations && (
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min="1"
              value={config.targets?.maxGenerations || ''}
              onChange={(e) =>
                setConfig({
                  ...config,
                  targets: {
                    ...config.targets!,
                    maxGenerations: parseInt(e.target.value) || undefined,
                  },
                })
              }
              placeholder="10"
              className="w-24"
            />
            <span className="text-sm text-muted-foreground">generations</span>
          </div>
        )}
      </div>

      {!hasTimeLimit && !hasBudgetLimit && !hasTargetFitness && !hasMaxGenerations && (
        <div className="text-sm text-yellow-600 bg-yellow-50 p-3 rounded-md">
          ⚠ At least one stopping condition must be enabled
        </div>
      )}
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
        <LabelWithTooltip 
          htmlFor="parallelLimit" 
          label="Parallel Execution Limit"
          tooltip="Maximum number of LLM API calls to run concurrently. Higher values speed up evaluation but may hit API rate limits."
        />
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

      <div className="space-y-2">
        <Label htmlFor="serviceModel">Service Model (for mutations/crossover/grading)</Label>
        <select
          id="serviceModel"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={config.serviceModel ? `${config.serviceModel.provider}:${config.serviceModel.model}` : ''}
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

