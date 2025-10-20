import { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import type { CandidateNode } from '../types';

interface LineageGraphProps {
  generations: CandidateNode[][];
  onNodeClick: (nodeId: string) => void;
  selectedNodeId: string | null;
}

export function LineageGraph({ generations, onNodeClick, selectedNodeId }: LineageGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  
  useEffect(() => {
    if (!svgRef.current || generations.length === 0) return;
    
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    
    const width = 1200;
    const height = generations.length * 150 + 100;
    
    svg.attr('width', width).attr('height', height);
    
    const g = svg.append('g').attr('transform', 'translate(50, 50)');
    
    // Build node positions
    const nodePositions = new Map<string, { x: number; y: number }>();
    const nodeSpacing = 150;
    const generationSpacing = 120;
    
    generations.forEach((gen, genIndex) => {
      const yPos = genIndex * generationSpacing;
      const totalWidth = gen.length * nodeSpacing;
      const startX = (width - totalWidth) / 2;
      
      gen.forEach((node, nodeIndex) => {
        nodePositions.set(node.id, {
          x: startX + nodeIndex * nodeSpacing,
          y: yPos,
        });
      });
    });
    
    // Draw edges
    const edges = g.append('g').attr('class', 'edges');
    
    generations.forEach((gen, genIndex) => {
      if (genIndex === 0) return; // No parents for first generation
      
      gen.forEach((node) => {
        const childPos = nodePositions.get(node.id);
        if (!childPos) return;
        
        node.lineageParents.forEach((parentId) => {
          const parentPos = nodePositions.get(parentId);
          if (!parentPos) return;
          
          // Draw curved edge from parent to child
          const path = d3.path();
          path.moveTo(parentPos.x, parentPos.y + 20);
          
          const midY = (parentPos.y + childPos.y) / 2;
          path.bezierCurveTo(
            parentPos.x,
            midY,
            childPos.x,
            midY,
            childPos.x,
            childPos.y - 20
          );
          
          edges.append('path')
            .attr('d', path.toString())
            .attr('stroke', '#888')
            .attr('stroke-width', 1.5)
            .attr('fill', 'none')
            .attr('opacity', 0.4);
        });
      });
    });
    
    // Draw node markers (small circles)
    const nodes = g.append('g').attr('class', 'nodes');
    
    generations.forEach((gen) => {
      gen.forEach((node) => {
        const pos = nodePositions.get(node.id);
        if (!pos) return;
        
        const isSelected = node.id === selectedNodeId;
        const topNodes = gen
          .filter(n => n.status === 'finished' && n.metrics?.fitness !== undefined)
          .sort((a, b) => (b.metrics!.fitness! - a.metrics!.fitness!))
          .slice(0, 3);
        const rank = topNodes.findIndex(n => n.id === node.id) + 1;
        
        let color = '#888';
        if (rank === 1) color = '#FFD700'; // Gold
        else if (rank === 2) color = '#C0C0C0'; // Silver
        else if (rank === 3) color = '#CD7F32'; // Bronze
        
        if (node.status === 'in_progress') color = '#3B82F6'; // Blue
        else if (node.status === 'failed') color = '#EF4444'; // Red
        
        nodes.append('circle')
          .attr('cx', pos.x)
          .attr('cy', pos.y)
          .attr('r', isSelected ? 8 : 6)
          .attr('fill', color)
          .attr('stroke', isSelected ? '#000' : 'none')
          .attr('stroke-width', 2)
          .attr('cursor', 'pointer')
          .on('click', () => onNodeClick(node.id));
        
        // Add fitness label if available
        if (node.metrics?.fitness !== undefined) {
          nodes.append('text')
            .attr('x', pos.x)
            .attr('y', pos.y - 12)
            .attr('text-anchor', 'middle')
            .attr('font-size', '10px')
            .attr('fill', '#666')
            .text(node.metrics.fitness.toFixed(1));
        }
      });
    });
    
  }, [generations, selectedNodeId, onNodeClick]);
  
  return (
    <div className="overflow-x-auto overflow-y-auto max-h-[600px] bg-muted/20 rounded-lg p-4">
      <svg ref={svgRef} />
    </div>
  );
}

