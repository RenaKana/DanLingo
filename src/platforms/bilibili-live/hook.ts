/** Restore only a property we still own; preserve descriptor, receiver and native exceptions. */
export function hookMethod(owner: Record<string, any>, key: string, wrap: (original: Function) => Function) {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function' || descriptor.writable !== true) return null;
  const wrapper = wrap(descriptor.value);
  try { Object.defineProperty(owner, key, { ...descriptor, value: wrapper }); } catch { return null; }
  return {
    intact: () => owner[key] === wrapper,
    restore() { try { if (owner[key] !== wrapper) return false; Object.defineProperty(owner, key, descriptor); return true; } catch { return false; } },
  };
}

/** The site explicitly offers this optional synchronous observer; creating it adds no transport. */
export function optionalObserver(owner: Record<string, any>, key: string, wrap: (original: Function) => Function) {
  if (Object.getOwnPropertyDescriptor(owner, key)) return hookMethod(owner, key, wrap);
  if (key in owner || !Object.isExtensible(owner)) return null;
  const wrapper = wrap(() => undefined);
  try { Object.defineProperty(owner,key,{value:wrapper,writable:true,configurable:true,enumerable:true}); } catch { return null; }
  return { intact: () => owner[key] === wrapper, restore() { try { if(owner[key]!==wrapper)return false; return delete owner[key]; } catch { return false; } } };
}
