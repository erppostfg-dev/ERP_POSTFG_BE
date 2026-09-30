import { ChannelEmailFilter } from './channel-filter.types';
import { zeptoFilter } from './zepto.filter';

/** One filter per channel. Add a channel here once its filter is approved. */
export const channelFilters: Record<string, ChannelEmailFilter> = {
  zepto: zeptoFilter,
};
