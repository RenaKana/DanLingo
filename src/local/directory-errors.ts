export function directoryErrorMessage(error: unknown): string {
  const code = error instanceof Error && ['NotAllowedError', 'SecurityError'].includes(error.name)
    ? 'LOCAL_DIRECTORY_PERMISSION_REQUIRED'
    : error instanceof Error ? error.message : String(error ?? '');
  const labels: Record<string, string> = {
    LOCAL_DIRECTORY_PERMISSION_REQUIRED: '需要重新授权模型来源的读取权限',
    LOCAL_FILE_HANDLE_UNSUPPORTED: '当前浏览器不支持模型文件直读，请使用受支持的 Chrome 或 Edge',
    LOCAL_FORMAT_UNSUPPORTED: '只支持 GGUF 模型文件',
    LOCAL_DIRECTORY_NOT_FOUND: '文件夹已移除，请重新添加',
    LOCAL_DIRECTORY_MISSING: '文件夹暂时不可用，请检查磁盘或重新授权',
    LOCAL_DIRECTORY_OVERLAP: '该文件夹与已登记的文件夹重叠，请调整后再添加',
    LOCAL_DIRECTORY_MANAGED: '此模型来自文件夹，请通过文件夹管理移除引用',
    LOCAL_SOURCE_CHANGED: '原文件已变化，请刷新模型列表后重新选用',
    LOCAL_SOURCE_MISSING: '原文件已不存在，请刷新模型列表',
    LOCAL_DIRECTORY_SCAN_FAILED: '扫描未完成，保留上次模型列表，请重试',
    LOCAL_DIRECTORY_SCAN_CONFLICT: '文件夹已更新，本次扫描结果未覆盖新状态，请刷新',
    LOCAL_DIRECTORY_REVISION_CONFLICT: '文件夹已更新，本次扫描结果未覆盖新状态，请刷新',
    LOCAL_DIRECTORY_ENUMERATION_FAILED: '未能读取完整目录，保留上次列表，请检查文件夹后重试',
    LOCAL_DIRECTORY_FILE_UNREADABLE: '文件暂时无法读取，请检查读取权限或占用情况',
    LOCAL_DIRECTORY_FILE_MISSING: '原文件已不存在，请刷新模型列表',
    LOCAL_DIRECTORY_MODEL_CHANGED: '原文件已变化，请刷新模型列表后重新选用',
    LOCAL_DIRECTORY_MODEL_INVALID: '无法识别此模型，请检查 GGUF 格式和分片',
    LOCAL_DIRECTORY_SOURCE_INVALID: '模型引用无效，请刷新文件夹',
    LOCAL_DIRECTORY_HANDLE_UNSUPPORTED: '当前浏览器无法保存文件夹访问权限',
    LOCAL_DIRECTORY_PERMISSION_UNAVAILABLE: '无法检查文件夹读取权限，请重新授权',
    LOCAL_DIRECTORY_OVERLAP_CHECK_FAILED: '无法确认文件夹是否重叠，请先重新授权已有文件夹',
    LOCAL_DIRECTORY_SCAN_CANCELLED: '已取消扫描，保留上次完整列表',
    LOCAL_SCAN_CANCELLED: '已取消扫描，保留上次完整列表',
    LOCAL_DIRECTORY_UNSUPPORTED: '当前浏览器不支持文件夹直读，请使用受支持的 Chrome 或 Edge',
    LOCAL_SHARD_SET_INCOMPLETE: '模型分片不完整', LOCAL_SHARD_MIXED: '分片不属于同一组模型',
    LOCAL_SHARD_METADATA_MISSING: '无法确认分片组，请保留标准分片文件名',
    LOCAL_SELECT_SINGLE_COMPLETE_GGUF: '无法识别该模型的完整分片组',
    LOCAL_NOT_GGUF: '不是有效的 GGUF 文件', LOCAL_GGUF_HEADER_INVALID_OR_TOO_LARGE: 'GGUF 文件头无效或超过安全解析范围',
    LOCAL_CHAT_TEMPLATE_MISSING: '模型缺少聊天模板', LOCAL_TOKENIZER_MISSING: '模型缺少 tokenizer 或词表',
    LOCAL_NLLB_UNSUPPORTED: '当前本地引擎不支持 NLLB/mBART，无法加载此模型',
    LOCAL_VOCAB_ONLY: '这是词表文件，不含模型权重，请选择完整模型',
    LOCAL_STORAGE_UNAVAILABLE: '模型索引暂时不可用，请关闭其他旧设置页后重试',
  };
  return labels[code] ?? (/^LOCAL_[A-Z0-9_]+$/.test(code) ? `操作未完成（${code}）` : '操作未完成，请重试');
}
