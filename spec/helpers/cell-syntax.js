exports.inspect = (context) => {
  const root = context.getRootSyntaxNode();
  return {
    start: root.startPosition,
    hasError: root.hasError,
    children: root.namedChildCount,
    source: context.getText(),
    comments: root.descendantsOfType("comment").map((node) => node.text),
    assignments: root.descendantsOfType("assignment").length,
    layers: context.getLanguageLayers().map((layer) => ({
      scope: layer.scopeName,
      start: layer.rootNode?.startPosition,
      end: layer.rootNode?.endPosition,
    })),
  };
};
