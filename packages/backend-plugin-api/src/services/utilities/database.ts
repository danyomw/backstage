/*
 * Copyright 2021 The Backstage Authors
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

import { isError } from '@backstage/errors';
import { Knex } from 'knex';

/**
 * Gets a SQL expression for the current database time.
 *
 * @remarks
 * Uses UTC on Microsoft SQL Server, where `CURRENT_TIMESTAMP` uses the
 * server's local time. This lets plugins compare database timestamps with
 * dates supplied in UTC. Other clients use Knex's current time expression.
 *
 * @public
 * @param knex - The database client or transaction.
 * @returns An expression that can be used in queries and column defaults.
 */
export function getDatabaseNow(knex: Knex | Knex.Transaction): Knex.Raw {
  return knex.client.config.client === 'mssql'
    ? knex.raw('SYSUTCDATETIME()')
    : knex.fn.now();
}

/**
 * Tries to deduce whether a thrown error is a database conflict.
 *
 * PostgreSQL unique constraint violations are detected by their SQLSTATE code,
 * since PostgreSQL localizes error messages based on the database
 * configuration. SQL Server conflicts are detected by error numbers 2601 and 2627.
 *
 * @public
 * @param e - A thrown error
 * @returns True if the error looks like it was a conflict error thrown by a
 *          known database engine
 */
export function isDatabaseConflictError(e: unknown) {
  const code =
    typeof e === 'object' && e !== null
      ? (e as { code?: unknown }).code
      : undefined;

  if (typeof code === 'string' && code === '23505') {
    return true;
  }

  if (typeof e === 'object' && e !== null) {
    const number = (e as { number?: unknown }).number;
    if (number === 2601 || number === 2627) {
      return true;
    }
    const errors = (e as { errors?: unknown }).errors;
    if (
      Array.isArray(errors) &&
      errors.some(error => {
        const nestedNumber =
          typeof error === 'object' && error !== null
            ? (error as { number?: unknown }).number
            : undefined;
        return nestedNumber === 2601 || nestedNumber === 2627;
      })
    ) {
      return true;
    }
  }

  const message = isError(e) ? e.message : undefined;

  return (
    typeof message === 'string' &&
    (/SQLITE_CONSTRAINT(?:_UNIQUE)?: UNIQUE/.test(message) ||
      /UNIQUE constraint failed:/.test(message) ||
      /unique constraint/.test(message) ||
      /Duplicate entry/.test(message)) // MySQL uniqueness error msg
  );
}
