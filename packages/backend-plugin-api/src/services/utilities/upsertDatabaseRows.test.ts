/*
 * Copyright 2026 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { TestDatabases } from '@backstage/backend-test-utils';
import { upsertDatabaseRows } from './upsertDatabaseRows';
import { getDatabaseNow, isDatabaseConflictError } from './database';

jest.setTimeout(120_000);

const databases = TestDatabases.create();

describe.each(databases.eachSupportedId())('upsertDatabaseRows, %p', id => {
  it('inserts, updates selected columns, ignores conflicts, and preserves defaults', async () => {
    const knex = await databases.init(id);
    await knex.schema.createTable('entries', table => {
      table.string('id').primary();
      table.string('value').notNullable();
      table.integer('version').notNullable().defaultTo(1);
    });
    const base = { knex, table: 'entries', conflictColumns: ['id'] };
    await upsertDatabaseRows({
      ...base,
      rows: [
        { id: 'a', value: 'first', version: undefined },
        { id: 'b', value: 'before', version: 3 },
      ],
    });
    await upsertDatabaseRows({
      ...base,
      rows: [
        { id: 'a', value: 'second', version: 2 },
        { id: 'b', value: 'new', version: 3 },
      ],
      update: ['value'],
    });
    await upsertDatabaseRows({
      ...base,
      rows: [{ id: 'a', value: 'ignored' }],
      ignore: true,
    });
    await expect(knex('entries').orderBy('id')).resolves.toEqual([
      { id: 'a', value: 'second', version: 1 },
      { id: 'b', value: 'new', version: 3 },
    ]);
    await upsertDatabaseRows({
      ...base,
      rows: [
        { id: 'c', value: 'first' },
        { id: 'c', value: 'duplicate' },
      ],
      ignore: true,
    });
    await expect(knex('entries').where({ id: 'c' }).first()).resolves.toEqual({
      id: 'c',
      value: 'first',
      version: 1,
    });
    if (!knex.client.config.client.includes('mysql')) {
      await upsertDatabaseRows({
        ...base,
        rows: [
          { id: 'a', value: 'updated' },
          { id: 'b', value: 'unchanged' },
        ],
        update: ['value'],
        where: knex.raw('?? = ?', ['entries.version', 1]),
      });
    }
    await expect(knex('entries').orderBy('id')).resolves.toEqual([
      {
        id: 'a',
        value: knex.client.config.client.includes('mysql')
          ? 'second'
          : 'updated',
        version: 1,
      },
      { id: 'b', value: 'new', version: 3 },
      { id: 'c', value: 'first', version: 1 },
    ]);
  });

  it('keeps concurrent writes to one key unique and rolls back caller transactions', async () => {
    const knex = await databases.init(id);
    await knex.schema.createTable('entries', table => {
      table.string('id').primary();
      table.string('value').notNullable();
    });
    const base = { knex, table: 'entries', conflictColumns: ['id'] };
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        upsertDatabaseRows({
          ...base,
          rows: [{ id: 'shared', value: `${index}` }],
        }),
      ),
    );
    await expect(
      knex('entries').count({ count: '*' }).first(),
    ).resolves.toEqual({ count: id.startsWith('POSTGRES') ? '1' : 1 });
    await expect(
      knex.transaction(async transaction => {
        await upsertDatabaseRows({
          ...base,
          knex: transaction,
          rows: [
            { id: 'shared', value: 'rolled-back' },
            { id: 'new', value: 'rolled-back' },
          ],
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await knex('entries').where({ id: 'new' })).toEqual([]);
    expect((await knex('entries').first()).value).not.toBe('rolled-back');
    const error = await knex('entries')
      .insert({ id: 'shared', value: 'duplicate' })
      .then(
        () => undefined,
        e => e,
      );
    expect(error).toBeDefined();
    expect(isDatabaseConflictError(error)).toBe(true);
  });
});

const describeWithMssql = databases.supports('MSSQL_2022')
  ? describe
  : describe.skip;
describeWithMssql('SQL Server parameter limits', () => {
  it('writes large batches with raw values atomically and uses UTC time', async () => {
    const knex = await databases.init('MSSQL_2022');
    const [{ now, utc }] = await knex.select({
      now: getDatabaseNow(knex),
      utc: knex.raw('SYSUTCDATETIME()'),
    });
    expect(Math.abs(now.getTime() - utc.getTime())).toBeLessThan(100);
    await knex.schema.createTable('entries', table => {
      table.string('id').primary();
      table.string('value').notNullable();
    });
    const rows = Array.from({ length: 2200 }, (_, index) => ({
      id: `${index}`,
      value: knex.raw('CONCAT(?, ?, ?)', ['v', 'al', 'ue']),
    }));
    await upsertDatabaseRows({
      knex,
      table: 'entries',
      rows,
      conflictColumns: ['id'],
    });
    expect(await knex('entries').count({ count: '*' }).first()).toEqual({
      count: 2200,
    });
    expect((await knex('entries').first()).value).toBe('value');
    await knex('entries').delete();
    const invalidRows = rows.map(row => ({
      ...row,
      value: row.id === '2199' ? null : row.value,
    }));
    await expect(
      upsertDatabaseRows({
        knex,
        table: 'entries',
        rows: invalidRows,
        conflictColumns: ['id'],
      }),
    ).rejects.toThrow();
    expect(await knex('entries').count({ count: '*' }).first()).toEqual({
      count: 0,
    });
  });
  it('updates nullable unique keys and ignores duplicate new keys', async () => {
    const knex = await databases.init('MSSQL_2022');
    await knex.schema.createTable('entries', table => {
      table.string('key').nullable();
      table.unique(['key'], { useConstraint: true });
      table.string('value').notNullable();
    });
    const base = { knex, table: 'entries', conflictColumns: ['key'] };
    await upsertDatabaseRows({
      ...base,
      rows: [
        { key: null, value: 'first' },
        { key: null, value: 'ignored' },
      ],
      ignore: true,
    });
    await upsertDatabaseRows({
      ...base,
      rows: [{ key: null, value: 'updated' }],
    });
    await expect(knex('entries')).resolves.toEqual([
      { key: null, value: 'updated' },
    ]);
  });
});
