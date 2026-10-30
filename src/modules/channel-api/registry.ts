import { amazonConnector } from './amazon/amazon.connector';
import { flipkartConnector } from './flipkart/flipkart.connector';
import { linkPos, recordInboundFailure, runInboundSync } from './amazon/inbound-sync.service';
import { INBOUND_EVENT_SOURCE } from '../../constants';
import { ChannelConnector } from './connector';

/*
 * Every channel API connector (2026-10-16). Add a channel: write modules/channel-api/<channel>/<channel>.connector.ts
 * (a ChannelConnector), add its SOURCE_SYSTEM + constants, and list it here. Nothing else changes.
 */
export const CONNECTORS: readonly ChannelConnector[] = [amazonConnector, flipkartConnector];

/**
 * Tracking that runs with a connector, before its PO pull (2026-10-19): Amazon inbound plans + shipments. `after` links
 * the POs the pull just made. A failed tracking run never stops the PO pull (and the other way round).
 */
export const TRACKERS: Record<string, { run: () => Promise<unknown>; after: () => Promise<unknown>; fail: (err: unknown) => Promise<void> }> = {
  [amazonConnector.key]: {
    run: () => runInboundSync({ apply: true, source: INBOUND_EVENT_SOURCE.POLL }),
    after: () => linkPos(),
    fail: recordInboundFailure,
  },
};

export const connectorOf = (key: string): ChannelConnector | undefined => CONNECTORS.find((c) => c.key === key);
