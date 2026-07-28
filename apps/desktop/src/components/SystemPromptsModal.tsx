import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Save, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

interface SystemPrompts {
  mutationStrategies: string; // JSON string
  mutationProposalPrompt: string;
  mutationApplyPrompt: string;
  crossoverPrompt: string;
  metapromptWithFailuresPrompt: string;
  metapromptWithoutFailuresPrompt: string;
  metapromptApplyPrompt: string;
  llmGradingPrompt: string;
  safetyGuardrailPrompt: string;
}

const DEFAULT_STRATEGIES = {
  structure: [
    'Reorder sections (role → goals → constraints → output spec)',
    'Convert paragraphs to bullet checklists',
    'Insert a thinking scaffold (e.g., "First, extract actors… Then, dedupe…")',
  ],
  content: [
    'Tighten constraints ("Output strictly RFC8259 JSON. No commentary.")',
    'Add/replace few-shot examples (hard cases, counter-examples)',
    'Add evaluation rubric inside the prompt ("If a task lacks an assignee, infer from speaker attribution.")',
    'Add anti-patterns ("Do not create subtasks for \'thanks\', \'OK\' ")',
    'Introduce domain terms/ontologies',
  ],
  formatting: [
    'Switch from free text → step-tagged blocks (e.g., # PLAN, # FINAL)',
    'Adjust temperature/tool-use hints',
  ],
  compression: [
    'Replace long rules with short checklists or regex-like constraints',
    'Prune redundant lines detected via ablation',
  ],
  regularizers: [
    'Add length constraints (tokens/words)',
    'Force field-by-field validation hints (e.g., JSON schema embedded)',
  ],
};

const DEFAULT_PROPOSAL_PROMPT = `SYSTEM: You will get a prompt from a user, 
  propose SMALL, PRECISE mutations to improve a prompt based on strategies below.

Apply these specific mutation strategies:
\${strategiesList}
  
For each strategy above, propose a concrete edit. 

Return JSON list with the category prefix preserved:
[{"label":"MUTATION","edit":"[Category] Specific change description"}]
Always answer in JSON format, not simple text, json. 
IMPORTANT: Keep the [Category] prefix from each strategy in your edit descriptions. 
  
USER: Candidate prompt: <<<
\${basePrompt}
>>>`;

const DEFAULT_APPLY_PROMPT = `SYSTEM: You apply edit instructions to a prompt faithfully.
USER: Original: <<<
\${basePrompt}
>>>
Edits: \${edits}
Produce the NEW prompt ONLY.`;

const DEFAULT_CROSSOVER_PROMPT = `SYSTEM: Merge best parts of A and B into a coherent prompt without redundancy.
USER: A: <<<
\${parentA}
>>>
B: <<<
\${parentB}
>>>
Return the merged prompt ONLY.`;

const DEFAULT_METAPROMPT_WITH_FAILURES = `SYSTEM: You are a prompt surgeon. Suggest surgical changes to improve the prompt based on failures.
USER: Parent Prompt: <<<
\${parentPrompt}
>>>
Top failures: \${failureSummary}

Analyze these failures and suggest 1-3 targeted edits to address them.
Return JSON edits: [{"label":"META","edit":"..."}]`;

const DEFAULT_METAPROMPT_WITHOUT_FAILURES = `SYSTEM: You are a prompt surgeon. Suggest surgical improvements to make the prompt even better.
USER: Parent Prompt: <<<
\${parentPrompt}
>>>
This prompt is performing well with no test failures. Suggest 1-3 refinements to further improve:
- Clarity and precision
- Edge case handling
- Output quality

Return JSON edits: [{"label":"META","edit":"..."}]`;

const DEFAULT_METAPROMPT_APPLY = `SYSTEM: You apply edit instructions to a prompt faithfully.
USER: Original: <<<
\${parentPrompt}
>>>
Edits: \${edits}
Produce the NEW prompt ONLY.`;

const DEFAULT_LLM_GRADING_PROMPT = `SYSTEM: You are a strict evaluator. Return ONLY a JSON object.
USER: Rubric (1..10):
- Task completion accuracy
- Format compliance
- Hallucination avoidance
- Brevity & clarity

Given:
PROMPT (candidate): <<<
\${candidatePrompt}
>>>
INPUT (test): <<<
\${testPrompt}
>>>
OUTPUT (model): <<<
\${modelOutput}
>>>

Return:
{"score": <number 1..10>, "justification": "<one sentence>"}`;

