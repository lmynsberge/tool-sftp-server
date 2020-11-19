import * as fs from "fs";
import { join } from "path";

import { logger } from "./utils/logger";

const numberFromEnvVar = (
  envVarName: string,
  defaultNumber?: number
): number => {
  const parsedValue = parseInt(process.env[envVarName] || "NaN", 10);
  const result = isNaN(parsedValue) ? defaultNumber : parsedValue;
  if (typeof result === "undefined") {
    throw new Error(
      `Required value not available for env var: [${envVarName}]`
    );
  }
  return result;
};

const stringFromEnvVar = (
  envVarName: string,
  defaultString?: string
): string => {
  const result = process.env[envVarName] || defaultString;
  if (typeof result === "undefined") {
    throw new Error(
      `Required value not available for env var: [${envVarName}]`
    );
  }
  return result;
};

export const sftpPort = numberFromEnvVar("SFTP_PORT", 5556);

export const sftpHostName = stringFromEnvVar("SFTP_HOSTNAME", "127.0.0.1");

export const sftpUsernames = (process.env.SFTP_USERNAMES || "").split(",");
export const sftpPasswords = (process.env.SFTP_PASSWORDS || "").split(",");

if (
  sftpUsernames.length < 1 ||
  sftpPasswords.length < 1 ||
  sftpUsernames.length === sftpPasswords.length
) {
  logger.info("No usernames or passwords specified or length does not match");
}

export const rootDir =
  process.env.SFTP_ROOT_DIR || join(__dirname, "..", "sftp-server-files");

if (!fs.existsSync(rootDir)) {
  throw new Error(
    `SFTP root dir does not exist, please create it or change the "SFTP_ROOT_DIR" variable. Looking at: [${rootDir}]`
  );
}
