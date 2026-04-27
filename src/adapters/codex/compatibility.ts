type KnownBadCodexVersion = {
  pattern: RegExp;
  reason: string;
};

const knownBadVersions: KnownBadCodexVersion[] = [];

export function codexCompatibilityWarning(codexVersion: string | null): string | undefined {
  if (!codexVersion) {
    return undefined;
  }

  const knownBad = knownBadVersions.find(({ pattern }) => pattern.test(codexVersion));
  if (!knownBad) {
    return undefined;
  }

  return `[agent-lingo] warning: ${knownBad.reason} Current Codex version: ${codexVersion}`;
}
