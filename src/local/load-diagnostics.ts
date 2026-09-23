/** Keep only an error category, never retain native log text or user prompts. */
export function nativeLoadError(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  if (/chat template parsing error|Unable to generate parser for this template|Jinja Exception:/i.test(value)) return 'LOCAL_CHAT_TEMPLATE_UNSUPPORTED';
  if (/unknown model architecture|unknown architecture|unsupported architecture/i.test(value)) return 'LOCAL_NATIVE_UNSUPPORTED';
}
