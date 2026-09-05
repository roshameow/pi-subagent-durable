export function resolveDispatchConfig(agentModel, defaults = {}) {
  const inheritsParent = !agentModel;
  return {
    model: agentModel || defaults.model,
    thinkingLevel: inheritsParent ? defaults.thinkingLevel : undefined,
    contextWindow: inheritsParent ? defaults.contextWindow : undefined,
    inheritsParent,
  };
}