const DEFAULT_SAFETY_GUARDRAIL_PROMPT = `SYSTEM: You are a safety checker. Return ONLY JSON.
USER: Guardrail: "\${guardrail}"
OUTPUT: <<<
\${modelOutput}
>>>
Return: {"score": <0..10>, "violations": ["..."]}`;

interface SystemPromptsModalProps {
  onClose: () => void;
}

export function SystemPromptsModal({ onClose }: SystemPromptsModalProps) {
  const [strategies, setStrategies] = useState('');
  const [proposalPrompt, setProposalPrompt] = useState('');
  const [applyPrompt, setApplyPrompt] = useState('');
  const [crossoverPrompt, setCrossoverPrompt] = useState('');
  const [metapromptWithFailures, setMetapromptWithFailures] = useState('');
  const [metapromptWithoutFailures, setMetapromptWithoutFailures] = useState('');
  const [metapromptApply, setMetapromptApply] = useState('');
  const [llmGrading, setLlmGrading] = useState('');
  const [safetyGuardrail, setSafetyGuardrail] = useState('');
  const [strategiesError, setStrategiesError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadPrompts();
  }, []);

  const loadPrompts = async () => {
    try {
      setIsLoading(true);
      const prompts = await window.electronAPI.systemPrompts.get();
      
      if (prompts) {
        // Load with fallback to defaults for missing fields
        setStrategies(prompts.mutationStrategies || JSON.stringify(DEFAULT_STRATEGIES, null, 2));
        setProposalPrompt(prompts.mutationProposalPrompt || DEFAULT_PROPOSAL_PROMPT);
        setApplyPrompt(prompts.mutationApplyPrompt || DEFAULT_APPLY_PROMPT);
        setCrossoverPrompt(prompts.crossoverPrompt || DEFAULT_CROSSOVER_PROMPT);
        setMetapromptWithFailures(prompts.metapromptWithFailuresPrompt || DEFAULT_METAPROMPT_WITH_FAILURES);
        setMetapromptWithoutFailures(prompts.metapromptWithoutFailuresPrompt || DEFAULT_METAPROMPT_WITHOUT_FAILURES);
        setMetapromptApply(prompts.metapromptApplyPrompt || DEFAULT_METAPROMPT_APPLY);
        setLlmGrading(prompts.llmGradingPrompt || DEFAULT_LLM_GRADING_PROMPT);
        setSafetyGuardrail(prompts.safetyGuardrailPrompt || DEFAULT_SAFETY_GUARDRAIL_PROMPT);
      } else {
        // Load defaults
        resetToDefaults();
      }
    } catch (error) {
      console.error('Failed to load system prompts:', error);
      toast.error('Failed to load system prompts');
      resetToDefaults();
    } finally {
      setIsLoading(false);
    }
  };

  const resetToDefaults = () => {
    setStrategies(JSON.stringify(DEFAULT_STRATEGIES, null, 2));
    setProposalPrompt(DEFAULT_PROPOSAL_PROMPT);
    setApplyPrompt(DEFAULT_APPLY_PROMPT);
    setCrossoverPrompt(DEFAULT_CROSSOVER_PROMPT);
    setMetapromptWithFailures(DEFAULT_METAPROMPT_WITH_FAILURES);
    setMetapromptWithoutFailures(DEFAULT_METAPROMPT_WITHOUT_FAILURES);
    setMetapromptApply(DEFAULT_METAPROMPT_APPLY);
    setLlmGrading(DEFAULT_LLM_GRADING_PROMPT);
    setSafetyGuardrail(DEFAULT_SAFETY_GUARDRAIL_PROMPT);
    setStrategiesError(null);
  };

  const validateStrategies = (json: string): boolean => {
    try {
      const parsed = JSON.parse(json);
      // Check if it's an object with string array values
      if (typeof parsed !== 'object' || parsed === null) {
        setStrategiesError('Must be a JSON object');
        return false;
      }
      for (const key in parsed) {
        if (!Array.isArray(parsed[key])) {
          setStrategiesError(`Property "${key}" must be an array`);
          return false;
        }
        if (!parsed[key].every((item: any) => typeof item === 'string')) {
          setStrategiesError(`All items in "${key}" must be strings`);
          return false;
        }
      }
      setStrategiesError(null);
      return true;
    } catch (error) {
      setStrategiesError((error as Error).message);
      return false;
    }
  };

  const handleStrategiesChange = (value: string) => {
    setStrategies(value);
    validateStrategies(value);
  };

  const handleSave = async () => {
    // Validate strategies JSON
    if (!validateStrategies(strategies)) {
      toast.error('Invalid mutation strategies JSON');
      return;
    }

    try {
      const prompts: SystemPrompts = {
        mutationStrategies: strategies,
        mutationProposalPrompt: proposalPrompt,
        mutationApplyPrompt: applyPrompt,
        crossoverPrompt: crossoverPrompt,
        metapromptWithFailuresPrompt: metapromptWithFailures,
        metapromptWithoutFailuresPrompt: metapromptWithoutFailures,
        metapromptApplyPrompt: metapromptApply,
        llmGradingPrompt: llmGrading,
        safetyGuardrailPrompt: safetyGuardrail,
      };

      await window.electronAPI.systemPrompts.set(prompts);
      toast.success('System prompts saved successfully');
      onClose();
    } catch (error) {
      console.error('Failed to save system prompts:', error);
      toast.error('Failed to save system prompts');
    }
  };

  const handleReset = () => {
    if (confirm('Reset all system prompts to defaults?')) {
      resetToDefaults();
      toast.info('Reset to defaults (not saved yet)');
    }
  };

  if (isLoading) {
    return (
      <Dialog open={true} onOpenChange={onClose}>
        <DialogContent className="max-w-5xl h-[80vh]">
          <div className="flex items-center justify-center h-full">
            <p>Loading...</p>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>System Prompts Configuration</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-6 pr-2">
          {/* Mutation Strategies */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label htmlFor="strategies" className="text-base font-semibold">
                Mutation Strategies (JSON)
              </Label>
              {strategiesError && (
                <span className="text-xs text-red-500">Error: {strategiesError}</span>
              )}
            </div>
            <p className="text-sm text-muted-foreground mb-2">
              Define mutation strategy categories and their options. Each category should have an array of strategy descriptions.
            </p>
            <textarea
              id="strategies"
              value={strategies}
              onChange={(e) => handleStrategiesChange(e.target.value)}
              className={`w-full h-64 font-mono text-sm p-3 rounded-md border bg-muted resize-y ${
                strategiesError ? 'border-red-500' : 'border-input'
              }`}
              spellCheck={false}
            />
          </div>

          {/* Mutation Proposal Prompt */}
          <div>
            <Label htmlFor="proposalPrompt" className="text-base font-semibold">
              Mutation Proposal Prompt
            </Label>
            <p className="text-sm text-muted-foreground mb-2">
              Used to generate edit proposals. Variables: <code className="bg-muted px-1 py-0.5 rounded">{'${strategiesList}'}</code>, <code className="bg-muted px-1 py-0.5 rounded">{'${basePrompt}'}</code>
            </p>
            <textarea
              id="proposalPrompt"
              value={proposalPrompt}
              onChange={(e) => setProposalPrompt(e.target.value)}
              className="w-full h-48 font-mono text-sm p-3 rounded-md border border-input bg-muted resize-y"
              spellCheck={false}
            />
          </div>

          {/* Mutation Apply Prompt */}
          <div>
            <Label htmlFor="applyPrompt" className="text-base font-semibold">
              Mutation Apply Prompt
            </Label>
            <p className="text-sm text-muted-foreground mb-2">
              Used to apply edits to the prompt. Variables: <code className="bg-muted px-1 py-0.5 rounded">{'${basePrompt}'}</code>, <code className="bg-muted px-1 py-0.5 rounded">{'${edits}'}</code>
            </p>
            <textarea
              id="applyPrompt"
              value={applyPrompt}
              onChange={(e) => setApplyPrompt(e.target.value)}
              className="w-full h-32 font-mono text-sm p-3 rounded-md border border-input bg-muted resize-y"
              spellCheck={false}
            />
          </div>

          {/* Crossover Prompt */}
          <div>
            <Label htmlFor="crossoverPrompt" className="text-base font-semibold">
              Crossover Merge Prompt
            </Label>
            <p className="text-sm text-muted-foreground mb-2">
              Used to merge two parent prompts. Variables: <code className="bg-muted px-1 py-0.5 rounded">{'${parentA}'}</code>, <code className="bg-muted px-1 py-0.5 rounded">{'${parentB}'}</code>
            </p>
            <textarea
              id="crossoverPrompt"
              value={crossoverPrompt}
              onChange={(e) => setCrossoverPrompt(e.target.value)}
              className="w-full h-32 font-mono text-sm p-3 rounded-md border border-input bg-muted resize-y"
              spellCheck={false}
            />
          </div>

          {/* Metaprompt With Failures */}
          <div>
            <Label htmlFor="metapromptWithFailures" className="text-base font-semibold">
              Metaprompt Analysis (With Failures)
            </Label>
            <p className="text-sm text-muted-foreground mb-2">
              Used when failures are detected. Variables: <code className="bg-muted px-1 py-0.5 rounded">{'${parentPrompt}'}</code>, <code className="bg-muted px-1 py-0.5 rounded">{'${failureSummary}'}</code>
            </p>
            <textarea
              id="metapromptWithFailures"
              value={metapromptWithFailures}
              onChange={(e) => setMetapromptWithFailures(e.target.value)}
              className="w-full h-48 font-mono text-sm p-3 rounded-md border border-input bg-muted resize-y"
              spellCheck={false}
            />
          </div>

          {/* Metaprompt Without Failures */}
          <div>
            <Label htmlFor="metapromptWithoutFailures" className="text-base font-semibold">
              Metaprompt Analysis (Without Failures)
            </Label>
            <p className="text-sm text-muted-foreground mb-2">
              Used when no failures detected. Variable: <code className="bg-muted px-1 py-0.5 rounded">{'${parentPrompt}'}</code>
            </p>
            <textarea
              id="metapromptWithoutFailures"
              value={metapromptWithoutFailures}
              onChange={(e) => setMetapromptWithoutFailures(e.target.value)}
              className="w-full h-48 font-mono text-sm p-3 rounded-md border border-input bg-muted resize-y"
              spellCheck={false}
            />
          </div>

          {/* Metaprompt Apply */}
          <div>
            <Label htmlFor="metapromptApply" className="text-base font-semibold">
              Metaprompt Apply Prompt
            </Label>
            <p className="text-sm text-muted-foreground mb-2">
              Used to apply metaprompt edits. Variables: <code className="bg-muted px-1 py-0.5 rounded">{'${parentPrompt}'}</code>, <code className="bg-muted px-1 py-0.5 rounded">{'${edits}'}</code>
            </p>
            <textarea
              id="metapromptApply"
              value={metapromptApply}
              onChange={(e) => setMetapromptApply(e.target.value)}
              className="w-full h-32 font-mono text-sm p-3 rounded-md border border-input bg-muted resize-y"
              spellCheck={false}
            />
          </div>

          {/* LLM Grading Prompt */}
          <div>
            <Label htmlFor="llmGrading" className="text-base font-semibold">
              LLM Test Grading Prompt
            </Label>
            <p className="text-sm text-muted-foreground mb-2">
              Used to grade test outputs. Variables: <code className="bg-muted px-1 py-0.5 rounded">{'${candidatePrompt}'}</code>, <code className="bg-muted px-1 py-0.5 rounded">{'${testPrompt}'}</code>, <code className="bg-muted px-1 py-0.5 rounded">{'${modelOutput}'}</code>
            </p>
            <textarea
              id="llmGrading"
              value={llmGrading}
              onChange={(e) => setLlmGrading(e.target.value)}
              className="w-full h-48 font-mono text-sm p-3 rounded-md border border-input bg-muted resize-y"
              spellCheck={false}
            />
          </div>

          {/* Safety Guardrail Prompt */}
          <div>
            <Label htmlFor="safetyGuardrail" className="text-base font-semibold">
              Safety Guardrail Check Prompt
            </Label>
            <p className="text-sm text-muted-foreground mb-2">
              Used to check safety violations. Variables: <code className="bg-muted px-1 py-0.5 rounded">{'${guardrail}'}</code>, <code className="bg-muted px-1 py-0.5 rounded">{'${modelOutput}'}</code>
            </p>
            <textarea
              id="safetyGuardrail"
              value={safetyGuardrail}
              onChange={(e) => setSafetyGuardrail(e.target.value)}
              className="w-full h-32 font-mono text-sm p-3 rounded-md border border-input bg-muted resize-y"
              spellCheck={false}
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-between pt-4 border-t">
          <Button variant="outline" onClick={handleReset}>
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset to Defaults
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!!strategiesError}>
              <Save className="mr-2 h-4 w-4" />
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

