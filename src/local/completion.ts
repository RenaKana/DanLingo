/** Collect native token events, but expose only a complete response to translation.
 * The final usage event may have empty choices; it must not erase finish_reason.
 */
export function localCompletionCollector(onGenerating: (active: boolean) => void = () => {}) {
  let content = '', reasoning = '', finishReason: string | undefined, metadata: Record<string, any> = {};
  return {
    onData(chunk: any) {
      if (!chunk || typeof chunk !== 'object') return;
      const choice = chunk.choices?.[0], delta = choice?.delta;
      if (typeof choice?.text === 'string') {
        if (choice.text) onGenerating(true);
        content += choice.text;
      }
      if (typeof delta?.content === 'string' || typeof delta?.reasoning_content === 'string') {
        onGenerating(true);
        content += typeof delta?.content === 'string' ? delta.content : '';
        reasoning += typeof delta?.reasoning_content === 'string' ? delta.reasoning_content : '';
      }
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
        finishReason = choice.finish_reason; onGenerating(false);
      }
      metadata = { ...metadata, ...chunk, usage: chunk.usage ?? metadata.usage, timings: chunk.timings ?? metadata.timings };
    },
    result() {
      if (!finishReason) throw new Error('LOCAL_INFERENCE_INCOMPLETE');
      return { ...metadata, object: 'chat.completion', choices: [{ index: 0, finish_reason: finishReason,
        message: { role: 'assistant', content, ...(reasoning ? { reasoning_content: reasoning } : {}) } }] };
    },
  };
}
