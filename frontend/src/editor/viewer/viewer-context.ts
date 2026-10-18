import { createContext, useContext } from 'react';
import type { ViewerContextValue } from './viewer-types';

export const ViewerContext = createContext<ViewerContextValue | null>(null);

export function useViewer(): ViewerContextValue {
  const value = useContext(ViewerContext);
  if (!value) throw new Error('插件必须渲染在 <MindMapViewer> 内部');
  return value;
}
