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

import { InputError } from '@backstage/errors';
import { Knex } from 'knex';

/**
 * Options for {@link upsertDatabaseRows}.
 *
 * @public
 */
export type DatabaseUpsertOptions = {
  /** The database client, or the transaction that owns the writes. */
  knex: Knex | Knex.Transaction;
  /** The table to write to. */
  table: string;
  /** The rows to insert. Undefined properties use the column's default. */
  rows: Array<Record<string, unknown>>;
  /** Columns that identify an existing row through a unique constraint. */
  conflictColumns: string[];
  /** Columns or values to update. Defaults to all inserted columns. */
  update?: string[] | Record<string, unknown>;
  /** Leave existing rows unchanged instead of updating them. */
  ignore?: boolean;
  /** An update condition, supported by PostgreSQL, SQLite, and SQL Server. */
  where?: Knex.Raw;
};

/**
 * Inserts rows, updating or ignoring rows that already exist.
 *
 * @remarks
 * Supports PostgreSQL, MySQL, SQLite, and Microsoft SQL Server. SQL Server
 * writes hold key range locks to prevent concurrent inserts for the same key.
 * Large SQL Server writes are split to stay within the parameter limit and
 * run in one transaction. An existing transaction remains owned by the caller.
 *
 * @public
 * @param options - The database, rows, and conflict behavior.
 */
export async function upsertDatabaseRows(
  options: DatabaseUpsertOptions,
): Promise<void> {
  if (options.rows.length === 0) {
    return;
  }
  if (options.conflictColumns.length === 0) {
    throw new InputError('At least one conflict column is required');
  }

  const { knex, table, conflictColumns, update, ignore, where } = options;
  const rows = options.rows.map(row =>
    Object.fromEntries(
      Object.entries(row).filter(([, value]) => value !== undefined),
    ),
  );
  // Separate column sets so that omitted values retain their database defaults.
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const columns = Object.keys(row)
      .filter(key => row[key] !== undefined)
      .sort();
    if (!conflictColumns.every(column => columns.includes(column))) {
      throw new InputError('Every row must provide all conflict columns');
    }
    const key = JSON.stringify(columns);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  if (knex.client.config.client !== 'mssql') {
    const execute = async (client: Knex | Knex.Transaction) => {
      for (const group of groups.values()) {
        const insert = client(table).insert(group).onConflict(conflictColumns);
        if (ignore) {
          await insert.ignore();
        } else {
          const query = update ? insert.merge(update) : insert.merge();
          if (where) query.where(where);
          await query;
        }
      }
    };
    if (groups.size > 1 && !knex.isTransaction) {
      await knex.transaction(execute);
    } else {
      await execute(knex);
    }
    return;
  }

  const createQuery = (
    columns: string[],
    batch: Array<Record<string, unknown>>,
  ) => {
    const orderColumn = columns.reduce(
      (name, column) => (name === column ? `${name}_` : name),
      '__backstage_upsert_order',
    );
    const rankColumn = columns.reduce(
      (name, column) => (name === column ? `${name}_` : name),
      '__backstage_upsert_rank',
    );
    const values = batch.map((row, index) =>
      knex.raw(
        `(${ignore ? `${index}, ` : ''}${columns.map(() => '?').join(', ')})`,
        columns.map(column => row[column]) as Knex.RawBinding[],
      ),
    );
    // An ignored insert can contain the same new key more than once.
    const source = ignore
      ? knex.raw(
          `SELECT ${columns.map(() => '??').join(', ')} FROM (
              SELECT ${columns.map(() => '??').join(', ')},
                ROW_NUMBER() OVER (PARTITION BY ${conflictColumns
                  .map(() => '??')
                  .join(', ')} ORDER BY ??) AS ??
              FROM (VALUES ${values.map(() => '?').join(', ')})
                AS input (??, ${columns.map(() => '??').join(', ')})
            ) AS ranked WHERE ?? = 1`,
          [
            ...columns,
            ...columns,
            ...conflictColumns,
            orderColumn,
            rankColumn,
            ...values,
            orderColumn,
            ...columns,
            rankColumn,
          ],
        )
      : knex.raw(
          `SELECT * FROM (VALUES ${values.map(() => '?').join(', ')})
              AS input (${columns.map(() => '??').join(', ')})`,
          [...values, ...columns],
        );
    const assignments =
      Array.isArray(update) || update === undefined
        ? (update ?? columns).map(column =>
            knex.raw('?? = ??', [column, `excluded.${column}`]),
          )
        : Object.entries(update)
            .filter(([, value]) => value !== undefined)
            .map(([column, value]) =>
              knex.raw('?? = ?', [column, value as Knex.RawBinding]),
            );
    const match = conflictColumns.map(column =>
      knex.raw('(?? = ?? OR (?? IS NULL AND ?? IS NULL))', [
        `${table}.${column}`,
        `excluded.${column}`,
        `${table}.${column}`,
        `excluded.${column}`,
      ]),
    );
    const hasUpdate = !ignore && assignments.length > 0;
    const updateSql = hasUpdate
      ? knex.raw(
          `WHEN MATCHED${where ? ' AND (?)' : ''} THEN UPDATE SET ${assignments
            .map(() => '?')
            .join(', ')}`,
          [...(where ? [where] : []), ...assignments],
        )
      : undefined;

    return knex.raw(
      `MERGE INTO ?? WITH (HOLDLOCK) USING (?) AS excluded
        ON ${match.map(() => '?').join(' AND ')} ${
        hasUpdate ? '?' : ''
      } WHEN NOT MATCHED THEN INSERT (${columns
        .map(() => '??')
        .join(', ')}) VALUES (${columns.map(() => '??').join(', ')});`,
      [
        table,
        source,
        ...match,
        ...(updateSql ? [updateSql] : []),
        ...columns,
        ...columns.map(column => `excluded.${column}`),
      ],
    );
  };

  const queries: Array<{ sql: string; bindings: readonly Knex.Value[] }> = [];
  const addBatch = (
    columns: string[],
    batch: Array<Record<string, unknown>>,
  ) => {
    const query = createQuery(columns, batch).toSQL();
    // Count bindings in raw values and update conditions as well as row values.
    if (query.bindings.length > 2000) {
      if (batch.length === 1) {
        throw new InputError('A row exceeds the SQL Server parameter limit');
      }
      const middle = Math.floor(batch.length / 2);
      addBatch(columns, batch.slice(0, middle));
      addBatch(columns, batch.slice(middle));
    } else {
      queries.push(query);
    }
  };
  for (const [key, group] of groups) {
    const columns: string[] = JSON.parse(key);
    const batchSize = Math.max(1, Math.floor(2000 / columns.length));
    for (let offset = 0; offset < group.length; offset += batchSize) {
      addBatch(columns, group.slice(offset, offset + batchSize));
    }
  }

  const execute = async (client: Knex | Knex.Transaction) => {
    for (const query of queries) {
      await client.raw(query.sql, query.bindings);
    }
  };

  if (queries.length > 1 && !knex.isTransaction) {
    await knex.transaction(execute);
  } else {
    await execute(knex);
  }
}
