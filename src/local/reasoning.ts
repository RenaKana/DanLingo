import type { LocalModelInfo, LocalReasoningChoice, LocalTemplateCapability } from './types.ts';

const BOOLEAN_CHOICES: readonly LocalReasoningChoice[] = ['auto', 'off', 'on'];

export function unknownTemplateCapability(): LocalTemplateCapability {
  return { status: 'unknown', mode: 'unknown', supported: BOOLEAN_CHOICES, evidence: 'unverified-template' };
}

/**
 * Recognize only the bounded template shapes that expose a control variable,
 * a chat boundary, and a visible thinking boundary. A lone keyword is not
 * enough to claim capability.
 */
export function detectTemplateCapability(template: unknown, architecture?: string): LocalTemplateCapability {
  if (typeof template !== 'string' || !template.trim()) return unknownTemplateCapability();
  const source = template.trim().replace(/\{#[\s\S]*?#\}/g, '').replace(/\{%[-+]/g, '{%').replace(/[-+]%\}/g, '%}');
  // Official gpt-oss template renders this kwarg in the Harmony system header.
  // The model card specifies low/medium/high; there is no max or disabled mode.
  if (architecture === 'gpt-oss' && source.includes('<|start|>system<|message|>') && source.includes('<|channel|>analysis<|message|>')
    && /\{\{[-+]?\s*["']Reasoning: ["']\s*\+\s*reasoning_effort\b/.test(source)) {
    return { status: 'verified', mode: 'effort', argument: 'reasoning_effort', supported: ['auto','low','medium','high'], evidence: 'gpt-oss-reasoning-header' };
  }
  const hasChatBoundary = /(?:messages|add_generation_prompt|role\s*==|message\[['"]role['"]\])/i.test(source);
  const thinkingBoundary = '(?:<think\\s*>|<\\/think\\s*>|<\\|channel\\|>\\s*(?:analysis|reasoning)\\b|reasoning_content|analysis\\s*>)';
  const hasThinkingBoundary = new RegExp(thinkingBoundary, 'i').test(source);
  const hasEnableControl = new RegExp(`\\{%\\s*(?:if|elif)\\s+[^%]*\\benable_thinking\\b[^%]*%\\}[\\s\\S]{0,640}${thinkingBoundary}[\\s\\S]{0,640}\\{%\\s*(?:elif|else|endif)\\s*%\\}`, 'i').test(source);
  const effortKey = /\breasoning_effort\b/i.test(source) ? 'reasoning_effort' : /\bthinking_level\b/i.test(source) ? 'thinking_level' : undefined;
  if (effortKey !== undefined && hasChatBoundary && hasThinkingBoundary) {
    const values = ['low', 'medium', 'high', 'max'].filter(value => {
      const branch = new RegExp(`\\{%\\s*(?:if|elif)\\s+[^%]*\\b${effortKey}\\b[^%]*(?:==|in)[^%]*['"]${value}['"][^%]*%\\}[\\s\\S]{0,640}${thinkingBoundary}[\\s\\S]{0,640}\\{%\\s*(?:elif|else|endif)\\s*%\\}`, 'i');
      const reverseBranch = new RegExp(`\\{%\\s*(?:if|elif)\\s+[^%]*['"]${value}['"][^%]*(?:==|in)[^%]*\\b${effortKey}\\b[^%]*%\\}[\\s\\S]{0,640}${thinkingBoundary}[\\s\\S]{0,640}\\{%\\s*(?:elif|else|endif)\\s*%\\}`, 'i');
      return branch.test(source) || reverseBranch.test(source);
    });
    if (values.length) {
      const supported: LocalReasoningChoice[] = ['auto'];
      if (hasEnableControl) supported.push('off', 'on');
      supported.push(...(['low', 'medium', 'high', 'max'] as const).filter(value => values.includes(value)));
      return { status: 'verified', mode: 'effort', argument: effortKey, ...(hasEnableControl ? { booleanArgument: 'enable_thinking' as const } : {}), supported,
        evidence: effortKey === 'reasoning_effort' ? 'structured-reasoning-effort-template' : 'structured-thinking-level-template' };
    }
  }
  if (hasChatBoundary && hasThinkingBoundary && hasEnableControl) {
    return { status: 'verified', mode: 'boolean', argument: 'enable_thinking', supported: BOOLEAN_CHOICES,
      evidence: 'structured-enable-thinking-template' };
  }
  return unknownTemplateCapability();
}

export function modelTemplateCapability(model?: Pick<LocalModelInfo, 'templateCapability'> | LocalTemplateCapability): LocalTemplateCapability {
  if (!model) return unknownTemplateCapability();
  const candidate = model as LocalTemplateCapability | Pick<LocalModelInfo, 'templateCapability'>;
  if ('templateCapability' in candidate) return candidate.templateCapability ?? unknownTemplateCapability();
  return 'status' in candidate && 'supported' in candidate ? candidate as LocalTemplateCapability : unknownTemplateCapability();
}

export function supportsLocalReasoning(capability: LocalTemplateCapability, choice: LocalReasoningChoice): boolean {
  return capability.supported.includes(choice);
}

export function reasoningError(): Error { return new Error('LOCAL_REASONING_UNSUPPORTED'); }
