import { amazonConnector } from './amazon/amazon.connector';
import { ChannelConnector } from './connector';

/*
 * Every channel API connector (2026-10-16). Add a channel: write modules/channel-api/<channel>/<channel>.connector.ts
 * (a ChannelConnector), add its SOURCE_SYSTEM + constants, and list it here. Nothing else changes.
 */
export const CONNECTORS: readonly ChannelConnector[] = [amazonConnector];

export const connectorOf = (key: string): ChannelConnector | undefined => CONNECTORS.find((c) => c.key === key);
