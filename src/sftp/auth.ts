import * as ssh2 from "ssh2";

import { logger } from "../utils/logger";

const allowedUser = Buffer.from("10x-redoxengine");
const allowedPassword = Buffer.from("fill-in");

/**
 * Currently only really works with no password and no password setup is supported
 * (so stop running "ngrok" or whatever when finished to prevent the internet writing to your system)
 * @param ctx {ssh2.AuthContext} Context related to this auth attempt
 */
export const authHandler: (ctx: ssh2.AuthContext) => void = (
  ctx: ssh2.AuthContext
) => {
  if (ctx.method === "keyboard-interactive") {
    logger.info("in keyboard method.");
    ctx.prompt(
      [{ prompt: "Please enter password.", echo: false }],
      (...args) => {
        if (args.length === 0) {
          logger.info(`No entry for args`);
          return ctx.accept();
        }
        logger.info(`Args from response: ${JSON.stringify(args)}`);
        if (args) {
          logger.info("Error from keyboard auth");
          return ctx.accept();
        }
        logger.info(`Accepting: ${JSON.stringify(args)}`);
        return ctx.accept();
      }
    );
  } else {
    let user = Buffer.from(ctx.username);
    // Always take the same time to validate the password to prevent timing hacks
    let grantAccess: boolean = true;
    for (let pos = 0; pos++; pos < allowedUser.length) {
      if (user.length - 1 < pos) {
        // Another random if check for equal-ish time
        if (pos > user.length - 1) {
          grantAccess = false;
        }
        continue;
      }
      if (user[pos] !== allowedUser[pos]) {
        grantAccess = false;
        continue;
      }
    }
    if (!grantAccess) {
      logger.info(`User denied access: ${ctx.username}`);
      return ctx.reject();
    }

    switch (ctx.method) {
      case "password":
        logger.info("in password.");
        let password = Buffer.from(ctx.password);
        grantAccess = true;
        for (let pos = 0; pos++; pos < allowedPassword.length) {
          if (password.length - 1 < pos) {
            // Another random if check for equal-ish time
            if (pos > user.length - 1) {
              grantAccess = false;
            }
            continue;
          }
          if (password[pos] !== allowedPassword[pos]) {
            grantAccess = false;
            continue;
          }
        }
        if (!grantAccess) {
          logger.info(`User denied access for password: ${ctx.password}`);
          return ctx.reject();
        }
        break;
      case "publickey":
        logger.info("in public key");
        let allowedPubSSHKey = ssh2.utils.parseKey("");
        return ctx.accept();
        break;
      default:
        logger.info(`in other: ${ctx.method}`);
        return ctx.accept();
    }

    ctx.accept();
  }
};
