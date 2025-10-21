import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import type { AppSettings, ModelCostEntry } from '../types';

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
  });

  // Load API keys when modal opens
  useEffect(() => {
    const loadKeys = async () => {
      try {
        const [openaiKey, anthropicKey, geminiKey] = await Promise.all([
          window.electronAPI.keys.get('openai'),
          window.electronAPI.keys.get('anthropic'),
          window.electronAPI.keys.get('gemini'),
        ]);
        
        setApiKeys({
          openai: openaiKey || '',
          anthropic: anthropicKey || '',
          gemini: geminiKey || '',
        });
      } catch (error) {
        console.error('Failed to load API keys:', error);
      }
    };
    loadKeys();
  }, []);

  const [localSettings, setLocalSettings] = useState<AppSettings>({
    globalParallelLimit: 5,
    serviceModel: { provider: 'openai', model: 'gpt-4' },
  });
  
  const [localCosts, setLocalCosts] = useState<ModelCostEntry[]>([]);

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

          <TabsContent value="general" className="space-y-4">
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
              <select
                id="serviceModel"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm mt-2"
                value={`${localSettings.serviceModel.provider}:${localSettings.serviceModel.model}`}
                onChange={(e) => {
                  const [provider, model] = e.target.value.split(':');
                  setLocalSettings({
                    ...localSettings,
                    serviceModel: { provider: provider as any, model },
                  });
                }}
              >
                <optgroup label="Available Models">
                  {localCosts.map((cost, idx) => (
                    <option key={idx} value={`${cost.provider}:${cost.model}`}>
                      {cost.provider}/{cost.model}
                    </option>
                  ))}
                </optgroup>
              </select>
              <div className="text-xs text-muted-foreground mt-1">
                Models are loaded from the Models & Costs tab
              </div>
            </div>
          </TabsContent>

          <TabsContent value="apikeys" className="space-y-4">
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
          </TabsContent>

          <TabsContent value="costs" className="space-y-4">
            <div className="text-sm text-muted-foreground mb-4">
              Configure cost per million tokens for each model (USD)
            </div>

            <div className="space-y-3 max-h-96 overflow-y-auto">
              {localCosts.map((cost, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-center p-3 border rounded-lg">
                  <div className="col-span-3">
                    <Label className="text-xs">Provider</Label>
                    <select
                      className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                      value={cost.provider}
                      onChange={(e) => {
                        const newCosts = [...localCosts];
                        newCosts[idx].provider = e.target.value as any;
                        setLocalCosts(newCosts);
                      }}
                    >
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Anthropic</option>
                      <option value="gemini">Gemini</option>
                    </select>
                  </div>
                  <div className="col-span-3">
                    <Label className="text-xs">Model</Label>
                    <Input
                      value={cost.model}
                      onChange={(e) => {
                        const newCosts = [...localCosts];
                        newCosts[idx].model = e.target.value;
                        setLocalCosts(newCosts);
                      }}
                    />
                  </div>
                  <div className="col-span-2">
                    <Label className="text-xs">Prompt $/M</Label>
                    <Input
                      type="number"
                      step="0.01"
                      value={(cost.promptUSDper1k * 1000).toFixed(2)}
                      onChange={(e) => {
                        const newCosts = [...localCosts];
                        newCosts[idx].promptUSDper1k = (parseFloat(e.target.value) || 0) / 1000;
                        setLocalCosts(newCosts);
                      }}
                    />
                  </div>
                  <div className="col-span-2">
                    <Label className="text-xs">Completion $/M</Label>
                    <Input
                      type="number"
                      step="0.01"
                      value={(cost.completionUSDper1k * 1000).toFixed(2)}
                      onChange={(e) => {
                        const newCosts = [...localCosts];
                        newCosts[idx].completionUSDper1k = (parseFloat(e.target.value) || 0) / 1000;
                        setLocalCosts(newCosts);
                      }}
                    />
                  </div>
                  <div className="col-span-2">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        const newCosts = localCosts.filter((_, i) => i !== idx);
                        setLocalCosts(newCosts);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
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

