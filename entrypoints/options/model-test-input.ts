/** Keep a visible sample separate from the user's saved test text. */
export function mountModelTestInput(input: HTMLTextAreaElement, options: {
  sample: () => string;
  load: () => Promise<unknown>;
  save: (text: string) => Promise<unknown>;
  error: (error: unknown) => void;
}) {
  let custom = '', displayed = '', edited = false, composing = false, pendingEdit = false;
  let saving = Promise.resolve();
  const sync = () => {
    if (composing) return;
    let sample = '';
    if (!custom) {
      // Unsupported or identical language pairs keep the existing test validation.
      try { sample = options.sample(); } catch { /* A custom source is required. */ }
    }
    displayed = custom || sample;
    if (input.value !== displayed) input.value = displayed;
    input.dataset.defaultSample = String(!custom);
  };
  const selectSample = () => { if (!custom) input.select(); };
  input.addEventListener('focus', selectSample);
  input.addEventListener('beforeinput', () => {
    pendingEdit = true;
    if (!composing) selectSample();
  });
  input.addEventListener('compositionstart', () => { selectSample(); composing = true; });
  const update = () => {
    if (composing) return;
    // A multiline insertion can emit more input events after we restore the sample.
    if (!pendingEdit && input.value === displayed) return;
    pendingEdit = false;
    edited = true;
    custom = input.value.trim() ? input.value : '';
    sync();
    if (!custom) selectSample();
    const saved = custom;
    saving = saving.then(() => options.save(saved)).then(() => {}, options.error);
  };
  input.addEventListener('input', update);
  input.addEventListener('compositionend', () => { composing = false; update(); });
  sync();
  const ready = options.load().then(value => {
    if (edited || composing) return;
    custom = typeof value === 'string' && value.trim() ? value : '';
    sync();
  }).catch(options.error);
  return { sync, ready };
}
