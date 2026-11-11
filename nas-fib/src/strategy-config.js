import { readFile } from 'node:fs/promises';

function validateShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('strategy config root must be an object');
  }
  for (const field of ['fallbackGroups', 'chainGroups']) {
    if (value[field] !== undefined && !Array.isArray(value[field])) {
      throw new Error(`strategy config ${field} must be an array`);
    }
  }
}

export function createStrategyConfigLoader({
  configPath,
  fallback = {},
  validate,
  onReload = () => {},
  onError = () => {}
}) {
  let lastGood = fallback;
  let acceptedText = null;
  let rejectedText = null;

  async function load(context, strict = false) {
    let text;
    try {
      text = await readFile(configPath, 'utf8');
      if (text === rejectedText && !strict) return lastGood;

      const parsed = text === acceptedText ? lastGood : JSON.parse(text);
      validateShape(parsed);
      if (typeof validate === 'function') await validate(parsed, context);

      if (text !== acceptedText) {
        lastGood = parsed;
        acceptedText = text;
        rejectedText = null;
        onReload(configPath);
      }
      return lastGood;
    } catch (error) {
      if (strict) throw error;
      if (text !== rejectedText) {
        rejectedText = text;
        onError(error, configPath);
      }
      return lastGood;
    }
  }

  return {
    load: (context) => load(context, false),
    loadStrict: (context) => load(context, true)
  };
}
