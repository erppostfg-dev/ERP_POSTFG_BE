import { ChannelName } from '../../../constants/channels';
import { bigbasketHandler } from './bigbasket/bigbasket.handler';
import { blinkitHandler } from './blinkit/blinkit.handler';
import { ChannelHandler } from './channel-handler';
import { firstcryHandler } from './firstcry/firstcry.handler';
import { nykaaHandler } from './nykaa/nykaa.handler';
import { purplleHandler } from './purplle/purplle.handler';
import { relianceHandler } from './reliance/reliance.handler';
import { scootsyHandler } from './scootsy/scootsy.handler';
import { tata1mgHandler } from './tata1mg/tata1mg.handler';
import { zeptoHandler } from './zepto/zepto.handler';

/**
 * Channel name -> that channel's route (its handler in channels/<channel>/).
 * A channel is added here once its mapping has been checked against its real OCR output.
 */
export const channelHandlers: Partial<Record<ChannelName, ChannelHandler>> = {
  [blinkitHandler.channel]: blinkitHandler,
  [zeptoHandler.channel]: zeptoHandler,
  [bigbasketHandler.channel]: bigbasketHandler,
  [firstcryHandler.channel]: firstcryHandler,
  [scootsyHandler.channel]: scootsyHandler,
  [purplleHandler.channel]: purplleHandler,
  [relianceHandler.channel]: relianceHandler,
  [tata1mgHandler.channel]: tata1mgHandler,
  [nykaaHandler.channel]: nykaaHandler,
};
