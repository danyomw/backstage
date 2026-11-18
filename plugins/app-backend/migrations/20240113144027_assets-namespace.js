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

// @ts-check

/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  const isMySQL = knex.client.config.client.includes('mysql');
  const isMssql = knex.client.config.client === 'mssql';

  await knex.schema.alterTable('static_assets_cache', table => {
    // The namespace is used to allow operations on asset groups, e.g. delete all assets in a namespace
    table
      .string('namespace')
      .defaultTo('default')
      .comment('The namespace of the file');

    if (!isMySQL && !isMssql) {
      table.dropPrimary();
      table.primary(['namespace', 'path']);
    }
  });

  if (isMySQL) {
    await knex.schema.raw(
      'drop index static_assets_cache_path_idx on static_assets_cache;',
    );
    await knex.schema.raw(
      'create unique index static_assets_cache_path_idx on static_assets_cache(namespace, path(254));',
    );
  }
  if (isMssql) {
    await knex('static_assets_cache')
      .whereNull('namespace')
      .update({ namespace: 'default' });
    await knex.raw(
      'DROP INDEX static_assets_cache_path_idx ON static_assets_cache',
    );
    await knex.raw(
      'CREATE UNIQUE INDEX static_assets_cache_path_idx ON static_assets_cache(namespace, path_hash)',
    );
  }
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  const isMySQL = knex.client.config.client.includes('mysql');
  const isMssql = knex.client.config.client === 'mssql';

  await knex
    .delete()
    .from('static_assets_cache')
    .whereNot('namespace', 'default');

  if (isMySQL) {
    await knex.schema.raw(
      'drop index static_assets_cache_path_idx on static_assets_cache;',
    );
  }
  if (isMssql) {
    await knex.raw(
      'DROP INDEX static_assets_cache_path_idx ON static_assets_cache',
    );
  }

  await knex.schema.alterTable('static_assets_cache', table => {
    if (!isMySQL && !isMssql) {
      table.dropPrimary();
    }

    table.dropColumn('namespace');

    if (!isMySQL && !isMssql) {
      table.primary(['path']);
    }
  });

  if (isMySQL) {
    await knex.schema.raw(
      'create unique index static_assets_cache_path_idx on static_assets_cache(path(254));',
    );
  }
  if (isMssql) {
    await knex.raw(
      'CREATE UNIQUE INDEX static_assets_cache_path_idx ON static_assets_cache(path_hash)',
    );
  }
};
