import { HelpCircle } from 'lucide-react';
import { Label } from './ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

interface LabelWithTooltipProps {
  htmlFor: string;
  label: string;
  tooltip: string;
}

export function LabelWithTooltip({ htmlFor, label, tooltip }: LabelWithTooltipProps) {
  return (
    <div className="flex items-center gap-1.5 mb-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      <Tooltip>
        <TooltipTrigger asChild>
          <HelpCircle className="h-3.5 w-3.5 text-muted-foreground cursor-help flex-shrink-0" />
        </TooltipTrigger>
        <TooltipContent className="max-w-sm">
          <p>{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

