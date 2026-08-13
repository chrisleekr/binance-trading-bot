import { createHash } from 'node:crypto';

export interface V8IgnoreDirective {
  readonly affectedSourceFingerprint: string;
  readonly kind: string;
  readonly location: string;
  readonly reason: string;
}

interface DirectiveMatch {
  readonly end: number;
  readonly kind: string;
  readonly reason: string;
  readonly start: number;
}

const DIRECTIVE_PATTERN =
  /\/\*\s*v8\s+ignore\s+(file|if|else|next(?:\s+\d+)?|start|stop)\b([\s\S]*?)\*\//g;

const normalize = (value: string): string => value.trim().replace(/\s+/g, ' ');

const fingerprint = (value: string): string =>
  createHash('sha256').update(normalize(value)).digest('hex').slice(0, 16);

export const scanV8IgnoreSource = (source: string): V8IgnoreDirective[] => {
  const matches: DirectiveMatch[] = [...source.matchAll(DIRECTIVE_PATTERN)].map((match) => ({
    end: match.index + match[0].length,
    kind: match[1]!,
    reason: normalize(/--\s*reason:\s*(.+)/s.exec(match[2] ?? '')?.[1] ?? ''),
    start: match.index,
  }));

  return matches.map((match, index) => {
    const before = source.slice(0, match.start);
    const line = before.split(/\r?\n/).length;
    const column = before.length - Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r'));
    let affectedSource = '';
    if (match.kind === 'file') {
      affectedSource = source.replace(DIRECTIVE_PATTERN, '');
    } else if (match.kind === 'start') {
      const stop = matches.slice(index + 1).find((candidate) => candidate.kind === 'stop');
      affectedSource = source.slice(match.end, stop?.start ?? source.length);
    } else if (match.kind === 'stop') {
      const start = matches.slice(0, index).findLast((candidate) => candidate.kind === 'start');
      affectedSource = source.slice(start?.end ?? 0, match.start);
    } else {
      affectedSource = source;
    }
    return {
      affectedSourceFingerprint: fingerprint(affectedSource),
      kind: match.kind,
      location: `${line}:${column}`,
      reason: match.reason,
    };
  });
};

export const v8IgnoreIdentityDigest = (directives: readonly V8IgnoreDirective[]): string =>
  createHash('sha256')
    .update(
      directives
        .map(
          ({ affectedSourceFingerprint, kind, location }) =>
            `${location}|${kind}|${affectedSourceFingerprint}`,
        )
        .join('\n'),
    )
    .digest('hex')
    .slice(0, 16);
