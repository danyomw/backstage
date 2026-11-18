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

import { randomUUID } from 'node:crypto';
import knexFactory, { Knex } from 'knex';
import { waitForReady } from '../util/waitForReady';
import { dropDatabases } from './dropDatabases';
import { Engine, TEST_POOL_CONFIG, TestDatabaseProperties } from './types';

export function parseMssqlConnectionString(
  connectionString: string,
): Knex.MsSqlConnectionConfig {
  try {
    const url = new URL(connectionString);
    if (
      url.protocol !== 'mssql:' ||
      !url.hostname ||
      !url.username ||
      !url.password
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
      database: 'master',
      options,
    };
  } catch {
    throw new Error('Invalid SQL Server test connection string');
  }
}

export async function startMssqlContainer(image: string): Promise<{
  connection: Knex.MsSqlConnectionConfig;
  stopContainer: () => Promise<void>;
}> {
  const { GenericContainer } =
    require('testcontainers') as typeof import('testcontainers');
  const password = `Backstage!${randomUUID()}`;
  const container = await new GenericContainer(image)
    .withExposedPorts(1433)
    .withEnvironment({ ACCEPT_EULA: 'Y', MSSQL_SA_PASSWORD: password })
    .withStartupTimeout(120_000)
    .start();
  const options = {
    encrypt: true,
    trustServerCertificate: true,
    lowerCaseGuids: true,
  };
  const connection: Knex.MsSqlConnectionConfig = {
    server: container.getHost(),
    port: container.getMappedPort(1433),
    userName: 'sa',
    password,
    database: 'master',
    options,
  };
  const stopContainer = async () => {
    await container.stop({ timeout: 10_000 });
  };
  const admin = knexFactory({
    client: 'mssql',
    connection: { ...connection, connectionTimeout: 5_000 },
    pool: { min: 0, max: 1 },
  });
  try {
    await waitForReady(
      async () => {
        const result = await admin.select(admin.raw('1 as ready'));
        return result[0]?.ready === 1;
      },
      'the SQL Server database',
      120_000,
    );
  } catch (error) {
    await stopContainer();
    throw error;
  } finally {
    await admin.destroy();
  }
  return { connection, stopContainer };
}

export class MssqlEngine implements Engine {
  static async create(
    properties: TestDatabaseProperties,
  ): Promise<MssqlEngine> {
    const { connectionStringEnvironmentVariableName, dockerImageName } =
      properties;
    const connectionString = connectionStringEnvironmentVariableName
      ? process.env[connectionStringEnvironmentVariableName]
      : undefined;
    if (connectionString) {
      return new MssqlEngine(
        properties,
        parseMssqlConnectionString(connectionString),
      );
    }
    if (dockerImageName) {
      const { connection, stopContainer } = await startMssqlContainer(
        dockerImageName,
      );
      return new MssqlEngine(properties, connection, stopContainer);
    }
    throw new Error(`Test database for ${properties.name} not configured`);
  }

  private readonly knexInstances: Knex[] = [];
  private readonly databaseNames: string[] = [];

  constructor(
    private readonly properties: TestDatabaseProperties,
    private readonly connection: Knex.MsSqlConnectionConfig,
    private readonly stopContainer?: () => Promise<void>,
  ) {}

  async createDatabaseInstance(): Promise<Knex> {
    const admin = this.connectAdmin();
    try {
      const databaseName = `db${randomUUID().replace(/-/g, '')}`;
      await admin.raw('CREATE DATABASE ?? COLLATE Latin1_General_100_BIN2', [
        databaseName,
      ]);
      this.databaseNames.push(databaseName);
      const instance = knexFactory({
        client: this.properties.driver,
        connection: { ...this.connection, database: databaseName },
        ...TEST_POOL_CONFIG,
      });
      this.knexInstances.push(instance);
      return instance;
    } finally {
      await admin.destroy();
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      this.knexInstances.map(instance => instance.destroy().catch(() => {})),
    );
    const admin = this.connectAdmin();
    try {
      await dropDatabases(admin, this.databaseNames);
    } finally {
      await admin.destroy().catch(() => {});
      await this.stopContainer?.();
    }
  }

  private connectAdmin(): Knex {
    return knexFactory({
      client: this.properties.driver,
      connection: { ...this.connection, database: 'master' },
      pool: { min: 0, max: 5 },
    });
  }
}
