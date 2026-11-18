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

import knexFactory from 'knex';
import { randomUUID } from 'node:crypto';
import { TestDatabases } from './TestDatabases';
import { parseMssqlConnectionString, startMssqlContainer } from './mssql';
import { isDockerDisabledForTests } from '../util/isDockerDisabledForTests';

jest.setTimeout(180_000);

describe('SQL Server test databases', () => {
  const databases = TestDatabases.create({ ids: ['MSSQL_2022'] });

  it('parses encoded connection details without exposing invalid credentials', () => {
    expect(
      parseMssqlConnectionString(
        'mssql://user%40example:pass%3Aword@localhost:1434/master?trustServerCertificate=true',
      ),
    ).toMatchObject({
      server: 'localhost',
      port: 1434,
      userName: 'user@example',
      password: 'pass:word',
      options: {
        encrypt: true,
        trustServerCertificate: true,
        lowerCaseGuids: true,
      },
    });
    expect(() =>
      parseMssqlConnectionString(
        'mssql://user:secret@localhost?encrypt=invalid',
      ),
    ).toThrow('Invalid SQL Server test connection string');
  });

  if (databases.supports('MSSQL_2022')) {
    it.each(databases.eachSupportedId())(
      'isolates schemas and returns canonical UUIDs, %p',
      async id => {
        const first = await databases.init(id);
        const second = await databases.init(id);
        for (const client of [first, second]) {
          await client.schema.createTable('records', table => {
            table.uuid('id').primary();
            table.string('value').notNullable();
          });
        }
        const uuid = randomUUID();
        await first('records').insert({
          id: uuid.toUpperCase(),
          value: 'first',
        });
        await second('records').insert({ id: uuid, value: 'second' });
        await expect(first('records')).resolves.toEqual([
          { id: uuid, value: 'first' },
        ]);
        await expect(second('records')).resolves.toEqual([
          { id: uuid, value: 'second' },
        ]);
      },
    );
  }

  const itWithDocker = isDockerDisabledForTests() ? it.skip : it;
  itWithDocker('starts and stops a SQL Server container', async () => {
    const { connection, stopContainer } = await startMssqlContainer(
      'mcr.microsoft.com/mssql/server:2022-latest',
    );
    const client = knexFactory({ client: 'mssql', connection });
    try {
      // eslint-disable-next-line jest/no-standalone-expect
      await expect(client.raw('SELECT 1 AS ready')).resolves.toEqual([
        { ready: 1 },
      ]);
    } finally {
      await client.destroy();
      await stopContainer();
    }
  });
});
