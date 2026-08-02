import { useState, useEffect, type Dispatch, type SetStateAction } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { LabelWithTooltip } from './LabelWithTooltip';
import { HelpCircle, ArrowUpDown } from 'lucide-react';
import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';
import type { EvaluationConfig, TestCase, ModelRef, ModelCostEntry } from '../types';
import { nextPopulationRange, adaptiveRangeHint } from '@/utils/adaptiveRange';
import { crossoverModeHint } from '@/utils/crossoverMode';

type SortColumn = 'provider' | 'model' | 'prompt' | 'completion';
type SortDirection = 'asc' | 'desc';

interface NewEvaluationModalProps {
  onClose: () => void;
  onCreated: (evalId: string) => void;
  initialConfig?: Partial<EvaluationConfig> | null;
}

export function NewEvaluationModal({ onClose, onCreated, initialConfig }: NewEvaluationModalProps) {
  // Load settings synchronously from cache or fetch (blocks until ready)
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => window.electronAPI.settings.get(),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });
  
  // Don't render modal until settings are loaded
  if (isLoading || !settings) {
    return null;
  }
  
  return <NewEvaluationModalContent 
    onClose={onClose} 
    onCreated={onCreated} 
    initialConfig={initialConfig}
    settings={settings}
  />;
}

