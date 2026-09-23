import type { LocalModelInfo, LocalReasoningChoice, LocalRuntimeConfig, LocalReasoningValue, LocalTemplateCapability } from './types.ts';
import { modelTemplateCapability, reasoningError, supportsLocalReasoning } from './reasoning.ts';

type GenerationModel = Pick<LocalModelInfo, 'templateCapability'> | LocalTemplateCapability;

/** Per-request template policy; explicit effort needs a verified template capability. */
export function localGenerationOptions(runtime: LocalRuntimeConfig, body: { strategy?: unknown; max_tokens?: unknown; cache_prompt?: unknown }, model?: GenerationModel) {
  const strategy = body.strategy === 'superchat' ? 'superchat' : body.strategy === 'manual' ? 'manual' : 'normal';
  const capability = modelTemplateCapability(model);
  const configured = runtime.superChatReasoning;
  let reasoning: LocalReasoningValue = false;
  let chatTemplateKwargs: Record<string, unknown> | undefined;
  if (strategy === 'superchat') {
    if (configured === 'auto') reasoning = 'auto';
    else {
      if (!supportsLocalReasoning(capability, configured)) throw reasoningError();
      if (capability.mode === 'effort') {
        if ((configured === 'off' || configured === 'on') && capability.booleanArgument) {
          reasoning = configured === 'on';
          chatTemplateKwargs = { [capability.booleanArgument]: configured === 'on' };
        } else {
          reasoning = configured;
          chatTemplateKwargs = { [capability.argument]: configured };
        }
      } else if (capability.mode !== 'none') {
        reasoning = configured === 'on';
        chatTemplateKwargs = { enable_thinking: configured === 'on' };
      }
    }
  } else if (capability.mode === 'effort') {
    if (capability.booleanArgument) chatTemplateKwargs = { [capability.booleanArgument]: false };
    else if (supportsLocalReasoning(capability, 'off')) chatTemplateKwargs = { [capability.argument]: 'off' };
    else reasoning = 'auto'; // No ordinary-message off control exists: keep the model's intrinsic default.
  } else if (capability.mode !== 'none') {
    chatTemplateKwargs = { enable_thinking: false };
  } else if (!supportsLocalReasoning(capability, 'off')) {
    reasoning = 'auto'; // Raw PPO completion can reason; there is no template switch to disable it.
  }
  const configuredLimit = strategy === 'normal' ? runtime.normalMaxTokens : strategy === 'superchat' ? runtime.superChatMaxTokens : runtime.manualMaxTokens;
  const limit = Math.max(1, Math.floor(configuredLimit));
  const requested = typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens) && body.max_tokens >= 0 ? body.max_tokens : limit;
  const maxTokens = Math.min(limit, Math.max(1, Math.floor(requested)));
  return { reasoning, maxTokens, options: {
    temperature: runtime.temperature, max_tokens: maxTokens, cache_prompt: runtime.reusePromptCache === true && body.cache_prompt !== false, timings_per_token: true,
    // Auto omits the key so the model's default remains intact.
    ...(reasoning === 'auto' ? {} : { chat_template_kwargs: chatTemplateKwargs }),
  } };
}
