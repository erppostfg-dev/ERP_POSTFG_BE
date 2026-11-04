import { ChannelName } from '../../../constants/channels';
import { avenueHandler } from './avenue/avenue.handler';
import { bigbasketHandler } from './bigbasket/bigbasket.handler';
import { blinkitHandler } from './blinkit/blinkit.handler';
import { ChannelHandler } from './channel-handler';
import { firstcryHandler } from './firstcry/firstcry.handler';
import { flipkartQcomHandler } from './flipkart-qcom/flipkart-qcom.handler';
import { gluzoHandler } from './gluzo/gluzo.handler';
import { slikkHandler } from './slikk/slikk.handler';
import { popTechHandler } from './pop-tech/pop-tech.handler';
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
  // Built from the PDF text of 4502349805 (2026-10-30), not yet from a real OCR output: check the first run.
  [avenueHandler.channel]: avenueHandler,
  // Line and footer names = the sheet's own (FASWN08497679); header labels come from the OCR's model: check the first run.
  [flipkartQcomHandler.channel]: flipkartQcomHandler,
  // Header names = the OCR's header_notes; line names = the PDF's (1974519, 2263773): check the first real run.
  [gluzoHandler.channel]: gluzoHandler,
  // Sheet lines checked on 5 POs; PDF-alone line names from the PDF (not yet a real OCR output): check the first run.
  [slikkHandler.channel]: slikkHandler,
  // Header names = the OCR's header_notes; line + total names = the PDF's (5 samples, 2 Nov): check the first real run.
  [popTechHandler.channel]: popTechHandler,
};
