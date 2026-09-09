import { modelFamily } from './model.js';

export const ROUTING_PROVIDERS = [
  { provider: 'anthropic', label: 'Claude', models: [
    { label: 'Opus', model: 'claude-opus-5' },
    { label: 'Sonnet', model: 'claude-sonnet-4-6' },
    { label: 'Haiku', model: 'claude-haiku-4-5' },
    { label: 'Fable', model: 'claude-fable-5-1' },
  ] },
  { provider: 'codex', label: 'Codex', models: [{ label: 'General', model: 'gpt-6-astra' }] },
];

export function patternPreviews(pattern) {
  const model = pattern.replace(/\*/g, '') || 'model';
  const providers = /^claude-/i.test(model) || modelFamily(model) !== 'other' ? ['anthropic']
    : /^(gpt-|o\d(?:-|$))|codex/i.test(model) ? ['codex'] : ['anthropic', 'codex'];
  return providers.map(provider => ({ provider, model, label: pattern }));
}
