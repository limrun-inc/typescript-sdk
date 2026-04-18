import { Flags } from '@oclif/core';
import type { AndroidElementTarget, AndroidSelector } from '@limrun/api';

type SelectorFlagValues = {
  'resource-id'?: string;
  text?: string;
  'content-desc'?: string;
  'class-name'?: string;
  'package-name'?: string;
  index?: number;
  clickable?: boolean;
  enabled?: boolean;
  focused?: boolean;
  'bounds-contains-x'?: number;
  'bounds-contains-y'?: number;
};

type TargetFlagValues = SelectorFlagValues & {
  x?: number;
  y?: number;
};

export const androidSelectorFlags = {
  'resource-id': Flags.string({
    description: 'Match by `resourceId`, such as com.example:id/submit.',
  }),
  text: Flags.string({ description: 'Match by visible `text` using an exact match.' }),
  'content-desc': Flags.string({
    description: 'Match by `contentDesc` using an exact match.',
  }),
  'class-name': Flags.string({
    description: 'Match by `className`, such as android.widget.Button.',
  }),
  'package-name': Flags.string({
    description: 'Match by `packageName`, such as com.example.app.',
  }),
  index: Flags.integer({
    description: 'Match by child `index`.',
  }),
  clickable: Flags.boolean({
    description: 'Match by `clickable=true` or `clickable=false`.',
    allowNo: true,
  }),
  enabled: Flags.boolean({
    description: 'Match by `enabled=true` or `enabled=false`.',
    allowNo: true,
  }),
  focused: Flags.boolean({
    description: 'Match by `focused=true` or `focused=false`.',
    allowNo: true,
  }),
  'bounds-contains-x': Flags.integer({
    description: 'Match by `boundsContains.x`. Use together with `--bounds-contains-y`.',
  }),
  'bounds-contains-y': Flags.integer({
    description: 'Match by `boundsContains.y`. Use together with `--bounds-contains-x`.',
  }),
};

export const androidTargetFlags = {
  ...androidSelectorFlags,
  x: Flags.integer({
    description: 'Target a specific X coordinate instead of matching an element selector. Use with `--y`.',
  }),
  y: Flags.integer({
    description: 'Target a specific Y coordinate instead of matching an element selector. Use with `--x`.',
  }),
};

export function buildAndroidSelector(flags: SelectorFlagValues): AndroidSelector | undefined {
  const selector: AndroidSelector = {};

  if (flags['resource-id']) selector.resourceId = flags['resource-id'];
  if (flags.text) selector.text = flags.text;
  if (flags['content-desc']) selector.contentDesc = flags['content-desc'];
  if (flags['class-name']) selector.className = flags['class-name'];
  if (flags['package-name']) selector.packageName = flags['package-name'];
  if (flags.index !== undefined) selector.index = flags.index;
  if (flags.clickable !== undefined) selector.clickable = flags.clickable;
  if (flags.enabled !== undefined) selector.enabled = flags.enabled;
  if (flags.focused !== undefined) selector.focused = flags.focused;

  const hasBoundsX = flags['bounds-contains-x'] !== undefined;
  const hasBoundsY = flags['bounds-contains-y'] !== undefined;
  if (hasBoundsX !== hasBoundsY) {
    throw new Error('Use both --bounds-contains-x and --bounds-contains-y together.');
  }
  if (hasBoundsX && hasBoundsY) {
    selector.boundsContains = {
      x: flags['bounds-contains-x']!,
      y: flags['bounds-contains-y']!,
    };
  }

  return Object.keys(selector).length > 0 ? selector : undefined;
}

export function buildAndroidTarget(flags: TargetFlagValues): AndroidElementTarget | undefined {
  const selector = buildAndroidSelector(flags);
  const hasX = flags.x !== undefined;
  const hasY = flags.y !== undefined;

  if (hasX !== hasY) {
    throw new Error('Use both --x and --y together.');
  }
  if (selector && (hasX || hasY)) {
    throw new Error('Provide either selector flags or both --x and --y, not both.');
  }
  if (selector) {
    return { selector };
  }
  if (hasX && hasY) {
    return { x: flags.x, y: flags.y };
  }

  return undefined;
}
