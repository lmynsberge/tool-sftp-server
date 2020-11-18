import * as ssh2 from "ssh2";
import * as fs from "fs";
import * as path from "path";

import { logger } from "../utils/logger";
import { authHandler } from "./auth";
import { addSftpStreamHandlers } from "./sftp";
import { noHandler } from "./common";

const connectionHandler: (
  client: ssh2.Connection,
  info: ssh2.ClientInfo
) => void = (client: ssh2.Connection, info: ssh2.ClientInfo) => {
  logger.info("Client connected");
  logger.debug(`Client info: ${info.ip + " - " + JSON.stringify(info.header)}`);

  client.on("authentication", authHandler);
  client.on("ready", () => {
    logger.info(`${Date.now().toString()} client authenticated!`);

    client.on("session", (accept) => {
      var session = accept();
      session.on("sftp", (accept) => {
        logger.info("Client SFTP session started.");

        var handleCount = 0;
        // `sftpStream` is an `SFTPStream` instance in server mode
        // see: https://github.com/mscdex/ssh2-streams/blob/master/SFTPStream.md
        var sftpStream = accept();
        logger.info("waiting for request type.");
        addSftpStreamHandlers(sftpStream);
      });
    });
  });

  client.on("end", noHandler("ssh2:Connection.end"));
  client.on("session", noHandler("ssh2:Connection.session"));
  client.on("close", noHandler("ssh2:Connection.close"));
  client.on("continue", noHandler("ssh2:Connection.continue"));
  client.on("error", noHandler("ssh2:Connection.error"));
  client.on("request", noHandler("ssh2:Connection.request"));
  client.on(
    "openssh.streamlocal",
    noHandler("ssh2:Connection.openssh.streamlocal")
  );
  client.on("rekey", noHandler("ssh2:Connection.rekey"));
  client.on("tcpip", noHandler("ssh2:Connection.tcpip"));
};

export class SftpServer extends ssh2.Server {
  constructor() {
    super(
      {
        hostKeys: [
          {
            key: fs.readFileSync(path.join(__dirname, "..", "host.key")),
            passphrase: "password",
          },
        ],
      },
      connectionHandler
    );
  }
}
