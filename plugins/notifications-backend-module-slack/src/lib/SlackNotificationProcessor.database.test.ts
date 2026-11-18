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

import { TestDatabases, mockServices } from '@backstage/backend-test-utils';
import { metricsServiceMock } from '@backstage/backend-test-utils/alpha';
import { ConfigReader } from '@backstage/config';
import { catalogServiceMock } from '@backstage/plugin-catalog-node/testUtils';
import { WebClient } from '@slack/web-api';
import path from 'node:path';
import { SlackNotificationProcessor } from './SlackNotificationProcessor';

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn(() => ({
    chat: {
      postMessage: jest.fn().mockResolvedValue({ ok: true, ts: '1000.000001' }),
      update: jest.fn().mockResolvedValue({ ok: true, ts: '1000.000001' }),
    },
  })),
}));

jest.setTimeout(120_000);

describe('Slack notification database storage', () => {
  const databases = TestDatabases.create({
    ids: ['POSTGRES_18', 'MSSQL_2022', 'SQLITE_3'],
  });
  it.each(databases.eachSupportedId())(
    'retains message timestamps across processor instances, %p',
    async id => {
      const db = await databases.init(id);
      await db.migrate.latest({
        directory: path.resolve(__dirname, '../../migrations'),
      });
      const channel = `U${'1'.repeat(63)}`;
      const origin = 'o'.repeat(256);
      const scope = 's'.repeat(512);
      const slack = new WebClient();
      const logger = mockServices.logger.mock();
      const createProcessor = () => {
        const processor = SlackNotificationProcessor.fromConfig(
          new ConfigReader({
            app: { baseUrl: 'http://localhost' },
            notifications: { processors: { slack: [{ token: 'test-token' }] } },
          }),
          {
            auth: mockServices.auth(),
            logger,
            metrics: metricsServiceMock.mock(),
            slack,
            catalog: catalogServiceMock({
              entities: [
                {
                  apiVersion: 'backstage.io/v1alpha1',
                  kind: 'User',
                  metadata: {
                    name: 'mock',
                    annotations: { 'slack.com/bot-notify': channel },
                  },
                },
              ],
            }),
          },
        )[0];
        processor.setDatabase(db);
        return processor;
      };
      const payload = { title: 'notification', scope };
      const notification = {
        id: 'notification-id',
        origin,
        user: 'user:default/mock',
        created: new Date(),
        payload,
      };
      const options = {
        recipients: { type: 'entity' as const, entityRef: 'user:default/mock' },
        payload,
      };
      await createProcessor().postProcess(notification, options);
      expect(
        await db('slack_message_timestamps').select(
          'origin',
          'scope',
          'channel',
          'ts',
        ),
      ).toEqual([{ origin, scope, channel, ts: '1000.000001' }]);
      await createProcessor().postProcess(
        { ...notification, updated: new Date() },
        options,
      );
      expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
      expect(slack.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({ channel, ts: '1000.000001' }),
      );
      expect(
        await db('slack_message_timestamps').count({ count: '*' }).first(),
      ).toEqual({ count: id.startsWith('POSTGRES') ? '1' : 1 });
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );
});
