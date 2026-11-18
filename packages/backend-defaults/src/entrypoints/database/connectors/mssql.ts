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

import { LifecycleService, LoggerService } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import { InputError } from '@backstage/errors';
import { JsonObject } from '@backstage/types';
import knexFactory, { Knex } from 'knex';
import { omit } from 'lodash';
import limiterFactory from 'p-limit';
import { Connector } from '../types';
import { mergeDatabaseConfig } from './mergeDatabaseConfig';

const ddlLimiter = limiterFactory(1);

export function parseMssqlConnectionString(
  connectionString: string,
): Partial<Knex.MsSqlConnectionConfig> {
  try {
    const url = new URL(connectionString);
    if (
      url.protocol !== 'mssql:' ||
      !url.hostname ||
      !url.username ||
      !url.password ||
      (url.pathname && !/^\/[^/]*$/.test(url.pathname))
    ) {
      throw new Error('Invalid connection string');
    }

    const options = {
      encrypt: true,
      trustServerCertificate: false,
      lowerCaseGuids: true,
    };
    for (const name of ['encrypt', 'trustServerCertificate'] as const) {
      const value = url.searchParams.get(name);
      if (value !== null) {
        if (value !== 'true' && value !== 'false') {
          throw new Error('Invalid connection option');
        }
        options[name] = value === 'true';
      }
    }

    return {
      server: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port || 1433),
      userName: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      ...(url.pathname.slice(1) && {
        database: decodeURIComponent(url.pathname.slice(1)),
      }),
      options,
    };
  } catch {
    // URL parsing errors can include the password. Do not attach their cause.
    throw new InputError(
      'Invalid SQL Server connection string. Expected mssql://<user>:<password>@<host>:<port>/<database>, with true or false for encrypt and trustServerCertificate.',
    );
  }
}

function normalizeConnection(
  connection: JsonObject | string | undefined,
): Partial<Knex.MsSqlConnectionConfig> {
  if (connection === undefined) {
    return {};
  }
  return typeof connection === 'string'
    ? parseMssqlConnectionString(connection)
    : connection;
}

function validateDatabaseName(databaseName: string): void {
  if (
    !databaseName ||
    databaseName.length > 128 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f]/.test(databaseName)
  ) {
    throw new InputError(
      'SQL Server database names must contain between 1 and 128 characters and cannot contain control characters.',
    );
  }
}

export async function ensureMssqlDatabaseExists(
  knexConfig: Knex.Config,
  databaseName: string,
): Promise<void> {
  validateDatabaseName(databaseName);
  const admin = knexFactory(
    mergeDatabaseConfig(knexConfig, {
      connection: { database: 'master' },
      pool: { min: 0, max: 1, acquireTimeoutMillis: 10000 },
    }),
  );

  try {
    await ddlLimiter(async () => {
      const existing = await admin('sys.databases')
        .select('name')
        .where({ name: databaseName })
        .first();
      if (existing) {
        return;
      }

      try {
        // Escape the identifier explicitly; Knex removes brackets in MSSQL identifiers.
        const identifier = `[${databaseName.replace(/\]/g, ']]')}]`;
        await admin.raw(
          `CREATE DATABASE ${identifier} COLLATE Latin1_General_100_BIN2`,
        );
      } catch (error) {
        // Another backend process can create the database after the existence check.
        if ((error as { number?: number }).number !== 1801) {
          throw error;
        }
      }
    });
  } finally {
    await admin.destroy();
  }
}

export class MssqlConnector implements Connector {
  constructor(
    private readonly config: Config,
    private readonly prefix: string,
  ) {}

  async getClient(
    pluginId: string,
    _deps: { logger: LoggerService; lifecycle: LifecycleService },
  ): Promise<Knex> {
    const divisionMode =
      this.config.getOptionalString('pluginDivisionMode') ?? 'database';
    if (divisionMode !== 'database') {
      throw new InputError(
        `The SQL Server driver does not support plugin division mode '${divisionMode}'`,
      );
    }

    const pluginConfig = this.config.getOptionalConfig(`plugin.${pluginId}`);
    const overridden = this.config.getString('client') !== 'mssql';
    const baseConnection = overridden
      ? {}
      : omit(
          normalizeConnection(
            this.config.getOptional<JsonObject | string>('connection'),
          ),
          'database',
        );
    const connection = mergeDatabaseConfig(
      {
        options: {
          encrypt: true,
          trustServerCertificate: false,
          lowerCaseGuids: true,
        },
      },
      baseConnection,
      normalizeConnection(
        pluginConfig?.getOptional<JsonObject | string>('connection'),
      ),
    );
    connection.database ??= `${this.prefix}${pluginId}`;
    validateDatabaseName(connection.database);

    const knexConfig: Knex.Config = mergeDatabaseConfig(
      { pool: { min: 0 } },
      this.config.getOptional<JsonObject>('knexConfig'),
      pluginConfig?.getOptional<JsonObject>('knexConfig'),
      { client: 'mssql', connection },
    );
    const ensureExists =
      pluginConfig?.getOptionalBoolean('ensureExists') ??
      this.config.getOptionalBoolean('ensureExists') ??
      true;
    if (ensureExists) {
      await ensureMssqlDatabaseExists(knexConfig, connection.database);
    }

    return knexFactory(knexConfig);
  }
}
