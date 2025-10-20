import { useQuery } from '@tanstack/react-query';
import { NodeCard } from './NodeCard';
import { LineageGraph } from './LineageGraph';
import type { UUID, EvaluationRun, CandidateNode } from '../types';

interface CenterViewProps {
  evaluationId: UUID | null;
  selectedNodeId: UUID | null;
  onSelectNode: (nodeId: UUID) => void;
}

export function CenterView({ evaluationId, selectedNodeId, onSelectNode }: CenterViewProps) {
  const { data: evaluation } = useQuery<EvaluationRun>({
    queryKey: ['evaluation', evaluationId],
    enabled: !!evaluationId,
    queryFn: async () => {
      const evals = await window.electronAPI.eval.list();
      return evals.find(e => e.id === evaluationId) || null;
    },
    refetchInterval: 1000,
  });

  if (!evaluationId) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-muted-foreground">
            No Evaluation Selected
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Create a new evaluation or select an existing one
          </p>
        </div>
      </div>
    );
  }

  if (!evaluation) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-muted-foreground">Loading...</h2>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-background p-6">
      {/* D3 Lineage Graph */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold mb-4">Lineage Graph</h2>
        <LineageGraph
          generations={evaluation.generations}
          onNodeClick={onSelectNode}
          selectedNodeId={selectedNodeId}
        />
      </div>
      
      <div className="mx-auto max-w-7xl space-y-8">
        {evaluation.generations.map((generation, genIndex) => {
          const topNodes = getTopNodes(generation, 3);
          
          return (
            <div
              key={genIndex}
              className="rounded-lg border bg-card p-6"
              style={{
                backgroundColor: genIndex % 2 === 0 ? 'hsl(var(--card))' : 'hsl(var(--muted) / 0.3)',
              }}
            >
              <h3 className="mb-4 text-lg font-semibold">
                Generation {genIndex}
              </h3>
              
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                {generation.map((node, nodeIndex) => {
                  const rank = topNodes.findIndex(n => n.id === node.id) + 1;
                  
                  return (
                    <NodeCard
                      key={node.id}
                      node={node}
                      rank={rank > 0 ? rank : undefined}
                      isSelected={node.id === selectedNodeId}
                      onClick={() => onSelectNode(node.id)}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function getTopNodes(generation: CandidateNode[], count: number): CandidateNode[] {
  return generation
    .filter(n => n.status === 'finished' && n.metrics?.fitness !== undefined)
    .sort((a, b) => (b.metrics!.fitness! - a.metrics!.fitness!))
    .slice(0, count);
}

