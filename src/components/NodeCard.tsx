import { Clock } from 'lucide-react';
import type { CandidateNode } from '../types';

interface NodeCardProps {
  node: CandidateNode;
  rank?: number;
  isSelected: boolean;
  onClick: () => void;
}

export function NodeCard({ node, rank, isSelected, onClick }: NodeCardProps) {
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'awaiting':
        return 'bg-gray-500';
      case 'in_progress':
        return 'bg-blue-500';
      case 'finished':
        return 'bg-green-500';
      case 'failed':
        return 'bg-red-500';
      case 'skipped':
        return 'bg-yellow-500';
      default:
        return 'bg-gray-500';
    }
  };

  const getRankColor = (rank: number) => {
    switch (rank) {
      case 1:
        return 'border-yellow-500 bg-yellow-50 dark:bg-yellow-950';
      case 2:
        return 'border-gray-400 bg-gray-50 dark:bg-gray-900';
      case 3:
        return 'border-blue-500 bg-blue-50 dark:bg-blue-950';
      default:
        return '';
    }
  };

  const elapsed = node.timings?.finishedAt && node.timings?.startedAt
    ? node.timings.finishedAt - node.timings.startedAt
    : node.timings?.startedAt
    ? Date.now() - node.timings.startedAt
    : 0;

  const promptPreview = node.prompt.length > 100
    ? node.prompt.substring(0, 100) + '...'
    : node.prompt;

  return (
    <div
      onClick={onClick}
      className={`cursor-pointer rounded-lg border-2 p-4 transition-all hover:shadow-md ${
        rank ? getRankColor(rank) : ''
      } ${isSelected ? 'border-primary ring-2 ring-primary' : 'border-border'}`}
    >
      {/* Header */}
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-mono text-muted-foreground">
          {node.id.substring(0, 8)}
        </span>
        <span className={`rounded-full px-2 py-1 text-xs text-white ${getStatusColor(node.status)}`}>
          {node.status}
        </span>
      </div>

      {/* Rank badge */}
      {rank && (
        <div className="mb-2">
          <span className={`inline-block rounded px-2 py-1 text-xs font-bold ${
            rank === 1 ? 'bg-yellow-500 text-white' :
            rank === 2 ? 'bg-gray-400 text-white' :
            'bg-blue-500 text-white'
          }`}>
            #{rank}
          </span>
        </div>
      )}

      {/* Prompt preview */}
      <div className="mb-3 text-sm text-foreground">
        {promptPreview}
      </div>

      {/* Footer stats */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="text-muted-foreground">Time</div>
          <div className="font-medium flex items-center">
            <Clock className="mr-1 h-3 w-3" />
            {elapsed > 0 ? `${(elapsed / 1000).toFixed(1)}s` : '-'}
          </div>
        </div>
        
        <div>
          <div className="text-muted-foreground">Fitness</div>
          <div className="font-medium">
            {node.metrics?.fitness !== undefined
              ? node.metrics.fitness.toFixed(2)
              : '-'}
          </div>
        </div>
        
        <div>
          <div className="text-muted-foreground">Temp</div>
          <div className="font-medium">{node.params.temperature}</div>
        </div>
        
        <div>
          <div className="text-muted-foreground">Model</div>
          <div className="font-medium truncate" title={node.params.model.model}>
            {node.params.model.model.split('-')[0]}
          </div>
        </div>
      </div>
    </div>
  );
}

