import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(HERE, '..', 'docker-entrypoint.sh'), 'utf8');
const scaleCompose = readFileSync(
  resolve(HERE, '..', '..', '..', 'deploy', 'compose', 'docker-compose.scale.yml'),
  'utf8',
);

describe('split-role migration startup', () => {
  it('runs the migrator before the application command', () => {
    const migrateCommand = /^\s*bun \/app\/dist\/migrate\.js\s*$/m.exec(entrypoint);
    expect(migrateCommand).not.toBeNull();
    expect(migrateCommand?.index).toBeLessThan(entrypoint.indexOf('exec "$@"'));
  });

  it('does not opt worker or study out of the advisory-locked migrator', () => {
    expect(scaleCompose).toContain('ROLE: api');
    expect(scaleCompose).toContain('ROLE: worker');
    expect(scaleCompose).toContain('ROLE: study');
    expect(scaleCompose).not.toContain('SKIP_MIGRATIONS:');
  });
});
