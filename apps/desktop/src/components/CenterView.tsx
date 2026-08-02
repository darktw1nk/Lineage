import { useCallback, useEffect } from 'react';
import ReactFlow, {
  Node,
  Edge,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  MarkerType,
} from 'reactflow';
import 'reactflow/dist/style.css';
import type { UUID } from '../types';
// Subpath, NOT the barrel: importing '@voxor/lineage-core' from renderer code pulls
// the whole engine (sql.js, fs, path, ajv) into the browser bundle, where
// vite-plugin-electron-renderer rewrites the Node built-ins to `require` —
// undefined under contextIsolation. The built app then rendered a blank window
// while dev mode stayed fine. Same single implementation, no engine.
import { selectChampion } from '@voxor/lineage-core/champion';
import { useEvaluation } from '../hooks/useEvaluation';

interface CenterViewProps {
  evaluationId: UUID | null;
  selectedNodeId: UUID | null;
  onSelectNode: (nodeId: UUID) => void;
}

export function CenterView({ evaluationId, selectedNodeId, onSelectNode }: CenterViewProps) {
  // Centralized store - single source of truth!
  const { evaluation, isLoading } = useEvaluation(evaluationId);

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // Convert evaluation data to React Flow nodes and edges
  useEffect(() => {
    if (!evaluation || !evaluation.generations) {
      setNodes([]);
      setEdges([]);
      return;
    }

    const totalNodes = evaluation.generations.reduce((sum, gen) => sum + gen.length, 0);
    console.log(`[CenterView] Rendering ${totalNodes} nodes across ${evaluation.generations.length} generations`);
    evaluation.generations.forEach((gen, idx) => {
      console.log(`  Gen ${idx}: ${gen.length} nodes`);
    });

    const flowNodes: Node[] = [];
    const flowEdges: Edge[] = [];
    const nodeSpacing = 300; // Horizontal spacing between nodes
    const generationSpacing = 400; // Vertical spacing between generations
    let edgeCounter = 0; // Global counter for unique edge IDs

    // Rank with the ENGINE's own selector. This used to sort by raw fitness and
    // filter out elites, so the 🥇 crown could sit on a node that is not the
    // champion the tool actually reports — the prompt the user copies off the
    // graph was then not the prompt in the holdout row, the CLI report, or
    // results.json. Two proven divergences: a decisive playoff (which overrides
    // fitness and which this ignored), and an elite winning — elites ARE
    // playoff contenders and are usually the strongest, so that is the ordinary
    // case rather than an edge one.
    //
    // `n.changeLog[0]` also had no optional chain on changeLog itself, so a node
    // without one — reachable from eval:import, which does not validate node
    // contents — threw a TypeError and replaced the whole graph with its
    // ErrorBoundary.
    const allFinished = evaluation.generations.flatMap((gen, genIndex) =>
      gen
        .filter(n => n.status === 'finished' && n.metrics?.fitness !== undefined)
        .map(n => ({ node: n, generation: n.generation ?? genIndex })),
    );
    const champion = selectChampion(
      allFinished.map(e => ({ id: e.node.id, generation: e.generation, metrics: e.node.metrics })),
      evaluation.playoffs,
      n => n.generation ?? 0,
    );
    // Runners-up stay fitness-ordered; only the crown is authoritative.
    const runnersUp = allFinished
      .map(e => e.node)
      .filter(n => n.id !== champion.champion?.id)
      .sort((a, b) => (b.metrics?.fitness || 0) - (a.metrics?.fitness || 0));

    const topNodeIds = new Set([
      champion.champion?.id,
      runnersUp[0]?.id,
      runnersUp[1]?.id,
    ].filter(Boolean));

    // Create nodes for each candidate
    evaluation.generations.forEach((generation, genIndex) => {
      generation.forEach((candidate, nodeIndex) => {
        const x = nodeIndex * nodeSpacing;
        const y = genIndex * generationSpacing;

        // Calculate total tokens
        const totalTokens = (candidate.tests || []).reduce(
          (sum, test) => sum + test.promptTokens + test.completionTokens,
          0
        );
        
        // Calculate elapsed time
        const elapsed = candidate.timings?.finishedAt && candidate.timings?.startedAt
          ? ((candidate.timings.finishedAt - candidate.timings.startedAt) / 1000).toFixed(1)
          : null;

        // Determine rank-based colors (Gold/Silver/Bronze for top 3)
        let bgColor = '#2a2a3e'; // Default: darker purple-blue
        let borderColor = '#4a4a6e';
        let textColor = '#e0e0e0';
        let rankLabel = '';
        
        if (candidate.id === champion.champion?.id) {
          // 🥇 Gold - 1st place
          bgColor = 'linear-gradient(135deg, #FFD700 0%, #FFA500 100%)';
          borderColor = '#FFD700';
          textColor = '#000000';
          rankLabel = '🥇';
        } else if (candidate.id === runnersUp[0]?.id) {
          // 🥈 Silver - 2nd place
          bgColor = 'linear-gradient(135deg, #C0C0C0 0%, #A8A8A8 100%)';
          borderColor = '#C0C0C0';
          textColor = '#000000';
          rankLabel = '🥈';
        } else if (candidate.id === runnersUp[1]?.id) {
          // 🥉 Bronze - 3rd place
          bgColor = 'linear-gradient(135deg, #CD7F32 0%, #B8860B 100%)';
          borderColor = '#CD7F32';
          textColor = '#000000';
          rankLabel = '🥉';
        } else if (candidate.status === 'finished') {
          bgColor = '#3a3a4e'; // Finished but not top 3
          borderColor = '#5a5a7e';
        } else if (candidate.status === 'in_progress') {
          bgColor = '#2563eb'; // Blue for running
          borderColor = '#1d4ed8';
          textColor = '#ffffff';
        } else if (candidate.status === 'failed') {
          bgColor = '#dc2626'; // Red for error
          borderColor = '#b91c1c';
          textColor = '#ffffff';
        } else if (candidate.status === 'pending' || candidate.status === 'awaiting') {
          // `awaiting` is a real NodeStatus — it is what Stop rewinds unfinished
          // nodes to before checkpointing, so a stopped run is full of them — and
          // it had no branch here, falling through to the same swatch as a node
          // that has not been created yet.
          bgColor = '#4a4a5e'; // Lighter gray for not-yet-run
          borderColor = '#6a6a8e';
        } else if (candidate.status === 'skipped') {
          bgColor = '#3a3a3a'; // Dimmed: deliberately not evaluated
          borderColor = '#5a5a5a';
        }

        flowNodes.push({
          id: candidate.id,
          type: 'default',
          position: { x, y },
          data: {
            label: (
              <div className="text-xs font-mono" style={{ color: textColor }}>
                {/* Fitness Score + Medal at top */}
                {candidate.metrics?.fitness !== undefined ? (
                  <div className="flex items-center justify-center gap-2 mb-3">
                    <span className="font-bold text-2xl">{candidate.metrics.fitness.toFixed(2)}</span>
                    {rankLabel && <span className="text-2xl">{rankLabel}</span>}
                  </div>
                ) : (
                  <div className="flex items-center justify-center gap-2 mb-3">
                    <span className="opacity-50 text-sm">No score yet</span>
                    {rankLabel && <span className="text-2xl">{rankLabel}</span>}
                  </div>
                )}
                
                {/* Gen + ID */}
                <div className="text-center mb-2">
                  <div className="font-semibold text-xs">Gen {genIndex}</div>
                  <div className="opacity-70 text-[10px]">{candidate.id.slice(0, 8)}</div>
                </div>
                
                {/* Other info */}
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <span className="opacity-80">Status:</span>
                    <span className="font-semibold capitalize text-[10px]">{candidate.status}</span>
                  </div>
                  
                  {totalTokens > 0 && (
                    <div className="flex justify-between">
                      <span className="opacity-80">Tokens:</span>
                      <span className="text-[10px]">{totalTokens.toLocaleString()}</span>
                    </div>
                  )}
                  
                  {elapsed && (
                    <div className="flex justify-between">
                      <span className="opacity-80">Time:</span>
                      <span className="text-[10px]">{elapsed}s</span>
                    </div>
                  )}
                  
                  {candidate.params?.model && (
                    <div className="flex justify-between">
                      <span className="opacity-80">Model:</span>
                      <span className="text-[10px] truncate max-w-[100px]">{candidate.params.model.model}</span>
                    </div>
                  )}
                </div>
              </div>
            ),
          },
          style: {
            background: bgColor,
            color: textColor,
            border: `3px solid ${borderColor}`,
            borderRadius: '12px',
            padding: '16px',
            width: 220,
            height: 200,
            cursor: 'pointer',
            boxShadow: candidate.id === selectedNodeId 
              ? '0 0 0 3px #3b82f6' 
              : topNodeIds.has(candidate.id) 
              ? `0 0 20px ${borderColor}80` 
              : '0 4px 6px rgba(0, 0, 0, 0.3)',
          },
        });

        // Create edges from parents
        if (candidate.lineageParents && candidate.lineageParents.length > 0) {
          candidate.lineageParents.forEach((parentId) => {
            const edgeColor = candidate.status === 'in_progress' ? '#3b82f6' : '#4b5563';
            flowEdges.push({
              id: `edge-${edgeCounter++}`,
              source: parentId,
              target: candidate.id,
              type: 'simplebezier',
              animated: candidate.status === 'in_progress',
              markerEnd: {
                type: MarkerType.ArrowClosed,
                color: edgeColor,
              },
              style: {
                stroke: edgeColor,
                strokeWidth: candidate.status === 'in_progress' ? 3 : 2,
              },
            });
          });
        }
      });
    });

    setNodes(flowNodes);
    setEdges(flowEdges);
    // Depend on `generations`, NOT the whole `evaluation`.
    //
    // accrueCost emits a `totals` event per API CALL, and updateTotals returns
    // a new evaluation object (spreading the same generations array), so
    // depending on `evaluation` rebuilt the entire graph on every call —
    // measured 30,406 rebuilds in one 20-generation run, ~4.1ms each at 600
    // nodes, so ~125 seconds of pure renderer JS before React reconciliation
    // and React Flow's DOM work. Spend changes do not change the graph.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evaluation?.generations, selectedNodeId, setNodes, setEdges]);

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      onSelectNode(node.id);
    },
    [onSelectNode]
  );

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

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-muted-foreground">Loading...</h2>
        </div>
      </div>
    );
  }

  if (!evaluation) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-muted-foreground">Evaluation not found</h2>
        </div>
      </div>
    );
  }

  const totalNodes = evaluation?.generations.reduce((sum, gen) => sum + gen.length, 0) || 0;

  return (
    <div className="flex-1 w-full h-full bg-background">
      <ReactFlow
        key={`flow-${evaluationId}-${totalNodes}`}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.1}
        maxZoom={2}
        defaultEdgeOptions={{
          type: 'smoothstep',
        }}
      >
        <Background color="#333" gap={16} />
        <Controls />
        <MiniMap
          nodeColor={(node) => {
            const style = node.style as any;
            return style?.background || '#1e1e1e';
          }}
          maskColor="rgba(0, 0, 0, 0.3)"
          style={{
            backgroundColor: '#1a1a1a',
          }}
        />
      </ReactFlow>
    </div>
  );
}
