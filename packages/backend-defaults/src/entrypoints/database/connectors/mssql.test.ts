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

import { ConfigReader } from '@backstage/config';
import { JsonObject } from '@backstage/types';
import { TestDatabases, mockServices } from '@backstage/backend-test-utils';
import { Knex } from 'knex';
import { randomUUID } from 'node:crypto';
import { DatabaseManager } from '../DatabaseManager';
import { MssqlConnector, parseMssqlConnectionString } from './mssql';

jest.setTimeout(120_000);

describe('parseMssqlConnectionString', () => {
  it('decodes credentials and database names and configures encryption', () => {
    expect(
      parseMssqlConnectionString(
        'mssql://user%40example:p%40ss%3Aword@localhost:1434/my%20database',
      ),
    ).toEqual({
      server: 'localhost',
      port: 1434,
      userName: 'user@example',
      password: 'p@ss:word',
      database: 'my database',
      options: {
        encrypt: true,
        trustServerCertificate: false,
        lowerCaseGuids: true,
      },
    });
    expect(
      parseMssqlConnectionString(
        'mssql://user:password@localhost?encrypt=false&trustServerCertificate=true',
      ),
    ).toMatchObject({
      port: 1433,
      options: { encrypt: false, trustServerCertificate: true },
    });
    for (const value of [
      'postgres://user:private-password@localhost/db',
      'mssql://user:private-password@localhost/a/b',
      'mssql://user:private-password@localhost/db?encrypt=invalid',
      'mssql://user:private-password@localhost/db?trustServerCertificate=invalid',
    ]) {
      expect(() => parseMssqlConnectionString(value)).toThrow(
        'Invalid SQL Server connection string',
      );
      let caught: Error | undefined;
      try {
        parseMssqlConnectionString(value);
      } catch (error) {
        caught = error as Error;
      }
      expect(caught).toBeDefined();
      expect(String(caught)).not.toContain('private-password');
      expect(caught?.cause).toBeUndefined();
    }
  });
});

describe('MssqlConnector', () => {
  const databases = TestDatabases.create({ ids: ['MSSQL_2022'] });
  const deps = {
    logger: mockServices.logger.mock(),
    lifecycle: mockServices.lifecycle.mock(),
  };

  if (databases.supports('MSSQL_2022')) {
    it.each(databases.eachSupportedId())(
      'creates and isolates plugin databases and caches their clients, %p',
      async id => {
        const admin = await databases.init(id);
        const storedConnection = admin.client.config
          .connection as Knex.MsSqlConnectionConfig;
        const connection = JSON.parse(
          JSON.stringify({
            ...storedConnection,
            password: storedConnection.password,
          }),
        ) as JsonObject;
        const prefix = `connector_${randomUUID().replace(/-/g, '')}_`;
        const rootLifecycle = mockServices.rootLifecycle.mock();
        const manager = DatabaseManager.fromConfig(
          new ConfigReader({
            backend: {
              database: {
                client: 'mssql',
                connection,
                prefix,
                knexConfig: { pool: { max: 1 } },
                plugin: {
                  second: {
                    knexConfig: { pool: { max: 2 } },
                    connection: { options: { appName: 'backstage-test' } },
                  },
                },
              },
            },
          }),
          { rootLifecycle },
        );

        try {
          const service = manager.forPlugin('first', deps);
          const [first, cached] = await Promise.all([
            service.getClient(),
            service.getClient(),
          ]);
          const second = await manager.forPlugin('second', deps).getClient();
          expect(cached).toBe(first);
          expect(first.client.config.connection.database).toBe(
            `${prefix}first`,
          );
          expect(second.client.config.connection).toMatchObject({
            database: `${prefix}second`,
            options: {
              appName: 'backstage-test',
              encrypt: true,
              trustServerCertificate: true,
            },
          });
          expect(first.client.config.pool).toMatchObject({ min: 0, max: 1 });
          expect(second.client.config.pool).toMatchObject({ min: 0, max: 2 });
          await first.schema.createTable('records', table =>
            table.string('value'),
          );
          await second.schema.createTable('records', table =>
            table.string('value'),
          );
          await first('records').insert({ value: 'first' });
          await second('records').insert({ value: 'second' });
          await expect(first('records')).resolves.toEqual([{ value: 'first' }]);
          await expect(second('records')).resolves.toEqual([
            { value: 'second' },
          ]);
        } finally {
          for (const [hook] of rootLifecycle.addShutdownHook.mock.calls) {
            await hook();
          }
          for (const plugin of ['first', 'second']) {
            await admin.raw('IF DB_ID(?) IS NOT NULL DROP DATABASE ??', [
              `${prefix}${plugin}`,
              `${prefix}${plugin}`,
            ]);
          }
        }
      },
    );

    it.each(databases.eachSupportedId())(
      'uses an explicit existing database with a different base client, %p',
      async id => {
        const database = await databases.init(id);
        const storedConnection = database.client.config
          .connection as Knex.MsSqlConnectionConfig;
        const connection = JSON.parse(
          JSON.stringify({
            ...storedConnection,
            password: storedConnection.password,
          }),
        ) as JsonObject;
        const connector = new MssqlConnector(
          new ConfigReader({
            client: 'better-sqlite3',
            connection: ':memory:',
            plugin: {
              catalog: { client: 'mssql', connection, ensureExists: false },
            },
          }),
          'unused_',
        );
        const client = await connector.getClient('catalog', deps);
        try {
          await expect(client.raw('SELECT DB_NAME() as name')).resolves.toEqual(
            [{ name: connection.database }],
          );
        } finally {
          await client.destroy();
        }
      },
    );
  }

  it('rejects schema division and invalid database names before connecting', async () => {
    const schemaConnector = new MssqlConnector(
      new ConfigReader({
        client: 'mssql',
        connection: {},
        pluginDivisionMode: 'schema',
      }),
      'backstage_plugin_',
    );
    await expect(schemaConnector.getClient('catalog', deps)).rejects.toThrow(
      'does not support plugin division mode',
    );
    const invalidConnector = new MssqlConnector(
      new ConfigReader({
        client: 'mssql',
        connection: {},
      }),
      'x'.repeat(128),
    );
    await expect(invalidConnector.getClient('catalog', deps)).rejects.toThrow(
      'between 1 and 128',
    );
  });
});
