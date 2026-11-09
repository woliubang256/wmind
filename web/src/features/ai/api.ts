import { api } from '@/lib/api/client';

export const AI_REASONING_EFFORTS = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AIReasoningEffort = typeof AI_REASONING_EFFORTS[number];

export interface AIConfiguration {
  enabled: boolean;
  baseUrl: string;
  apiKeySet: boolean;
  model: string;
  reasoningEffort: AIReasoningEffort;
  systemPrompt: string;
}
export interface AIConfigurationInput {
  enabled: boolean;
  baseUrl: string;
  apiKey?: string;
  model: string;
  reasoningEffort: AIReasoningEffort;
  clearApiKey?: boolean;
}
export interface AISource {
  name: string;
  text: string;
  images: string[];
}
export interface AINode {
  title: string;
  children: AINode[];
}
export const aiKeys = { configuration: ['admin', 'ai'] as const };
export const aiApi = {
  // base 同 backupApi：桌面端「网站设置」读的是服务器的 AI 配置。
  configuration: (base?: string) => api.get<AIConfiguration>('/admin/ai', base ? { base } : undefined),
  save: (input: AIConfigurationInput, base?: string) =>
    api.put<AIConfiguration>('/admin/ai', input, base ? { base } : undefined),
  generate: (input: { prompt: string; sources: AISource[] }, signal: AbortSignal) =>
    api.post<AINode>('/ai/generate', input, { signal }),
};
