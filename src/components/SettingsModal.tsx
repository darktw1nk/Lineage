import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
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

  const [localSettings, setLocalSettings] = useState<AppSettings>({
    globalParallelLimit: 5,
    serviceModel: { provider: 'openai', model: 'gpt-4' },
  });
  
  const [localCosts, setLocalCosts] = useState<ModelCostEntry[]>([]);

  // Initialize from query data - only once when modal opens
  useEffect(() => {
    if (settings) {
      setLocalSettings(settings);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (costs && costs.length > 0) {
      setLocalCosts(costs);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveSettings = useMutation({
    mutationFn: async () => {
      console.log('Saving settings...', { apiKeys, localSettings, localCosts });
      console.log('window.electronAPI:', window.electronAPI);
      console.log('window.electronAPI.keys:', window.electronAPI?.keys);
      
      // Save API keys
      if (window.electronAPI?.keys) {
        for (const [provider, key] of Object.entries(apiKeys)) {
          if (key) {
            console.log('Saving API key for', provider);
            await window.electronAPI.keys.save(provider, key);
          }
        }
      } else {
        console.warn('keys API not available, skipping');
      }

      // Save settings
      console.log('Saving app settings:', localSettings);
      await window.electronAPI.settings.set(localSettings);

      // Save costs
      console.log('Saving costs:', localCosts.length, 'entries');
      for (const cost of localCosts) {
        await window.electronAPI.costs.set(cost);
      }
      
      console.log('All settings saved successfully');
    },
    onSuccess: () => {
      console.log('Save success, closing modal');
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['costs'] });
      onClose();
    },
    onError: (error) => {
      console.error('Save failed:', error);
      alert('Failed to save settings: ' + error);
    },
  });


  return (
    <Dialog open={true} onOpenChange={(open) => {
      console.log('Dialog onOpenChange called with:', open);
      if (!open) onClose();
    }}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="general" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="apikeys">API Keys</TabsTrigger>
            <TabsTrigger value="costs">Model Costs</TabsTrigger>
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
              <Label>Service Model (for mutations/crossover/grading)</Label>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <div>
                  <Label htmlFor="serviceProvider">Provider</Label>
                  <Input
                    id="serviceProvider"
                    value={localSettings?.serviceModel?.provider || 'openai'}
                    onChange={(e) =>
                      setLocalSettings({
                        ...localSettings,
                        serviceModel: {
                          ...localSettings.serviceModel,
                          provider: e.target.value as any,
                        },
                      })
                    }
                  />
                </div>
                <div>
                  <Label htmlFor="serviceModel">Model</Label>
                  <Input
                    id="serviceModel"
                    value={localSettings.serviceModel.model}
                    onChange={(e) =>
                      setLocalSettings({
                        ...localSettings,
                        serviceModel: {
                          ...localSettings.serviceModel,
                          model: e.target.value,
                        },
                      })
                    }
                  />
                </div>
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
              Configure cost per 1k tokens for each model (USD)
            </div>

            <div className="space-y-3 max-h-96 overflow-y-auto">
              {localCosts.map((cost, idx) => (
                <div key={idx} className="grid grid-cols-4 gap-2 items-end">
                  <div>
                    <Label className="text-xs">Provider</Label>
                    <Input
                      value={cost.provider}
                      onChange={(e) => {
                        const newCosts = [...localCosts];
                        newCosts[idx].provider = e.target.value as any;
                        setLocalCosts(newCosts);
                      }}
                      size={10}
                    />
                  </div>
                  <div>
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
                  <div>
                    <Label className="text-xs">Prompt $/1k</Label>
                    <Input
                      type="number"
                      step="0.0001"
                      value={cost.promptUSDper1k}
                      onChange={(e) => {
                        const newCosts = [...localCosts];
                        newCosts[idx].promptUSDper1k = parseFloat(e.target.value) || 0;
                        setLocalCosts(newCosts);
                      }}
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Completion $/1k</Label>
                    <Input
                      type="number"
                      step="0.0001"
                      value={cost.completionUSDper1k}
                      onChange={(e) => {
                        const newCosts = [...localCosts];
                        newCosts[idx].completionUSDper1k = parseFloat(e.target.value) || 0;
                        setLocalCosts(newCosts);
                      }}
                    />
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
              Add Model
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

