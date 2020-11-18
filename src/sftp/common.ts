import { logger } from "../utils/logger";

/**
 * Ironically enough, a handler to debug log that there is no handler attached to this event
 * @param handler {string} Name of the handler to document there is no other handler specified
 */
export const noHandler = (handler: string) => () => {
  logger.debug(
    `The ${handler} does not have an explicitly defined handler at this time, but was just called`
  );
};
