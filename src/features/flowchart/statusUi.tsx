import { Circle, CircleCheck, Loader, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { StepStatus } from '@/lib/types';

export const STATUS_ICON: Record<StepStatus, LucideIcon> = {
  not_started: Circle,
  in_progress: Loader,
  verified: CircleCheck,
  blocked: TriangleAlert,
};

export const STATUS_TEXT_CLASS: Record<StepStatus, string> = {
  not_started: 'text-muted',
  in_progress: 'text-accent',
  verified: 'text-accent',
  blocked: 'text-warning',
};
