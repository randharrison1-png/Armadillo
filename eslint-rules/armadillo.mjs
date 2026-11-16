import { findDisallowedSpacing } from './spacing-classes.mjs';

const spacingScale = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      offScale: 'Spacing class "{{cls}}" is off the 4/8/16/24 scale. Use 1, 2, 4 or 6 (no arbitrary values).',
    },
  },
  create(context) {
    function check(node, text) {
      for (const cls of findDisallowedSpacing(text)) {
        context.report({ node, messageId: 'offScale', data: { cls } });
      }
    }
    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};

const plugin = { rules: { 'spacing-scale': spacingScale } };

export default plugin;
