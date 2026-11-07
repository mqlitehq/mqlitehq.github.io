// Build-time facts shared by HTML, machine-readable Markdown and agent prompts.
// Only the named placeholders are replaced; historical examples remain literal.
const component = '(?:0|[1-9]\\d*)';
const sourceVersionPattern = new RegExp(`^${component}\\.${component}\\.${component}$`);
const releasePattern = new RegExp(`^v${component}\\.${component}\\.${component}(?:-rc\\.${component})?$`);
const goVersionPattern = new RegExp(`^${component}\\.${component}(?:\\.${component})?$`);
const schemaTokenPattern = /^[A-Za-z0-9._-]+$/;

function version(value, pattern, field) {
  if (typeof value !== 'string' || value.trim() !== value || !pattern.test(value)) {
    throw new Error(`invalid ${field} fact`);
  }
  return value;
}

function decimal(value, field, minimum, maximum) {
  if ((typeof value !== 'string' && typeof value !== 'number') ||
      String(value).trim() !== String(value) || !/^(?:0|[1-9]\d*)$/.test(String(value)) ||
      !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`invalid ${field} fact`);
  }
  return String(value);
}

function count(value, field) {
  if (!Array.isArray(value)) throw new Error(`invalid ${field} fact: expected an array`);
  return String(value.length);
}

export function renderFacts(text, metadata, chinese = false) {
  if (typeof text !== 'string') throw new Error('fact template must be a string');
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('fact metadata must be an object');
  }
  if (typeof chinese !== 'boolean') throw new Error('fact locale flag must be boolean');
  const source = () => 'v' + version(metadata.sourceVersion, sourceVersionPattern, 'sourceVersion');
  const latest = () => version(metadata.latestRelease, releasePattern, 'latestRelease');
  const facts = new Map([
    ['SOURCE_VERSION', source],
    ['LATEST_RELEASE', latest],
    ['SOURCE_STATUS', () => {
      const currentSource = source(), currentRelease = latest();
      if (metadata.hasUnreleasedChanges !== undefined && typeof metadata.hasUnreleasedChanges !== 'boolean') {
        throw new Error('invalid hasUnreleasedChanges fact');
      }
      return metadata.hasUnreleasedChanges || currentRelease !== currentSource
        ? (chinese ? '（含未发布变更）' : ' with unreleased changes') : '';
    }],
    ['BROKER_PORT', () => decimal(metadata.brokerPort, 'brokerPort', 1, 65535)],
    ['SCHEMA_VERSION', () => version(metadata.schemaVersion, schemaTokenPattern, 'schemaVersion')],
    ['GO_VERSION', () => version(metadata.goVersion, goVersionPattern, 'goVersion')],
    ['TOOL_COUNT', () => count(metadata.mcpTools, 'mcpTools')],
    ['ROUTE_COUNT', () => count(metadata.routes, 'routes')],
    ['CLI_COUNT', () => count(metadata.cliCommands, 'cliCommands')],
  ]);
  return text.replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g, (_placeholder, name) => {
    const value = facts.get(name);
    if (!value) throw new Error(`unknown fact placeholder: ${name}`);
    return value();
  });
}
export function checkFactPair(english, translated, name = 'translation') {
  const placeholders = (text) => (text.match(/\{\{[A-Z_]+\}\}/g) ?? []).sort();
  if (JSON.stringify(placeholders(english)) !== JSON.stringify(placeholders(translated))) {
    throw new Error(`${name}: translated fact placeholders differ`);
  }
}

