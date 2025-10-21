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
import { useEvaluationState } from '../hooks/useEvaluationState_v2';

interface CenterViewProps {
  evaluationId: UUID | null;
  selectedNodeId: UUID | null;
  onSelectNode: (nodeId: UUID) => void;
}

export function CenterView({ evaluationId, selectedNodeId, onSelectNode }: CenterViewProps) {
  // Pure IPC-driven state - NO POLLING!
  const { evaluation, isLoading } = useEvaluationState(evaluationId);

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
    const nodeSpacing = 250; // Vertical spacing between nodes
    const generationSpacing = 350; // Horizontal spacing between generations

    // Create nodes for each candidate
    evaluation.generations.forEach((generation, genIndex) => {
      generation.forEach((candidate, nodeIndex) => {
        const x = genIndex * generationSpacing;
        const y = nodeIndex * nodeSpacing;

        // Determine node color based on status and fitness
        let bgColor = '#1e1e1e'; // Dark card
        let borderColor = '#3e3e3e';
        let textColor = '#e0e0e0';
        
        if (candidate.status === 'finished' && candidate.metrics?.fitness !== undefined) {
          const fitness = candidate.metrics.fitness;
          if (fitness >= 9) {
            bgColor = '#16a34a'; // Strong green
            borderColor = '#15803d';
            textColor = '#ffffff';
          } else if (fitness >= 7) {
            bgColor = '#ca8a04'; // Strong yellow/gold
            borderColor = '#a16207';
            textColor = '#ffffff';
          } else {
            bgColor = '#374151'; // Gray
            borderColor = '#4b5563';
            textColor = '#d1d5db';
          }
        } else if (candidate.status === 'running') {
          bgColor = '#2563eb'; // Strong blue
          borderColor = '#1d4ed8';
          textColor = '#ffffff';
        } else if (candidate.status === 'error') {
          bgColor = '#dc2626'; // Strong red
          borderColor = '#b91c1c';
          textColor = '#ffffff';
        } else if (candidate.status === 'pending') {
          bgColor = '#6b7280'; // Lighter gray
          borderColor = '#9ca3af';
          textColor = '#e5e7eb';
        }

        flowNodes.push({
          id: candidate.id,
          type: 'default',
          position: { x, y },
          data: {
            label: (
              <div className="text-xs" style={{ color: textColor }}>
                <div className="font-semibold text-sm">G{genIndex}</div>
                <div className="opacity-70 text-xs">{candidate.id.slice(0, 8)}</div>
                {candidate.metrics?.fitness !== undefined && (
                  <div className="font-bold mt-1 text-sm">F: {candidate.metrics.fitness.toFixed(2)}</div>
                )}
                {candidate.status !== 'finished' && (
                  <div className="opacity-80 capitalize text-xs mt-1">{candidate.status}</div>
                )}
              </div>
            ),
          },
          style: {
            background: bgColor,
            borderColor: borderColor,
            borderWidth: candidate.id === selectedNodeId ? 4 : 2,
            color: textColor,
            padding: '12px',
            borderRadius: '8px',
            width: 160,
            boxShadow: candidate.id === selectedNodeId ? '0 0 0 2px #3b82f6' : 'none',
          },
        });

        // Create edges from parents
        if (candidate.lineageParents && candidate.lineageParents.length > 0) {
          candidate.lineageParents.forEach((parentId) => {
            const edgeColor = candidate.status === 'running' ? '#3b82f6' : '#4b5563';
            flowEdges.push({
              id: `${parentId}-${candidate.id}`,
              source: parentId,
              target: candidate.id,
              type: 'smoothstep',
              animated: candidate.status === 'running',
              markerEnd: {
                type: MarkerType.ArrowClosed,
                color: edgeColor,
              },
              style: {
                stroke: edgeColor,
                strokeWidth: candidate.status === 'running' ? 3 : 2,
              },
            });
          });
        }
      });
    });

    setNodes(flowNodes);
    setEdges(flowEdges);
  }, [evaluation, selectedNodeId, setNodes, setEdges]);

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
