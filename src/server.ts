import { SftpServer } from "./sftp";
import { sftpHostName, sftpPort } from "./config";
import { logger } from "./utils/logger";

new SftpServer().listen(sftpPort, sftpHostName, () => {
  logger.info(`SFTP server listening on port ${sftpPort}`);
});
