// 配置路由只是身份标识；不透明别名只采用目录明确提供的名称，不解码或猜测哈希。
export function isReadableModelName(value) {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 100 &&
    !/[\p{C}<>/\\]/u.test(value) &&
    !/^[a-f\d-]{24,}$/i.test(value)
  );
}

/** 优先采用宿主明确提供的可读名称；不解码不透明路由别名，也不猜型号。 */
export function modelDisplayName(model, names = {}) {
  const mapped =
    names &&
    typeof names === 'object' &&
    !Array.isArray(names) &&
    typeof model?.id === 'string' &&
    Object.hasOwn(names, model.id)
      ? names[model.id]
      : null;
  const explicit = [model?.displayName, mapped].find(isReadableModelName);
  let label = explicit;
  if (!label && typeof model?.id === 'string' && !model.id.startsWith('api-subagents/')) {
    const parts = model.id.split('/');
    const candidate = parts.length <= 2 ? parts.at(-1) : null;
    if (isReadableModelName(candidate)) label = candidate;
  }
  if (!label)
    return { label: '未确认', title: '客户端未提供可读模型名称；内部路由标识不作为模型名展示。' };
  return {
    label,
    title:
      model?.basis === 'configured'
        ? '来自会话配置中的模型名称，并非请求级实际执行型号的遥测。'
        : '客户端提供的模型名称。',
  };
}