function NewEvaluationModalContent({ 
  onClose, 
  onCreated, 
  initialConfig,
  settings 
}: NewEvaluationModalProps & { settings: any }) {
  const [activeTab, setActiveTab] = useState('main');
  const [isSimpleMode, setIsSimpleMode] = useState(true);
  
  // Generate new ID each time modal is opened to avoid conflicts
  const [configId] = useState(() => uuidv4());
  
  // Initialize config once with settings already loaded
  const [config, setConfig] = useState<Partial<EvaluationConfig>>(() => {
    const defaultConfig: Partial<EvaluationConfig> = {
      id: configId,
      name: 'New Evaluation',
      selection: {
        policy: 'topk',
        topK: 4,
        eliteShare: 0.05,
        diversity: 0,
        novelty: 0,
        restartAfter: 0,
      },
      operators: {
        adaptivity: 0,
        mutationShare: 0.4,
        crossoverShare: 0.3,
        metaPrompting: {
          enabled: true,
          share: 0.2,
        },
        modelVariation: {
          enabled: true,
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
        costNorm: { mode: 'relative', maxUSDPerCall: 0.1 },
        latencyNorm: { mode: 'relative', maxMs: 30000 },
      },
      targets: {
        timeLimitMs: 3600000, // 1 hour
        budgetUSD: 10,
        targetFitness: undefined, // Disabled by default
        maxGenerations: 3,
      },
      serviceModel: settings?.serviceModel,
      parallelLimit: settings?.globalParallelLimit || 5,
      serviceModelMaxTokens: settings?.serviceModelMaxTokens || 20000,
      retries: settings?.retries ?? 3,
    };

    // Merge with initialConfig if provided
    if (initialConfig) {
      return {
        ...defaultConfig,
        ...initialConfig,
        id: configId, // Always use new ID
        // Deep merge nested objects
        selection: { ...defaultConfig.selection, ...initialConfig.selection },
        operators: {
          ...defaultConfig.operators,
          ...initialConfig.operators,
          metaPrompting: { ...defaultConfig.operators?.metaPrompting, ...initialConfig.operators?.metaPrompting },
          modelVariation: { ...defaultConfig.operators?.modelVariation, ...initialConfig.operators?.modelVariation },
          paramVariation: {
            ...defaultConfig.operators?.paramVariation,
            ...initialConfig.operators?.paramVariation,
            temperature: { ...defaultConfig.operators?.paramVariation?.temperature, ...initialConfig.operators?.paramVariation?.temperature },
          },
        },
        population: { ...defaultConfig.population, ...initialConfig.population },
        fitness: {
          ...defaultConfig.fitness,
          ...initialConfig.fitness,
          weights: { ...defaultConfig.fitness?.weights, ...initialConfig.fitness?.weights },
          costNorm: { ...defaultConfig.fitness?.costNorm, ...initialConfig.fitness?.costNorm },
          latencyNorm: { ...defaultConfig.fitness?.latencyNorm, ...initialConfig.fitness?.latencyNorm },
        },
        targets: { ...defaultConfig.targets, ...initialConfig.targets },
      } as Partial<EvaluationConfig>;
    }
    return defaultConfig;
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const estimate = useCostEstimate(config);

  // Ensure topK doesn't exceed generationSize in simple mode
  useEffect(() => {
    if (isSimpleMode && config.selection?.policy === 'topk') {
      const generationSize = config.population?.generationSize || 10;
      const currentTopK = config.selection?.topK || 4;
      const maxTopK = Math.min(4, generationSize);
      
      // Only update if topK actually exceeds the limit
      if (currentTopK > maxTopK) {
        setConfig(prev => ({
          ...prev,
          selection: {
            ...prev.selection!,
            topK: maxTopK,
          },
        }));
      }
    }
  }, [isSimpleMode, config.population?.generationSize, config.selection?.policy, config.selection?.topK]);

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

  /** Returns the errors it found, so the caller does not have to read stale state. */
  const validate = (): Record<string, string> => {
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
    } else {
      // Per-test checks. Without these the run started, paid in full, and
      // scored 0 for every candidate in every generation — silently, because
      // the scorers return 0 with a detail string rather than failing loudly.
      // That is a run with no gradient at all.
      const seenIds = new Set<string>();
      for (const [i, test] of config.testSet.entries()) {
        const label = test.name?.trim() || `Test ${i + 1}`;
        if (!test.prompt?.trim()) {
          newErrors.testset = `${label} has no input prompt`;
          break;
        }
        if (test.id && seenIds.has(test.id)) {
          newErrors.testset = `${label} reuses another test's id — ids must be unique`;
          break;
        }
        if (test.id) seenIds.add(test.id);
        if (test.mode === 'json_schema' && !test.schema) {
          newErrors.testset = `${label} uses JSON Schema mode but has no schema — every candidate would score 0`;
          break;
        }
        if (test.mode === 'tool_call' && !test.expectedTool?.name) {
          newErrors.testset = `${label} uses tool-call mode but no expected tool is set — every candidate would score 0`;
          break;
        }
        if (test.mode === 'exact_match' && !test.expected) {
          newErrors.testset = `${label} uses exact-match mode but has no expected output — every candidate would score 0`;
          break;
        }
      }
    }
    if (!config.targets?.timeLimitMs && !config.targets?.budgetUSD && !config.targets?.targetFitness && !config.targets?.maxGenerations) {
      newErrors.targets = 'At least one target must be set';
    }

    // A population of 0 or 1 cannot evolve, and all-zero fitness weights make
    // every candidate score identically — the run costs full price and ranks
    // nothing.
    const popSize = config.population?.initialSize;
    if (popSize !== undefined && (!Number.isInteger(popSize) || popSize < 2)) {
      newErrors.population = 'Population size must be at least 2 for evolution to have anything to select between';
    }
    const weights = config.fitness?.weights;
    if (weights && !Object.values(weights).some(w => typeof w === 'number' && w > 0)) {
      newErrors.fitness = 'At least one fitness weight must be greater than 0, or every candidate scores the same';
    }

    setErrors(newErrors);
    return newErrors;
  };

  const handleStart = () => {
    console.log('[NewEval] Start button clicked');
    // Report the errors validate() JUST computed, not the `errors` state.
    // setErrors does not update the render-scope const synchronously, so the
    // alert always showed the PREVIOUS click's errors — and on the first failed
    // click it showed an empty list under "Please fix the errors".
    const found = validate();
    const messages = Object.entries(found);
    if (messages.length === 0) {
      console.log('[NewEval] Starting evaluation...');
      createEvaluation.mutate(config as EvaluationConfig);
    } else {
      console.error('[NewEval] Validation failed:', found);
      alert('Please fix the errors highlighted in red tabs:\n\n' + messages.map(([k, v]) => `• ${k}: ${v}`).join('\n'));
    }
  };

  return (
    <TooltipProvider>
      <Dialog open onOpenChange={(open) => !open && onClose()} modal>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <div className="flex items-center justify-between pr-8">
            <DialogTitle>New Evaluation</DialogTitle>
            <div className="flex items-center gap-2 text-sm">
              <span className={isSimpleMode ? 'font-medium' : 'text-muted-foreground'}>Simple</span>
              <Switch
                checked={!isSimpleMode}
                onCheckedChange={(checked) => setIsSimpleMode(!checked)}
              />
              <span className={!isSimpleMode ? 'font-medium' : 'text-muted-foreground'}>Advanced</span>
            </div>
          </div>
          <DialogDescription>
            Configure and start a new prompt evolution evaluation
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
          <TabsList className={`grid w-full ${isSimpleMode ? 'grid-cols-6' : 'grid-cols-8'}`}>
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
            {!isSimpleMode && (
              <TabsTrigger value="variations">Variations</TabsTrigger>
            )}
            <TabsTrigger value="fitness">Fitness</TabsTrigger>
            <TabsTrigger value="targets" className={errors.targets ? 'text-red-500' : ''}>
              Targets
            </TabsTrigger>
            {!isSimpleMode && (
              <TabsTrigger value="advanced">Service</TabsTrigger>
            )}
          </TabsList>

          <div 
            className="p-4 h-[500px] min-h-0"
            style={{
              overflowY: 'scroll',
              scrollbarGutter: 'stable',
              willChange: 'auto',
              transform: 'translateZ(0)',
              imageRendering: 'crisp-edges',
              WebkitFontSmoothing: 'subpixel-antialiased'
            } as React.CSSProperties}
          >
            <TabsContent value="main" className="space-y-4 mt-0">
              <MainTab config={config} setConfig={setConfig} isSimpleMode={isSimpleMode} />
            </TabsContent>

            <TabsContent value="population" className="space-y-4 mt-0">
              <PopulationTab config={config} setConfig={setConfig} isSimpleMode={isSimpleMode} />
            </TabsContent>

            <TabsContent value="models" className="space-y-4 mt-0">
              <ModelsTab config={config} setConfig={setConfig} />
            </TabsContent>

            <TabsContent value="testset" className="space-y-4 mt-0">
              <TestSetTab config={config} setConfig={setConfig} isSimpleMode={isSimpleMode} />
            </TabsContent>

            {!isSimpleMode && (
              <TabsContent value="variations" className="space-y-4 mt-0">
                <VariationsTab config={config} setConfig={setConfig} />
              </TabsContent>
            )}

            <TabsContent value="fitness" className="space-y-4 mt-0">
              <FitnessTab config={config} setConfig={setConfig} />
            </TabsContent>

            <TabsContent value="targets" className="space-y-4 mt-0">
              <TargetsTab config={config} setConfig={setConfig} />
            </TabsContent>

            {!isSimpleMode && (
              <TabsContent value="advanced" className="space-y-4 mt-0">
                <AdvancedTab config={config} setConfig={setConfig} />
              </TabsContent>
            )}
          </div>
        </Tabs>

        <div className="flex justify-between items-center border-t pt-4">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {estimate && 'error' in estimate && (
            // A bare null rendered nothing at all, indistinguishable from "no
            // estimate applies to this config". Say why instead.
            <span className="text-xs text-amber-500 px-2 text-center" title={String((estimate as any).error)}>
              Cost estimate unavailable
            </span>
          )}
          {estimate && !('error' in estimate) && (
            <span
              className="text-xs text-muted-foreground px-2 text-center"
              title={estimate.warnings?.join('\n')}
            >
              ≈ ${estimate.low.toFixed(4)} – ${estimate.high.toFixed(4)} · ~{estimate.calls} calls{estimate.perGeneration ? ' /gen' : ''}
              {/* The warnings — including the worst-case ceiling if every reply
                  runs to serviceModelMaxTokens — lived only in a title= tooltip,
                  so the number a user actually budgets against was the one they
                  never saw. */}
              {estimate.warnings?.length > 0 && (
                <span className="block text-amber-500">{estimate.warnings[0]}</span>
              )}
            </span>
          )}
          {/* Disabled while pending: eval:create awaits a DB insert AND a full
              cost estimate before the modal closes — a second click in that
              window minted a second run and started two evolutions in parallel. */}
          <Button onClick={handleStart} disabled={createEvaluation.isPending}>
            {createEvaluation.isPending ? 'Starting…' : 'Start Evaluation'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
    </TooltipProvider>
  );
}

// Main Tab
function MainTab({ config, setConfig, isSimpleMode }: TabProps) {
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

      {!isSimpleMode && (
        <>
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
            onChange={(e) => {
              const value = e.target.value;
              if (value === '') return;
              const num = parseInt(value);
              if (!isNaN(num) && num > 0) {
                setConfig({
                  ...config,
                  selection: {
                    ...config.selection!,
                    topK: num,
                  },
                });
              }
            }}
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

          <div>
            <LabelWithTooltip
              htmlFor="diversity"
              label="Diversity (0-1)"
              tooltip="Discounts a parent's fitness for resembling parents already chosen, so a converging population doesn't spend every slot on near-copies of one prompt. The best candidate is always picked first, so this never costs you the champion. 0 = off (rank by fitness alone)."
            />
            <Input
              id="diversity"
              type="number"
              min="0"
              max="1"
              step="0.1"
              value={config.selection?.diversity ?? 0}
              onChange={(e) =>
                setConfig({
                  ...config,
                  selection: {
                    ...config.selection!,
                    diversity: parseFloat(e.target.value) || 0,
                  },
                })
              }
              placeholder="0"
            />
            <div className="text-xs text-muted-foreground mt-1">
              {config.selection?.diversity && config.selection.diversity > 0
                ? `A near-duplicate must be ~${(1 / Math.max(0.01, 1 - config.selection.diversity)).toFixed(1)}x better than a distinct rival to keep its parent slot`
                : 'Off — parents are ranked by fitness alone. Raise this if generations start looking alike'
              }
            </div>
          </div>

          <div>
            <LabelWithTooltip
              htmlFor="novelty"
              label="Novelty (0-1)"
              tooltip="Discounts a parent for resembling prompts the run has ALREADY evaluated in earlier generations. Diversity only compares against this generation, so it cannot see a prompt being rediscovered on a loop; novelty remembers the whole run. Composes with diversity. 0 = off."
            />
            <Input
              id="novelty"
              type="number"
              min="0"
              max="1"
              step="0.1"
              value={(config.selection as any)?.novelty ?? 0}
              onChange={(e) =>
                setConfig({
                  ...config,
                  selection: { ...config.selection!, novelty: parseFloat(e.target.value) || 0 } as any,
                })
              }
              placeholder="0"
            />
            <div className="text-xs text-muted-foreground mt-1">
              {(config.selection as any)?.novelty > 0
                ? 'Prompts resembling ones already tried this run are ranked lower, so the search keeps moving'
                : 'Off — a prompt already explored in an earlier generation competes on fitness alone'}
            </div>
          </div>

          <div>
            <LabelWithTooltip
              htmlFor="restartAfter"
              label="Restart After (generations)"
              tooltip="If the best fitness has not improved for this many generations, reseed a quarter of the next generation from the original prompt to look somewhere else. The champion is carried by elitism regardless, so this can only cost exploration budget. Blank or 0 = off."
            />
            <Input
              id="restartAfter"
              type="number"
              min="0"
              step="1"
              value={(config.selection as any)?.restartAfter ?? 0}
              onChange={(e) =>
                setConfig({
                  ...config,
                  selection: {
                    ...config.selection!,
                    restartAfter: parseInt(e.target.value, 10) || 0,
                  } as any,
                })
              }
              placeholder="0"
            />
            <div className="text-xs text-muted-foreground mt-1">
              {(config.selection as any)?.restartAfter > 0
                ? `After ${(config.selection as any).restartAfter} generation(s) with no improvement, fresh candidates are injected from the seed prompt`
                : 'Off — a run that stops improving keeps breeding from the same converged population'}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One field of the adaptive-size range changed. The reducer lives in
 * `@/utils/adaptiveRange` so the half-typed cases are testable without a DOM.
 */
function setAdaptiveRange(
  config: any,
  setConfig: (c: any) => void,
  field: 'min' | 'max',
  raw: string,
) {
  const populationRange = nextPopulationRange((config.population as any)?.populationRange, field, raw);
  const population = { ...config.population! } as any;
  if (populationRange === undefined) delete population.populationRange;
  else population.populationRange = populationRange;
  setConfig({ ...config, population });
}

// Population Tab
function PopulationTab({ config, setConfig, isSimpleMode }: TabProps) {
  const { data: costs = [] } = useQuery<ModelCostEntry[]>({
    queryKey: ['costs'],
    queryFn: () => window.electronAPI.costs.getAll(),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
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
      {isSimpleMode ? (
        <div>
          <LabelWithTooltip 
            htmlFor="populationSize" 
            label="Population Size"
            tooltip="Number of candidate prompts in each generation. Higher values explore more variations but take longer to evaluate."
          />
          <Input
            id="populationSize"
            type="number"
            min="1"
            value={config.population?.generationSize || 10}
            onChange={(e) => {
              const value = e.target.value;
              if (value === '') return;
              const size = parseInt(value);
              if (!isNaN(size) && size > 0) {
                setConfig({
                  ...config,
                  population: {
                    ...config.population!,
                    initialSize: size,
                    generationSize: size,
                  },
                });
              }
            }}
          />
          <div className="text-xs text-muted-foreground mt-1">
            Number of candidates per generation
          </div>
        </div>
      ) : (
        <>
          <div>
            <LabelWithTooltip 
              htmlFor="initialSize" 
              label="Initial Population Size (Generation 0)"
              tooltip="Number of candidates in the first generation. Use a larger value for broader initial exploration or a smaller value for faster startup."
            />
            {/* min matches validate(): a population of 1 cannot evolve */}
            <Input
              id="initialSize"
              type="number"
              min="2"
              value={config.population?.initialSize || 10}
              onChange={(e) => {
                const value = e.target.value;
                if (value === '') return;
                const size = parseInt(value);
                if (!isNaN(size) && size >= 2) {
                  setConfig({
                    ...config,
                    population: {
                      ...config.population!,
                      initialSize: size,
                    },
                  });
                }
              }}
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
              onChange={(e) => {
                const value = e.target.value;
                if (value === '') return;
                const size = parseInt(value);
                if (!isNaN(size) && size > 0) {
                  setConfig({
                    ...config,
                    population: {
                      ...config.population!,
                      generationSize: size,
                    },
                  });
                }
              }}
            />
            <div className="text-xs text-muted-foreground mt-1">
              Number of candidates in each subsequent generation
            </div>
          </div>

          <div>
            <LabelWithTooltip
              htmlFor="adaptiveSize"
              label="Adaptive Size Range (min–max)"
              tooltip="Let the engine widen each generation while the run is still improving and narrow it once progress flattens, instead of spending the same amount per generation either way. Max is a hard ceiling — a generation never exceeds it, and the cost estimate quotes that widest case. Blank = off, generation size stays fixed."
            />
            <div className="flex items-center gap-2">
              <Input
                id="adaptiveSize"
                type="number"
                min="2"
                step="1"
                placeholder="off"
                value={(config.population as any)?.populationRange?.min ?? ''}
                onChange={(e) => setAdaptiveRange(config, setConfig, 'min', e.target.value)}
              />
              <span className="text-muted-foreground text-sm">to</span>
              <Input
                id="adaptiveSizeMax"
                type="number"
                min="2"
                step="1"
                placeholder="off"
                value={(config.population as any)?.populationRange?.max ?? ''}
                onChange={(e) => setAdaptiveRange(config, setConfig, 'max', e.target.value)}
              />
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {adaptiveRangeHint(
                (config.population as any)?.populationRange,
                config.population?.generationSize || 10,
              )}
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
        </>
      )}

      {!isManualMode ? (
        <div>
          <Label htmlFor="seedPrompt">Seed Prompt</Label>
          {isSimpleMode && (
            <div className="text-xs text-muted-foreground mb-2">
              The initial population will be generated by mutating this seed prompt
            </div>
          )}
          <textarea
            id="seedPrompt"
            className="w-full h-32 rounded-md border border-input bg-background px-3 py-2 text-sm"
            style={{
              resize: 'vertical',
              scrollbarGutter: 'stable'
            }}
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
                  style={{ scrollbarGutter: 'stable' }}
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
  const [sortColumn, setSortColumn] = useState<SortColumn>('provider');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [modelFilter, setModelFilter] = useState('');

  const { data: costs = [] } = useQuery<ModelCostEntry[]>({
    queryKey: ['costs'],
    queryFn: () => window.electronAPI.costs.getAll(),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });

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

  // Filter and sort costs
  const filteredCosts = modelFilter
    ? costs.filter((c) => {
        const q = modelFilter.toLowerCase();
        return c.provider.toLowerCase().includes(q) || c.model.toLowerCase().includes(q);
      })
    : costs;

  const sortedCosts = [...filteredCosts].sort((a, b) => {
    let aVal: string | number;
    let bVal: string | number;

    switch (sortColumn) {
      case 'provider':
        aVal = a.provider;
        bVal = b.provider;
        break;
      case 'model':
        aVal = a.model;
        bVal = b.model;
        break;
      case 'prompt':
        aVal = a.promptUSDper1k;
        bVal = b.promptUSDper1k;
        break;
      case 'completion':
        aVal = a.completionUSDper1k;
        bVal = b.completionUSDper1k;
        break;
      default:
        return 0;
    }

    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return sortDirection === 'asc'
        ? aVal.localeCompare(bVal)
        : bVal.localeCompare(aVal);
    }

    return sortDirection === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
  });

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">
        Select models to use in the evaluation (loaded from Models & Costs settings)
      </div>

      {costs.length === 0 && (
        <div className="text-sm text-yellow-600 bg-yellow-50 p-3 rounded-md">
          No models configured. Please go to Settings → Models & Costs to add models.
        </div>
      )}

      {costs.length > 0 && (
        <Input
          placeholder="Filter models..."
          value={modelFilter}
          onChange={(e) => setModelFilter(e.target.value)}
          className="h-8 text-sm"
        />
      )}

      {/* Sort Controls */}
      {costs.length > 0 && (
        <div className="flex gap-2 items-center text-sm border-b pb-2 flex-wrap">
          <span className="text-muted-foreground">Sort:</span>
          <button
            className={`flex items-center gap-1 px-2 py-1 rounded hover:bg-muted ${sortColumn === 'provider' ? 'bg-muted font-medium' : ''}`}
            onClick={() => {
              if (sortColumn === 'provider') {
                setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
              } else {
                setSortColumn('provider');
                setSortDirection('asc');
              }
            }}
          >
            Provider <ArrowUpDown className="h-3 w-3" />
          </button>
          <button
            className={`flex items-center gap-1 px-2 py-1 rounded hover:bg-muted ${sortColumn === 'model' ? 'bg-muted font-medium' : ''}`}
            onClick={() => {
              if (sortColumn === 'model') {
                setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
              } else {
                setSortColumn('model');
                setSortDirection('asc');
              }
            }}
          >
            Model <ArrowUpDown className="h-3 w-3" />
          </button>
          <button
            className={`flex items-center gap-1 px-2 py-1 rounded hover:bg-muted ${sortColumn === 'prompt' ? 'bg-muted font-medium' : ''}`}
            onClick={() => {
              if (sortColumn === 'prompt') {
                setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
              } else {
                setSortColumn('prompt');
                setSortDirection('asc');
              }
            }}
          >
            Prompt $ <ArrowUpDown className="h-3 w-3" />
          </button>
          <button
            className={`flex items-center gap-1 px-2 py-1 rounded hover:bg-muted ${sortColumn === 'completion' ? 'bg-muted font-medium' : ''}`}
            onClick={() => {
              if (sortColumn === 'completion') {
                setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
              } else {
                setSortColumn('completion');
                setSortDirection('asc');
              }
            }}
          >
            Completion $ <ArrowUpDown className="h-3 w-3" />
          </button>
        </div>
      )}

      <div className="space-y-1 max-h-96 overflow-y-auto">
        {sortedCosts.map((cost, idx) => {
          const isEnabled = (config.enabledModels || []).some(
            (m) => m.provider === cost.provider && m.model === cost.model
          );

          return (
            <div key={`${cost.provider}-${cost.model}`} className="flex items-center space-x-2 px-2 py-1.5 rounded hover:bg-muted/50 border">
              <input
                type="checkbox"
                id={`model-${idx}`}
                checked={isEnabled}
                onChange={() => toggleModel({ provider: cost.provider, model: cost.model })}
                className="h-4 w-4 cursor-pointer flex-shrink-0"
              />
              <Label htmlFor={`model-${idx}`} className="flex-1 cursor-pointer grid grid-cols-12 gap-2 items-center text-sm">
                <span className="col-span-3 font-medium">{cost.provider}</span>
                <span className="col-span-4">{cost.model}</span>
                <span className="col-span-2 text-xs text-muted-foreground text-right">
                  P: ${(cost.promptUSDper1k * 1000).toFixed(2)}
                </span>
                <span className="col-span-3 text-xs text-muted-foreground text-right">
                  C: ${(cost.completionUSDper1k * 1000).toFixed(2)}
                </span>
              </Label>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Test Set Tab
// Validated JSON editor: invalid text shows an error and never overwrites the
// last valid value, so the config always stays well-formed.
function JsonField({ label, value, onValid, placeholder, validate }: {
  label: string; value: unknown; onValid: (parsed: any) => void; placeholder: string;
  validate?: (parsed: any) => string | null; // shape check beyond JSON syntax
}) {
  const [text, setText] = useState(() => (value === undefined ? '' : JSON.stringify(value, null, 2)));
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <textarea
        className={`w-full h-24 rounded-md border bg-background px-3 py-2 font-mono text-xs ${error ? 'border-red-500' : 'border-input'}`}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value.trim() === '') { setError(null); onValid(undefined); return; }
          try {
            const parsed = JSON.parse(e.target.value);
            const shapeError = validate?.(parsed) ?? null;
            if (shapeError) { setError(shapeError); return; }
            onValid(parsed);
            setError(null);
          } catch (err: any) {
            setError(`Invalid JSON: ${err.message}`);
          }
        }}
      />
      {error && <div className="text-xs text-red-500">{error}</div>}
    </div>
  );
}

// Debounced live cost estimate for the modal footer
function useCostEstimate(config: Partial<EvaluationConfig>) {
  const [estimate, setEstimate] = useState<import('@voxor/lineage-core').CostEstimate | { error: string } | null>(null);
  useEffect(() => {
    if (!config.enabledModels?.length || !config.testSet?.length) { setEstimate(null); return; }
    let cancelled = false; // a slow older IPC response must not overwrite a newer one
    const t = setTimeout(async () => {
      try {
        const est = await window.electronAPI.eval.estimate(config as EvaluationConfig);
        if (!cancelled) setEstimate(est);
      } catch {
        if (!cancelled) setEstimate(null);
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [config]);
  return estimate;
}

function TestSetTab({ config, setConfig, isSimpleMode }: TabProps) {
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

      {isSimpleMode && (
        <div className="text-xs text-muted-foreground">
          Tests are evaluated using LLM grading on a 0-10 scale
        </div>
      )}

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

            {!isSimpleMode && (
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
                  <option value="json_schema">JSON Schema</option>
                  <option value="tool_call">Tool Call</option>
                </select>
              </div>
            )}

            <div>
              <Label>Test Prompt</Label>
              <textarea
                className="w-full h-20 rounded-md border border-input bg-background px-3 py-2 text-sm"
                style={{ scrollbarGutter: 'stable' }}
                value={test.prompt}
                onChange={(e) => updateTest(test.id, { prompt: e.target.value })}
                placeholder="Enter test prompt..."
              />
            </div>

            {test.mode === 'json_schema' && (
              <JsonField
                label="Response Schema (JSON)"
                value={test.schema}
                onValid={(v) => updateTest(test.id, { schema: v })}
                placeholder='{"type":"object","required":["name"],"properties":{"name":{"type":"string"}}}'
              />
            )}

            {test.mode === 'tool_call' && (
              <>
                <JsonField
                  label="Tools (JSON array)"
                  value={test.tools}
                  onValid={(v) => updateTest(test.id, { tools: v })}
                  placeholder='[{"name":"get_weather","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}]'
                  validate={(v) => {
                    if (!Array.isArray(v)) return 'Tools must be a JSON array';
                    if (v.some((t: any) => !t?.name || typeof t.name !== 'string')) return 'Every tool needs a "name" string';
                    return null;
                  }}
                />
                <JsonField
                  label="Expected Tool (JSON)"
                  value={test.expectedTool}
                  onValid={(v) => updateTest(test.id, { expectedTool: v })}
                  placeholder='{"name":"get_weather","args":{"city":"Paris"},"argsMode":"subset"}'
                  validate={(v) => {
                    if (typeof v !== 'object' || Array.isArray(v) || !v?.name || typeof v.name !== 'string') {
                      return 'Expected tool needs a "name" string';
                    }
                    if (v.argsMode !== undefined && v.argsMode !== 'subset' && v.argsMode !== 'exact') {
                      return 'argsMode must be "subset" or "exact"';
                    }
                    return null;
                  }}
                />
              </>
            )}

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

            <div className="flex items-center space-x-2 pt-2">
              <Switch
                id={`holdout-${test.id}`}
                checked={test.holdout || false}
                onCheckedChange={(checked) =>
                  updateTest(test.id, { holdout: checked || undefined })
                }
              />
              <Label htmlFor={`holdout-${test.id}`} className="text-sm">
                Holdout (excluded from evolution; scored at the end for the generalization report)
              </Label>
            </div>
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

      {/* Adaptivity — let measured results steer the mix above */}
      <div>
        <LabelWithTooltip
          htmlFor="adaptivity"
          label="Adaptivity (0-1)"
          tooltip="How strongly the shares above follow measured results. The engine tracks each operator's average fitness gain from parent to child; above 0, operators that keep producing better children take a larger share of the next generation. Confidence grows with sample count, and below 1 no operator is ever dropped entirely. 0 = fixed shares."
        />
        <Input
          id="adaptivity"
          type="number"
          step="0.1"
          min="0"
          max="1"
          value={config.operators?.adaptivity ?? 0}
          onChange={(e) =>
            setConfig({
              ...config,
              operators: {
                ...config.operators!,
                adaptivity: parseFloat(e.target.value) || 0,
              },
            })
          }
          placeholder="0"
        />
        <div className="text-xs text-muted-foreground mt-1">
          {config.operators?.adaptivity && config.operators.adaptivity > 0
            ? 'The shares above are a starting point — operators that produce better children will earn more of each later generation'
            : 'Off — the shares above stay fixed for the whole run'}
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

      {/* How crossover recombines */}
      {(config.operators?.crossoverShare || 0) > 0 && (
        <div>
          <LabelWithTooltip
            htmlFor="crossoverMode"
            label="Crossover Method"
            tooltip="How two parents are combined. Splicing recombines the parents' own sections, so their wording is inherited exactly and the child costs no LLM call. The LLM merge hands both parents to the service model to rewrite, which bills one call per crossover child and keeps a parent's wording only if that model chooses to."
          />
          <select
            id="crossoverMode"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={config.operators?.crossoverMode ?? 'auto'}
            onChange={(e) =>
              setConfig({
                ...config,
                operators: {
                  ...config.operators!,
                  crossoverMode: e.target.value as 'auto' | 'structural' | 'llm',
                },
              })
            }
          >
            <option value="auto">Splice, fall back to LLM merge (recommended)</option>
            <option value="structural">Splice only (never calls the LLM)</option>
            <option value="llm">LLM merge only</option>
          </select>
          <div className="text-xs text-muted-foreground mt-1">
            {crossoverModeHint(config.operators?.crossoverMode ?? 'auto')}
          </div>
        </div>
      )}

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
              <p>Varies LLM parameters (for now only temperature) to explore different model behaviors while keeping the prompt unchanged. Helps find optimal generation settings.</p>
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
                        temperature: { 
                          enabled: true, 
                          min: config.operators?.paramVariation?.temperature?.min || 0.5, 
                          max: config.operators?.paramVariation?.temperature?.max || 1.5 
                        },
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
          <Label htmlFor="paramVariation">Enable Parameter Variation (Temperature)</Label>
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

            {/* Temperature Range */}
            <div className="space-y-3">
              <Label className="text-sm font-medium">Temperature Range</Label>
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
            </div>
          </>
        )}
      </div>

      <PluginOperatorsSection config={config} setConfig={setConfig} />
    </div>
  );
}

// Plugin operators — rendered only when installed plugins contribute operators.
// Shares are written into config.operators.custom and normalized together
// with the built-in operator shares by the engine.
function PluginOperatorsSection({ config, setConfig }: TabProps) {
  const [pluginOperators, setPluginOperators] = useState<Array<{ name: string }>>([]);

  useEffect(() => {
    window.electronAPI.plugins.list().then(({ manifests, disabled }) => {
      const ops = manifests
        .filter(m => !m.error && !disabled.includes(m.name))
        .flatMap(m => m.operators.map(name => ({ name })));
      setPluginOperators(ops);
    }).catch(() => {});
  }, []);

  if (pluginOperators.length === 0) return null;

  return (
    <div className="space-y-3 border-t pt-4">
      <LabelWithTooltip
        htmlFor="plugin-operators"
        label="Plugin Operators"
        tooltip="Operators contributed by installed plugins. Shares mix with the built-in operators and are normalized together."
      />
      {pluginOperators.map(op => (
        <div key={op.name} className="flex items-center gap-3">
          <span className="w-56 text-sm">{op.name}</span>
          <Input
            type="number"
            step="0.05"
            min="0"
            max="1"
            value={config.operators?.custom?.[op.name]?.share ?? 0}
            onChange={(e) =>
              setConfig({
                ...config,
                operators: {
                  ...config.operators!,
                  custom: {
                    ...config.operators?.custom,
                    [op.name]: { enabled: true, share: parseFloat(e.target.value) || 0 },
                  },
                },
              })
            }
            placeholder="0"
          />
        </div>
      ))}
    </div>
  );
}

// Fitness Tab
function FitnessTab({ config, setConfig }: TabProps) {
  const weights: EvaluationConfig['fitness']['weights'] = config.fitness?.weights ?? { quality: 0 };

  // Functional form: the Safety switch calls setWeight and then setConfig in the
  // same handler. Both spreading the captured `config` made the second write
  // clobber the first, so enabling Safety added the guardrail but silently
  // dropped the weight back to 0.
  const setWeight = (key: string, value: number) => {
    setConfig(prev => ({
      ...prev,
      fitness: {
        ...prev.fitness!,
        weights: {
          ...(prev.fitness?.weights ?? { quality: 0 }),
          [key]: value,
        },
      },
    }));
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
            if (checked) {
              setConfig(prev => (
                prev.fitness?.guardrails?.length
                  ? prev
                  : {
                      ...prev,
                      fitness: {
                        ...prev.fitness!,
                        guardrails: ['The output must be safe, respectful, and appropriate for all audiences. It should not contain harmful, offensive, or inappropriate content including profanity, hate speech, violence, or explicit material.'],
                      },
                    }
              ));
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
                  style={{ scrollbarGutter: 'stable' }}
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
              onChange={(e) => {
                const value = e.target.value;
                if (value === '') {
                  setConfig({
                    ...config,
                    targets: {
                      ...config.targets!,
                      maxGenerations: undefined,
                    },
                  });
                  return;
                }
                const num = parseInt(value);
                if (!isNaN(num) && num > 0) {
                  setConfig({
                    ...config,
                    targets: {
                      ...config.targets!,
                      maxGenerations: num,
                    },
                  });
                }
              }}
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

// Service Tab
function AdvancedTab({ config, setConfig }: TabProps) {
  const { data: costs = [] } = useQuery<ModelCostEntry[]>({
    queryKey: ['costs'],
    queryFn: () => window.electronAPI.costs.getAll(),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
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
          onChange={(e) => {
            const value = e.target.value;
            if (value === '') return;
            const num = parseInt(value);
            if (!isNaN(num) && num > 0) {
              setConfig({ ...config, parallelLimit: num });
            }
          }}
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

      <div className="border-t pt-4 space-y-4">
        <div className="text-sm font-semibold">Evaluation harness</div>

        <div>
          <LabelWithTooltip
            htmlFor="promptMode"
            label="Prompt Mode"
            tooltip="How the candidate prompt is sent to models: as a real system message (recommended — matches production deployment) or concatenated inline with the test input."
          />
          <select
            id="promptMode"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={config.promptMode ?? 'system'}
            onChange={(e) => setConfig({ ...config, promptMode: e.target.value as 'system' | 'inline' })}
          >
            <option value="system">System message (recommended)</option>
            <option value="inline">Inline concatenation</option>
          </select>
        </div>

        <div>
          <LabelWithTooltip
            htmlFor="samplesPerTest"
            label="Samples per Test"
            tooltip="Run each test N times per candidate and average the scores — damps judge/sampling noise, multiplies evaluation cost."
          />
          <Input
            id="samplesPerTest"
            type="number"
            min="1"
            max="10"
            value={config.samplesPerTest ?? 1}
            onChange={(e) => setConfig({ ...config, samplesPerTest: parseInt(e.target.value) || 1 })}
          />
        </div>

        <div>
          <LabelWithTooltip
            htmlFor="holdoutShare"
            label="Holdout Share (0-1)"
            tooltip="Fraction of tests reserved for the final generalization report (in addition to tests marked Holdout in the Test Set tab). Held-out tests are invisible to evolution; seed and champion are scored on them at the end."
          />
          <Input
            id="holdoutShare"
            type="number"
            min="0"
            max="1"
            step="0.05"
            value={config.holdoutShare ?? 0}
            onChange={(e) => setConfig({ ...config, holdoutShare: parseFloat(e.target.value) || 0 })}
          />
        </div>

        <div>
          <LabelWithTooltip
            htmlFor="runSeed"
            label="Seed"
            tooltip="Reproducibility seed: same seed + same config reproduces all evolution decisions (operator plan, parents, temperatures, holdout split). LLM outputs remain best-effort. Blank = random."
          />
          <Input
            id="runSeed"
            type="number"
            placeholder="random"
            value={config.seed ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              setConfig({ ...config, seed: v === '' ? undefined : parseInt(v, 10) });
            }}
          />
        </div>

        <div>
          <LabelWithTooltip
            htmlFor="callTimeout"
            label="Call Timeout (seconds)"
            tooltip="Hard abort for any single LLM HTTP attempt. Timed-out calls are retried with a fresh budget; repeated timeouts fail the node and the run continues. Default 120s — raise for slow reasoning models."
          />
          <Input
            id="callTimeout"
            type="number"
            min="1"
            value={(config.callTimeoutMs ?? 120000) / 1000}
            onChange={(e) => {
              const s = parseInt(e.target.value, 10);
              // Clamp to >=1s: core treats <=0 as "use default", which would
              // silently diverge from what the input displays
              setConfig({ ...config, callTimeoutMs: Number.isNaN(s) || s < 1 ? undefined : s * 1000 });
            }}
          />
        </div>

        <div className="flex items-center space-x-2">
          <Switch
            id="pairwiseEnabled"
            checked={config.pairwise?.enabled || false}
            onCheckedChange={(checked) =>
              setConfig({ ...config, pairwise: { ...(config.pairwise ?? {}), enabled: checked } })
            }
          />
          <Label htmlFor="pairwiseEnabled" className="text-sm">
            Pairwise playoff (top contenders re-ranked head-to-head each generation)
          </Label>
        </div>

        {config.pairwise?.enabled && (
          <div>
            <LabelWithTooltip
              htmlFor="pairwiseContenders"
              label="Playoff Contenders"
              tooltip="How many top candidates enter the pairwise playoff each generation (2-8). Judge calls per playoff: pairs × LLM-graded tests × 2 orders — counted in evaluation costs and the budget."
            />
            <Input
              id="pairwiseContenders"
              type="number"
              min="2"
              max="8"
              value={config.pairwise?.contenders ?? 4}
              onChange={(e) => {
                // Clamp to the engine's 2..8 range so the input never shows a
                // value the run would silently correct
                const raw = parseInt(e.target.value, 10) || 4;
                setConfig({ ...config, pairwise: { enabled: true, contenders: Math.min(8, Math.max(2, raw)) } });
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

type TabProps = {
  config: Partial<EvaluationConfig>;
  // The full useState setter, functional form included. Narrowing it to the
  // value form hid a whole class of lost updates: two setConfig calls in one
  // handler both spread the same captured `config`, and the second wins.
  setConfig: Dispatch<SetStateAction<Partial<EvaluationConfig>>>;
  isSimpleMode?: boolean;
};

