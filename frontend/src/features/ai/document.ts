import { createDocument, createTopic } from '@/editor/model/create';
import type { Topic, WmindDocument } from '@/editor/model/types';
import type { AINode } from './api';

/** The editor factory remains the authority for native file shape and theme. */
export function documentFromAI(root: AINode): WmindDocument {
  let count = 0;
  const build = (node: AINode, depth: number): Topic => {
    count += 1;
    if (!node || typeof node.title !== 'string' || !node.title.trim() || !Array.isArray(node.children)
      || Array.from(node.title).length > (depth === 1 ? 200 : 500) || count > 500 || depth > 12) {
      throw new Error('AI_OUTPUT_INVALID');
    }
    const topic = createTopic({ title: node.title.trim() });
    topic.children.attached = node.children.map((child) => build(child, depth + 1));
    return topic;
  };
  const topic = build(root, 1);
  const document = createDocument({ title: topic.title });
  document.sheets[0]!.rootTopic = topic;
  return document;
}
