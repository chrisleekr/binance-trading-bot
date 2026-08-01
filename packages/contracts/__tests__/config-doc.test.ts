import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  renderSchemaWithPaths,
  renderDefault,
  stripEnabled,
  toConfigJsonSchema,
} from '@app/contracts';

// Mirror the generator: renderSchema(toConfigJsonSchema(SomeObjectSchema)).
// A flat object of scalar fields lands in the single "Core settings" table.
const render = (schema: z.ZodType): string =>
  renderSchemaWithPaths(toConfigJsonSchema(schema)).markdown;

// Table body rows start with a backtick field cell; the header ("| Setting")
// and separator ("| ---") rows do not.
const dataRows = (md: string): string[] => md.split('\n').filter((l) => /^\| `/.test(l));

/** The six cells of the single data row, trimmed. Fails loudly on 0 or 2+ rows. */
const onlyRow = (md: string): string[] => {
  const rows = dataRows(md);
  expect(rows).toHaveLength(1);
  return (rows[0] ?? '')
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
};

describe('config-doc render core', () => {
  it('C1: array-of-scalars default renders one [] row, no $item, not required', () => {
    const out = render(z.object({ tags: z.array(z.string()).default([]) }));
    const [setting, , , def] = onlyRow(out);
    // The array FIELD path is `tags` (the `$item` lives only on its element,
    // which must not surface as its own row).
    expect(setting).toBe('`tags`<br/>Tags');
    expect(def).toBe('`[]`');
    expect(out).not.toContain('$item');
    expect(out).not.toContain('_required_');
  });

  it('C2 (B1): a null supplied by a PARENT object default renders `null`, not —', () => {
    // The leaf `ceiling` carries no own default; the null lives only in the
    // parent object's whole-object default (collectSchemaDefaults takes a
    // property's `default` whole). So getByPath(defaults,'window.ceiling') ===
    // null while the leaf's f.defaultValue === undefined. The old
    // `?? f.defaultValue` treated the legitimate null as "missing" and fell
    // through to undefined → `—`. The fix distinguishes null (present) from
    // undefined (absent). Root-level defaults are not collected, so the null
    // must sit on a nested property, rendered as its own "Window" panel table.
    const out = render(
      z.object({
        window: z.object({ ceiling: z.number().nullable().optional() }).default({ ceiling: null }),
      }),
    );
    const [setting, , , def] = onlyRow(out);
    expect(setting).toBe('`window.ceiling`<br/>Ceiling');
    expect(def).toBe('`null`');
  });

  it('C3: a required field with no default renders _required_', () => {
    const [setting, , , def] = onlyRow(render(z.object({ symbol: z.string() })));
    expect(setting).toBe('`symbol`<br/>Symbol');
    expect(def).toBe('_required_');
  });

  it('C4: an enum field lists its options in the Values column', () => {
    const [, , values] = onlyRow(render(z.object({ mode: z.enum(['spot', 'margin']) })));
    expect(values).toBe('`spot`, `margin`');
  });

  it('C5: numeric bounds render inclusive and exclusive clauses in Values', () => {
    const [, , inclusive] = onlyRow(render(z.object({ size: z.number().min(1).max(10) })));
    expect(inclusive).toBe('number, min 1, max 10');
    // .gt()/.lt() map through to exclusiveMinimum/Maximum in the form builder.
    const [, , exclusive] = onlyRow(render(z.object({ ratio: z.number().gt(0).lt(1) })));
    expect(exclusive).toBe('number, > 0, < 1');
  });

  it('a boolean field advertises on / off rather than a bare type', () => {
    const [, , values] = onlyRow(render(z.object({ armed: z.boolean() })));
    expect(values).toBe('on / off');
  });

  it('C4/C5: an array-of-objects field flattens element fields into a panel', () => {
    const out = render(z.object({ levels: z.array(z.object({ pct: z.number() })).default([]) }));
    // The object element's leaves surface as `field[].leaf` rows under a panel
    // named for the array field, not an anonymous $item row.
    expect(out).toContain('**Levels**');
    const [setting, , , def] = onlyRow(out);
    expect(setting).toBe('`levels[].pct`<br/>Pct');
    expect(def).toBe('_required_');
    expect(out).not.toContain('$item');
  });

  it('an advanced field is tagged _(advanced)_', () => {
    const out = render(z.object({ x: z.number().describe('@ui:advanced How far') }));
    expect(out).toContain('How far _(advanced)_');
  });

  it('notes fill the guidance columns, keyed by the emitted field path', () => {
    const json = toConfigJsonSchema(z.object({ nested: z.object({ pct: z.number() }) }));
    const { markdown, paths } = renderSchemaWithPaths(json, {
      'nested.pct': { when: 'WHEN-TEXT', expect: 'EXPECT-TEXT' },
    });
    expect(paths).toEqual(['nested.pct']);
    const cells = onlyRow(markdown);
    expect(cells[4]).toBe('WHEN-TEXT');
    expect(cells[5]).toBe('EXPECT-TEXT');
  });

  it('a field with no note renders em-dashes, so the generator gate can see the gap', () => {
    const { markdown, paths } = renderSchemaWithPaths(
      toConfigJsonSchema(z.object({ pct: z.number() })),
    );
    expect(paths).toEqual(['pct']);
    const cells = onlyRow(markdown);
    expect(cells[4]).toBe('—');
    expect(cells[5]).toBe('—');
  });

  it('a note containing a pipe or newline cannot break the table row', () => {
    const { markdown } = renderSchemaWithPaths(toConfigJsonSchema(z.object({ pct: z.number() })), {
      pct: { when: 'a | b', expect: 'line one\nline two' },
    });
    // Asserted on the raw row: an escaped pipe is still a `|` character, so
    // splitting on `|` would hide the very escaping under test.
    const rows = dataRows(markdown);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('a \\| b');
    expect(rows[0]).toContain('line one line two');
    expect(
      markdown
        .trimEnd()
        .split('\n')
        .filter((l) => l.startsWith('|')),
    ).toHaveLength(3);
  });

  it('a backslash in a note is escaped before the pipe, so `\\|` cannot break the row', () => {
    const { markdown } = renderSchemaWithPaths(toConfigJsonSchema(z.object({ pct: z.number() })), {
      pct: { when: String.raw`a \| b`, expect: String.raw`C:\temp` },
    });
    const rows = dataRows(markdown);
    expect(rows).toHaveLength(1);
    // Escaping backslashes first turns the source `\|` into `\\` + `\|`: an
    // escaped backslash followed by an escaped pipe. Escaping the pipe first
    // would instead emit `\\|`, a literal backslash and a live pipe that
    // splits the cell.
    expect(rows[0]).toContain(String.raw`a \\\| b`);
    expect(rows[0]).toContain(String.raw`C:\\temp`);
    expect(
      markdown
        .trimEnd()
        .split('\n')
        .filter((l) => l.startsWith('|')),
    ).toHaveLength(3);
  });

  it('a bare @handle in a note is code-spanned so GitLab cannot link it to a user', () => {
    const { markdown } = renderSchemaWithPaths(toConfigJsonSchema(z.object({ pct: z.number() })), {
      pct: { when: 'Send /newbot to @BotFather.', expect: 'Message @userinfobot for your id.' },
    });
    const cells = onlyRow(markdown);
    expect(cells[4]).toBe('Send /newbot to `@BotFather`.');
    expect(cells[5]).toBe('Message `@userinfobot` for your id.');
  });

  it('an already code-spanned @handle is not wrapped twice', () => {
    const { markdown } = renderSchemaWithPaths(toConfigJsonSchema(z.object({ pct: z.number() })), {
      pct: { when: 'Ask `@BotFather`.', expect: 'An email addr@example.com is not a handle.' },
    });
    const cells = onlyRow(markdown);
    expect(cells[4]).toBe('Ask `@BotFather`.');
    expect(cells[5]).toBe('An email addr@example.com is not a handle.');
  });

  it('C6: the render core is a stateless, deterministic transform (safe to import)', () => {
    // The render module is pure — importing it (top of this file) runs no file
    // I/O. The generator's fs/argv side effects live in the script behind
    // `if (import.meta.main)`, so nothing here can write partials. Determinism +
    // no accumulated state is the observable purity contract.
    const json = toConfigJsonSchema(z.object({ symbol: z.string() }));
    expect(typeof renderSchemaWithPaths(json).markdown).toBe('string');
    expect(renderSchemaWithPaths(json).markdown).toBe(renderSchemaWithPaths(json).markdown);
  });

  it('stripEnabled removes the master `enabled` switch from properties and required', () => {
    const stripped = stripEnabled({
      properties: { enabled: { type: 'boolean' }, threshold: { type: 'number' } },
      required: ['enabled', 'threshold'],
    });
    expect(stripped['properties']).toEqual({ threshold: { type: 'number' } });
    expect(stripped['required']).toEqual(['threshold']);
  });

  it('renderDefault oracle: each branch of the default cell', () => {
    expect(renderDefault(undefined, true)).toBe('_required_');
    expect(renderDefault(undefined, false)).toBe('—');
    expect(renderDefault(null, false)).toBe('`null`');
    expect(renderDefault([], false)).toBe('`[]`');
    expect(renderDefault([1, 2], false)).toBe('`[1,2]`');
    expect(renderDefault({ a: 1 }, false)).toBe('—');
    expect(renderDefault('', false)).toBe('`""`');
    expect(renderDefault('spot', false)).toBe('`spot`');
    expect(renderDefault(5, false)).toBe('`5`');
  });
});
