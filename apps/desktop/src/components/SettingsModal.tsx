import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { Trash2, ArrowUpDown, RefreshCw } from 'lucide-react';
import type { AppSettings, ModelCostEntry } from '../types';

type SortColumn = 'provider' | 'model' | 'prompt' | 'completion';
type SortDirection = 'asc' | 'desc';

interface SettingsModalProps {
  onClose: () => void;
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const queryClient = useQueryClient();

  const { data: settings } = useQuery<AppSettings>({
    queryKey: ['settings'],
    queryFn: () => window.electronAPI.settings.get(),
  });

  const { data: costs = [] } = useQuery<ModelCostEntry[]>({
    queryKey: ['costs'],
    queryFn: () => window.electronAPI.costs.getAll(),
  });

  const [apiKeys, setApiKeys] = useState({
    openai: '',
    anthropic: '',
    gemini: '',
    openrouter: '',
  });

  const [syncingModels, setSyncingModels] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  // Load API keys when modal opens
  useEffect(() => {
    const loadKeys = async () => {
      try {
        const [openaiKey, anthropicKey, geminiKey, openrouterKey] = await Promise.all([
          window.electronAPI.keys.get('openai'),
          window.electronAPI.keys.get('anthropic'),
          window.electronAPI.keys.get('gemini'),
          window.electronAPI.keys.get('openrouter'),
        ]);

        setApiKeys({
          openai: openaiKey || '',
          anthropic: anthropicKey || '',
          gemini: geminiKey || '',
          openrouter: openrouterKey || '',
        });
      } catch (error) {
        console.error('Failed to load API keys:', error);
      }
    };
    loadKeys();
  }, []);

  const [localSettings, setLocalSettings] = useState<AppSettings>({
    globalParallelLimit: 5,
    serviceModel: { provider: 'openai', model: '' },
    serviceModelMaxTokens: 20000, // Default 20k tokens for ALL models
    retries: 3, // Default 3 retries for JSON parsing failures
  });
  
  const [localCosts, setLocalCosts] = useState<ModelCostEntry[]>([]);
  const [sortColumn, setSortColumn] = useState<SortColumn>('provider');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  // Initialize from query data when available
  useEffect(() => {
    if (settings) {
      setLocalSettings(settings);
    }
  }, [settings]);

  useEffect(() => {
    if (costs) {
      setLocalCosts(costs);
    }
  }, [costs]);

  const saveSettings = useMutation({
    mutationFn: async () => {
      // Save API keys (or delete if empty)
      for (const [provider, key] of Object.entries(apiKeys)) {
        await window.electronAPI.keys.save(provider, key); // Save empty string to effectively clear
      }

      // Save settings
      await window.electronAPI.settings.set(localSettings);

      // Save costs
      for (const cost of localCosts) {
        await window.electronAPI.costs.set(cost);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['costs'] });
      onClose();
    },
    onError: (error: any) => {
      console.error('Save failed:', error);
      alert('Failed to save settings: ' + (error?.message || error));
    },
  });


  return (
    <Dialog open={true} onOpenChange={(open) => {
      if (!open) onClose();
    }}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Configure API keys, service models, and cost settings
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="general" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="apikeys">API Keys</TabsTrigger>
            <TabsTrigger value="costs">Models & Costs</TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="space-y-4 min-h-[500px]">
            <div>
              <Label htmlFor="parallelLimit">Global Parallel Execution Limit</Label>
              <Input
                id="parallelLimit"
                type="number"
                min="1"
                max="20"
                value={localSettings.globalParallelLimit}
                onChange={(e) =>
                  setLocalSettings({
                    ...localSettings,
                    globalParallelLimit: parseInt(e.target.value) || 5,
                  })
                }
              />
            </div>

            <div>
              <Label htmlFor="serviceModel">Service Model (for mutations/crossover/grading)</Label>
              <FilterableModelSelect
                models={localCosts}
                value={localSettings.serviceModel}
                onChange={(model) =>
                  setLocalSettings({
                    ...localSettings,
                    serviceModel: model,
                  })
                }
              />
              <div className="text-xs text-muted-foreground mt-1">
                Models are loaded from the Models & Costs tab
              </div>
            </div>

            <div>
              <Label htmlFor="serviceModelMaxTokens">Max Tokens (All Models)</Label>
              <Input
                id="serviceModelMaxTokens"
                type="number"
                min="1000"
                max="200000"
                step="1000"
                value={localSettings.serviceModelMaxTokens ?? 20000}
                onChange={(e) =>
                  setLocalSettings({
                    ...localSettings,
                    serviceModelMaxTokens: parseInt(e.target.value) || 20000,
                  })
                }
              />
              <div className="text-xs text-muted-foreground mt-1">
                Maximum tokens for ALL model calls (service model AND candidate models). Essential for reasoning models like o1/gpt-5 which need space to think.
              </div>
            </div>

            <div>
              <Label htmlFor="retries">Retries for JSON Parsing Failures</Label>
              <Input
                id="retries"
                type="number"
                min="0"
                max="10"
                value={localSettings.retries ?? 3}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value === '') return;
                  const num = parseInt(value);
                  if (!isNaN(num) && num >= 0) {
                    setLocalSettings({
                      ...localSettings,
                      retries: num,
                    });
                  }
                }}
              />
              <div className="text-xs text-muted-foreground mt-1">
                Number of retry attempts when service model returns invalid JSON (e.g., mutations, crossover, grading). Higher values improve reliability with cheap models but increase costs on repeated failures.
              </div>
            </div>
          </TabsContent>

          <TabsContent value="apikeys" className="space-y-4 min-h-[500px]">
            <div>
              <Label htmlFor="openai-key">OpenAI API Key</Label>
              <Input
                id="openai-key"
                type="password"
                placeholder="sk-..."
                value={apiKeys.openai}
                onChange={(e) => setApiKeys({ ...apiKeys, openai: e.target.value })}
              />
            </div>

            <div>
              <Label htmlFor="anthropic-key">Anthropic API Key</Label>
              <Input
                id="anthropic-key"
                type="password"
                placeholder="sk-ant-..."
                value={apiKeys.anthropic}
                onChange={(e) => setApiKeys({ ...apiKeys, anthropic: e.target.value })}
              />
            </div>

            <div>
              <Label htmlFor="gemini-key">Google Gemini API Key</Label>
              <Input
                id="gemini-key"
                type="password"
                placeholder="..."
                value={apiKeys.gemini}
                onChange={(e) => setApiKeys({ ...apiKeys, gemini: e.target.value })}
              />
            </div>

            <div className="border-t pt-4 mt-4">
              <Label htmlFor="openrouter-key">OpenRouter API Key</Label>
              <div className="text-xs text-muted-foreground mb-2">
                Single key for 200+ models from all providers via openrouter.ai
              </div>
              <Input
                id="openrouter-key"
                type="password"
                placeholder="sk-or-..."
                value={apiKeys.openrouter}
                onChange={(e) => setApiKeys({ ...apiKeys, openrouter: e.target.value })}
              />
              <div className="flex items-center gap-2 mt-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={syncingModels}
                  onClick={async () => {
                    setSyncingModels(true);
                    setSyncResult(null);
                    try {
                      // Save the key first so the sync can use it
                      await window.electronAPI.keys.save('openrouter', apiKeys.openrouter);
                      const result = await window.electronAPI.models.syncOpenRouter();
                      setSyncResult(`${result.count} models synced`);
                      // Refresh costs table
                      queryClient.invalidateQueries({ queryKey: ['costs'] });
                    } catch (error: any) {
                      setSyncResult(`Error: ${error.message || error}`);
                    } finally {
                      setSyncingModels(false);
                    }
                  }}
                >
                  <RefreshCw className={`h-3 w-3 mr-1 ${syncingModels ? 'animate-spin' : ''}`} />
                  Sync Models
                </Button>
                {syncResult && (
                  <span className={`text-xs ${syncResult.startsWith('Error') ? 'text-destructive' : 'text-muted-foreground'}`}>
                    {syncResult}
                  </span>
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="costs" className="space-y-4 min-h-[500px]">
            <div className="text-sm text-muted-foreground mb-2">
              Configure cost per million tokens for each model (USD)
            </div>

            {/* Table Header */}
            <div className="grid grid-cols-12 gap-2 items-center px-3 py-2 border-b text-xs font-semibold text-muted-foreground">
              <button
                className="col-span-3 flex items-center gap-1 hover:text-foreground"
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
                className="col-span-3 flex items-center gap-1 hover:text-foreground"
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
                className="col-span-2 flex items-center gap-1 hover:text-foreground"
                onClick={() => {
                  if (sortColumn === 'prompt') {
                    setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
                  } else {
                    setSortColumn('prompt');
                    setSortDirection('asc');
                  }
                }}
              >
                Prompt $/M <ArrowUpDown className="h-3 w-3" />
              </button>
              <button
                className="col-span-3 flex items-center gap-1 hover:text-foreground"
                onClick={() => {
                  if (sortColumn === 'completion') {
                    setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
                  } else {
                    setSortColumn('completion');
                    setSortDirection('asc');
                  }
                }}
              >
                Completion $/M <ArrowUpDown className="h-3 w-3" />
              </button>
              <div className="col-span-1 text-center">Delete</div>
            </div>

            {/* Table Body */}
            <div className="max-h-80 overflow-y-auto">
              {getSortedCosts(localCosts, sortColumn, sortDirection).map((cost, idx) => {
                const originalIdx = localCosts.findIndex(
                  c => c.provider === cost.provider && c.model === cost.model
                );
                return (
                  <div key={`${cost.provider}-${cost.model}-${idx}`} className="grid grid-cols-12 gap-2 items-center px-3 py-2 border-b hover:bg-muted/50">
                    <div className="col-span-3">
                      <select
                        className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm h-9"
                        value={cost.provider}
                        onChange={(e) => {
                          const newCosts = [...localCosts];
                          newCosts[originalIdx].provider = e.target.value as any;
                          setLocalCosts(newCosts);
                        }}
                      >
                        <option value="openai">OpenAI</option>
                        <option value="anthropic">Anthropic</option>
                        <option value="gemini">Gemini</option>
                        <option value="openrouter">OpenRouter</option>
                      </select>
                    </div>
                    <div className="col-span-3">
                      <Input
                        className="h-9"
                        value={cost.model}
                        onChange={(e) => {
                          const newCosts = [...localCosts];
                          newCosts[originalIdx].model = e.target.value;
                          setLocalCosts(newCosts);
                        }}
                      />
                    </div>
                    <div className="col-span-2">
                      <Input
                        className="h-9"
                        type="number"
                        step="0.01"
                        value={(cost.promptUSDper1k * 1000).toFixed(2)}
                        onChange={(e) => {
                          const newCosts = [...localCosts];
                          newCosts[originalIdx].promptUSDper1k = (parseFloat(e.target.value) || 0) / 1000;
                          setLocalCosts(newCosts);
                        }}
                      />
                    </div>
                    <div className="col-span-3">
                      <Input
                        className="h-9"
                        type="number"
                        step="0.01"
                        value={(cost.completionUSDper1k * 1000).toFixed(2)}
                        onChange={(e) => {
                          const newCosts = [...localCosts];
                          newCosts[originalIdx].completionUSDper1k = (parseFloat(e.target.value) || 0) / 1000;
                          setLocalCosts(newCosts);
                        }}
                      />
                    </div>
                    <div className="col-span-1 flex justify-center">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9"
                        onClick={() => {
                          const newCosts = localCosts.filter((_, i) => i !== originalIdx);
                          setLocalCosts(newCosts);
                        }}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>

            <Button
              variant="outline"
              onClick={() =>
                setLocalCosts([
                  ...localCosts,
                  {
                    provider: 'openai',
                    model: '',
                    promptUSDper1k: 0,
                    completionUSDper1k: 0,
                  },
                ])
              }
            >
              + Add Model
            </Button>
          </TabsContent>
        </Tabs>

        <div className="flex justify-end space-x-2 mt-4">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => saveSettings.mutate()}>
            Save Settings
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Filterable model select with search
function FilterableModelSelect({
  models,
  value,
  onChange,
}: {
  models: ModelCostEntry[];
  value: { provider: string; model: string };
  onChange: (model: { provider: any; model: string }) => void;
}) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(false);

  const filtered = models.filter((c) => {
    const q = filter.toLowerCase();
    return c.provider.toLowerCase().includes(q) || c.model.toLowerCase().includes(q);
  });

  const selectedLabel = `${value.provider}/${value.model}`;

  return (
    <div className="relative mt-2">
      <Input
        placeholder="Search models..."
        value={open ? filter : selectedLabel}
        onFocus={() => {
          setOpen(true);
          setFilter('');
        }}
        onChange={(e) => setFilter(e.target.value)}
      />
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute z-50 w-full mt-1 max-h-60 overflow-y-auto rounded-md border bg-popover shadow-md">
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-sm text-muted-foreground">No models found</div>
            )}
            {filtered.map((cost, idx) => (
              <button
                key={`${cost.provider}-${cost.model}-${idx}`}
                className={`w-full text-left px-3 py-1.5 text-sm hover:bg-muted flex justify-between ${
                  cost.provider === value.provider && cost.model === value.model ? 'bg-muted font-medium' : ''
                }`}
                onClick={() => {
                  onChange({ provider: cost.provider as any, model: cost.model });
                  setOpen(false);
                }}
              >
                <span>{cost.provider}/{cost.model}</span>
                <span className="text-xs text-muted-foreground">
                  ${(cost.promptUSDper1k * 1000).toFixed(2)}/M
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Helper function to sort costs
function getSortedCosts(
  costs: ModelCostEntry[],
  column: SortColumn,
  direction: SortDirection
): ModelCostEntry[] {
  const sorted = [...costs].sort((a, b) => {
    let aVal: string | number;
    let bVal: string | number;

    switch (column) {
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
      return direction === 'asc'
        ? aVal.localeCompare(bVal)
        : bVal.localeCompare(aVal);
    }

    return direction === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
  });

  return sorted;
}

